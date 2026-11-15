// Package buffer keeps unsent data points for up to 15 minutes, in memory and (while there is a
// backlog) on disk, so they survive a backend outage and a restart of the agent.
//
// While everything is healthy a point is added, sent and acknowledged within the same second and
// nothing is written to disk. Only when a send fails does Persist append the backlog to a JSON
// lines file; it is rewritten when it has collected enough dead lines and removed once empty.
package buffer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"
)

const (
	// DefaultMaxAge is how long an unsent point is kept. The backend accepts points up to
	// 30 minutes old, so everything in the buffer can always still be delivered.
	DefaultMaxAge = 15 * time.Minute
	// maxEntries and maxBytes bound memory and disk use whatever the intervals are.
	maxEntries = 256
	maxBytes   = 4 << 20
	// maxFileBytes guards against loading a damaged or foreign file.
	maxFileBytes = 16 << 20
	maxLineBytes = 1 << 20
)

// Entry is one data point waiting to be sent. Data is the point's JSON, ready for the payload.
type Entry struct {
	Seq  uint64
	Time time.Time
	Data json.RawMessage
}

type line struct {
	T time.Time       `json:"t"`
	P json.RawMessage `json:"p"`
}

// Buffer is safe for use by the sampling and sending goroutines at the same time.
type Buffer struct {
	mu      sync.Mutex
	path    string
	maxAge  time.Duration
	now     func() time.Time
	entries []Entry
	bytes   int
	nextSeq uint64

	// Disk bookkeeping. The file holds dead lines (already sent or expired) followed by the first
	// `persisted` entries; the rest of the entries are only in memory until the next Persist.
	fileExists bool
	persisted  int
	deadLines  int
	// damaged means the file may contain a torn or unreadable line, so it must be rewritten
	// rather than appended to.
	damaged bool
}

// Open loads whatever an earlier run left on disk, dropping points older than maxAge. A missing
// or damaged file is not an error: the agent simply starts with an empty buffer.
func Open(path string, maxAge time.Duration, now func() time.Time) *Buffer {
	if now == nil {
		now = time.Now
	}
	if maxAge <= 0 {
		maxAge = DefaultMaxAge
	}
	b := &Buffer{path: path, maxAge: maxAge, now: now, nextSeq: 1}
	b.load()
	return b
}

func (b *Buffer) load() {
	info, err := os.Stat(b.path)
	if err != nil {
		return
	}
	b.fileExists = true
	if info.Size() > maxFileBytes {
		b.removeFile()
		return
	}
	f, err := os.Open(b.path)
	if err != nil {
		return
	}
	defer f.Close()
	cutoff := b.now().Add(-b.maxAge)
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), maxLineBytes)
	lines := 0
	for scanner.Scan() {
		lines++
		var l line
		// A torn last line (power loss mid-write) or any other damage is skipped.
		if json.Unmarshal(scanner.Bytes(), &l) != nil || l.T.IsZero() || len(l.P) == 0 {
			b.damaged = true
			continue
		}
		if l.T.Before(cutoff) {
			continue
		}
		b.append(l.T, bytes.Clone(l.P))
	}
	if scanner.Err() != nil {
		b.damaged = true
	}
	b.enforceLimits()
	// Everything that survived is on disk already; anything else in the file is dead weight.
	b.persisted = len(b.entries)
	b.deadLines = lines - len(b.entries)
}

func (b *Buffer) append(t time.Time, data []byte) {
	b.entries = append(b.entries, Entry{Seq: b.nextSeq, Time: t, Data: data})
	b.nextSeq++
	b.bytes += len(data)
}

// dropFront removes the n oldest entries, keeping the disk bookkeeping in step.
func (b *Buffer) dropFront(n int) {
	if n <= 0 {
		return
	}
	if n > len(b.entries) {
		n = len(b.entries)
	}
	for _, e := range b.entries[:n] {
		b.bytes -= len(e.Data)
	}
	onDisk := min(n, b.persisted)
	b.persisted -= onDisk
	b.deadLines += onDisk
	// Copy down instead of re-slicing so the backing array does not grow without bound.
	remaining := copy(b.entries, b.entries[n:])
	clear(b.entries[remaining:])
	b.entries = b.entries[:remaining]
}

func (b *Buffer) enforceLimits() {
	cutoff := b.now().Add(-b.maxAge)
	n := 0
	for n < len(b.entries) && b.entries[n].Time.Before(cutoff) {
		n++
	}
	b.dropFront(n)
	for len(b.entries) > maxEntries || (b.bytes > maxBytes && len(b.entries) > 1) {
		b.dropFront(1)
	}
}

// Add queues a data point taken at time t. Points older than the maximum age are dropped.
func (b *Buffer) Add(t time.Time, data []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.append(t, data)
	b.enforceLimits()
}

// Len returns how many points are waiting.
func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.enforceLimits()
	return len(b.entries)
}

// Oldest returns the time of the oldest waiting point.
func (b *Buffer) Oldest() (time.Time, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.entries) == 0 {
		return time.Time{}, false
	}
	return b.entries[0].Time, true
}

// Peek returns the oldest points, at most maxCount of them and at most maxSize bytes of JSON
// (always at least one). The points stay in the buffer until Ack is called with the last Seq.
func (b *Buffer) Peek(maxCount, maxSize int) []Entry {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.enforceLimits()
	size := 0
	n := 0
	for n < len(b.entries) && n < maxCount {
		size += len(b.entries[n].Data)
		if n > 0 && size > maxSize {
			break
		}
		n++
	}
	return append([]Entry(nil), b.entries[:n]...)
}

// Ack removes every point up to and including seq: the backend has stored them.
func (b *Buffer) Ack(seq uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for n < len(b.entries) && b.entries[n].Seq <= seq {
		n++
	}
	b.dropFront(n)
}

// Persist brings the file in line with memory. It is cheap when there is nothing to do, so it
// can be called after every send attempt and on shutdown.
func (b *Buffer) Persist() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.enforceLimits()
	if len(b.entries) == 0 {
		if b.fileExists {
			return b.removeFile()
		}
		return nil
	}
	if b.damaged || (b.deadLines > 0 && (b.deadLines >= len(b.entries) || b.deadLines >= 64)) {
		return b.rewrite()
	}
	if b.persisted == len(b.entries) {
		return nil
	}
	f, err := os.OpenFile(b.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o640)
	if err != nil {
		return err
	}
	b.fileExists = true
	if err := writeLines(f, b.entries[b.persisted:]); err != nil {
		f.Close()
		// The file may now end in a partial line; write it afresh next time.
		b.damaged = true
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	b.persisted = len(b.entries)
	return nil
}

func (b *Buffer) rewrite() error {
	tmp := b.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o640)
	if err != nil {
		return err
	}
	if err := writeLines(f, b.entries); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, b.path); err != nil {
		os.Remove(tmp)
		return err
	}
	b.fileExists = true
	b.persisted = len(b.entries)
	b.deadLines = 0
	b.damaged = false
	return nil
}

func writeLines(f *os.File, entries []Entry) error {
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	for _, e := range entries {
		if err := enc.Encode(line{T: e.Time, P: e.Data}); err != nil {
			return err
		}
	}
	if err := w.Flush(); err != nil {
		return err
	}
	// The backlog exists precisely because something is wrong; make sure it survives a reboot.
	return f.Sync()
}

func (b *Buffer) removeFile() error {
	err := os.Remove(b.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	b.fileExists = false
	b.persisted = 0
	b.deadLines = 0
	b.damaged = false
	return nil
}
