package buffer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// clock is a hand-moved clock, so the 15-minute rule can be tested instantly.
type clock struct{ t time.Time }

func (c *clock) Now() time.Time          { return c.t }
func (c *clock) Advance(d time.Duration) { c.t = c.t.Add(d) }

func newClock() *clock { return &clock{t: time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)} }

func point(i int) []byte { return []byte(fmt.Sprintf(`{"time":"p%d","cpu":%d}`, i, i)) }

func open(t *testing.T, c *clock) (*Buffer, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "buffer.jsonl")
	return Open(path, DefaultMaxAge, c.Now), path
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func fileLines(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(data), "\n")
}

func TestHealthyPathWritesNothingToDisk(t *testing.T) {
	c := newClock()
	b, path := open(t, c)
	for i := 0; i < 5; i++ {
		b.Add(c.Now(), point(i))
		got := b.Peek(100, 1<<20)
		if len(got) != 1 {
			t.Fatalf("Peek returned %d entries", len(got))
		}
		b.Ack(got[len(got)-1].Seq)
		if err := b.Persist(); err != nil {
			t.Fatal(err)
		}
		c.Advance(30 * time.Second)
	}
	if b.Len() != 0 || exists(path) {
		t.Errorf("len=%d, file exists=%v; want an empty buffer and no file", b.Len(), exists(path))
	}
}

func TestFifteenMinuteCap(t *testing.T) {
	c := newClock()
	b, _ := open(t, c)
	// A 40-minute outage with one point every 30 seconds.
	for i := 0; i < 80; i++ {
		b.Add(c.Now(), point(i))
		if err := b.Persist(); err != nil {
			t.Fatal(err)
		}
		c.Advance(30 * time.Second)
	}
	// Points exactly 15 minutes old are still kept; anything older is gone.
	if got := b.Len(); got != 30 {
		t.Fatalf("after a long outage the buffer holds %d points, want 30 (15 minutes at 30s)", got)
	}
	oldest, ok := b.Oldest()
	if !ok || c.Now().Sub(oldest) > DefaultMaxAge {
		t.Errorf("oldest point is %v old, more than the 15-minute cap", c.Now().Sub(oldest))
	}
	entries := b.Peek(1000, 1<<30)
	if string(entries[0].Data) != string(point(50)) || string(entries[29].Data) != string(point(79)) {
		t.Errorf("wrong points kept: first %s last %s", entries[0].Data, entries[29].Data)
	}
	// With no new data everything eventually expires.
	c.Advance(16 * time.Minute)
	if got := b.Len(); got != 0 {
		t.Errorf("stale points were not dropped: %d left", got)
	}
}

func TestSurvivesRestartAndDropsExpiredOnLoad(t *testing.T) {
	c := newClock()
	b, path := open(t, c)
	for i := 0; i < 10; i++ {
		b.Add(c.Now(), point(i))
		c.Advance(time.Minute)
	}
	if err := b.Persist(); err != nil {
		t.Fatal(err)
	}

	// Restart straight away: all 10 points come back in order.
	again := Open(path, DefaultMaxAge, c.Now)
	got := again.Peek(100, 1<<20)
	if len(got) != 10 {
		t.Fatalf("reloaded %d points, want 10", len(got))
	}
	for i, e := range got {
		if string(e.Data) != string(point(i)) {
			t.Errorf("entry %d = %s", i, e.Data)
		}
	}

	// Restart after the machine was off for a while: points older than 15 minutes are dropped.
	c.Advance(8 * time.Minute) // point 0 is now 18 minutes old, point 3 is exactly 15
	later := Open(path, DefaultMaxAge, c.Now)
	got = later.Peek(100, 1<<20)
	if len(got) != 7 || string(got[0].Data) != string(point(3)) {
		t.Fatalf("after 8 more minutes: %d points starting at %s, want 7 starting at point 3", len(got), got[0].Data)
	}

	// Once delivered, the file goes away.
	later.Ack(got[len(got)-1].Seq)
	if err := later.Persist(); err != nil {
		t.Fatal(err)
	}
	if exists(path) {
		t.Error("the buffer file should be removed when everything has been sent")
	}
}

func TestPeekChunksAndAckBySequence(t *testing.T) {
	c := newClock()
	b, _ := open(t, c)
	for i := 0; i < 250; i++ {
		b.Add(c.Now(), point(i))
	}
	first := b.Peek(100, 1<<20)
	if len(first) != 100 {
		t.Fatalf("chunk = %d, want 100", len(first))
	}
	// New points arriving during the request must not be lost or acknowledged by mistake.
	b.Add(c.Now(), point(999))
	b.Ack(first[len(first)-1].Seq)
	if b.Len() != 151 {
		t.Fatalf("after ack: %d, want 151", b.Len())
	}
	next := b.Peek(100, 1<<20)
	if string(next[0].Data) != string(point(100)) {
		t.Errorf("next chunk starts at %s, want point 100", next[0].Data)
	}
	// A byte limit splits chunks too, but always returns at least one point.
	small := b.Peek(100, 60)
	if len(small) < 1 || len(small) > 3 {
		t.Errorf("byte-limited chunk = %d entries", len(small))
	}
	if one := b.Peek(100, 1); len(one) != 1 {
		t.Errorf("a tiny byte limit must still return one point, got %d", len(one))
	}
	// Acknowledging something that already expired or was acknowledged is harmless.
	b.Ack(first[0].Seq)
	if b.Len() != 151 {
		t.Errorf("stale ack removed data: %d", b.Len())
	}
}

func TestAckDuringOutageExpiryDoesNotDropUnsentPoints(t *testing.T) {
	c := newClock()
	b, _ := open(t, c)
	for i := 0; i < 4; i++ {
		b.Add(c.Now(), point(i))
		c.Advance(3 * time.Minute)
	}
	chunk := b.Peek(2, 1<<20) // points 0 and 1 are "in flight"
	if len(chunk) != 2 || string(chunk[0].Data) != string(point(0)) {
		t.Fatalf("unexpected chunk: %d entries", len(chunk))
	}
	c.Advance(4 * time.Minute)
	b.Add(c.Now(), point(4)) // point 0 (now 16 minutes old) expires while the request is running
	b.Ack(chunk[len(chunk)-1].Seq)
	left := b.Peek(100, 1<<20)
	if len(left) != 3 || string(left[0].Data) != string(point(2)) {
		t.Fatalf("left %d starting at %s; want points 2, 3, 4", len(left), left[0].Data)
	}
}

func TestFileIsCompactedAndTornLinesAreSkipped(t *testing.T) {
	c := newClock()
	b, path := open(t, c)
	// A long outage: the file must not grow forever.
	for i := 0; i < 400; i++ {
		b.Add(c.Now(), point(i))
		if err := b.Persist(); err != nil {
			t.Fatal(err)
		}
		c.Advance(30 * time.Second)
	}
	if lines := fileLines(t, path); lines > 2*30+1 {
		t.Errorf("file has %d lines for 30 live points: compaction is not working", lines)
	}
	// Simulate a crash in the middle of a write, plus some garbage.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o640)
	f.WriteString("not json at all\n{\"t\":\"2026-11-14T10:00:00Z\",\"p\":{\"cpu\":1")
	f.Close()
	again := Open(path, DefaultMaxAge, c.Now)
	if got := again.Len(); got != 29 && got != 30 {
		t.Fatalf("reloaded %d points from a damaged file, want the 29-30 intact ones", got)
	}
	// Adding after a damaged load must produce a clean file again.
	again.Add(c.Now(), point(1000))
	if err := again.Persist(); err != nil {
		t.Fatal(err)
	}
	final := Open(path, DefaultMaxAge, c.Now)
	entries := final.Peek(1000, 1<<30)
	if len(entries) == 0 || string(entries[len(entries)-1].Data) != string(point(1000)) {
		t.Errorf("the point added after recovery was lost (%d entries)", len(entries))
	}
}

func TestHardLimits(t *testing.T) {
	c := newClock()
	b, _ := open(t, c)
	for i := 0; i < maxEntries+50; i++ {
		b.Add(c.Now(), point(i))
	}
	if b.Len() != maxEntries {
		t.Errorf("len = %d, want the %d-entry cap", b.Len(), maxEntries)
	}
	// A missing directory must not crash anything: persisting just reports the error.
	bad := Open(filepath.Join(t.TempDir(), "missing", "buffer.jsonl"), DefaultMaxAge, c.Now)
	bad.Add(c.Now(), point(1))
	if err := bad.Persist(); err == nil {
		t.Error("Persist into a missing directory should return an error")
	}
	if bad.Len() != 1 {
		t.Error("a failed Persist must keep the data in memory")
	}
}
