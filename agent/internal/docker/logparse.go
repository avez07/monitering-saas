package docker

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// MaxLineBytes caps one log line; the rest of a longer line is dropped.
	MaxLineBytes = 16 << 10
	// maxFrame guards against a corrupt stream header.
	maxFrame = 1 << 20
)

// Stream names as sent in the log.iostream attribute.
const (
	Stdout = "stdout"
	Stderr = "stderr"
)

// lineSplitter collects bytes of one stream into lines of at most MaxLineBytes.
type lineSplitter struct {
	stream  string
	buf     []byte
	discard bool // inside the dropped tail of an over-long line
	emit    func(stream string, line []byte)
}

func (s *lineSplitter) write(p []byte) {
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		chunk := p
		if i >= 0 {
			chunk = p[:i]
		}
		if !s.discard {
			room := MaxLineBytes - len(s.buf)
			if len(chunk) > room {
				s.buf = append(s.buf, chunk[:room]...)
				s.flush()
				s.discard = true
			} else {
				s.buf = append(s.buf, chunk...)
			}
		}
		if i < 0 {
			return
		}
		if !s.discard {
			s.flush()
		}
		s.discard = false
		p = p[i+1:]
	}
}

func (s *lineSplitter) flush() {
	line := bytes.TrimRight(s.buf, "\r")
	if len(line) > 0 {
		s.emit(s.stream, line)
	}
	s.buf = s.buf[:0]
}

// Demux reads a container log stream and calls emit for every complete line. Without a TTY the
// stream is multiplexed: each frame has an 8-byte header (stream type, 3 zero bytes, big-endian
// payload length). With a TTY it is the raw output, all reported as stdout. A partial last line
// is emitted when the stream ends.
func Demux(r io.Reader, tty bool, emit func(stream string, line []byte)) error {
	out := &lineSplitter{stream: Stdout, emit: emit}
	errs := &lineSplitter{stream: Stderr, emit: emit}
	defer func() {
		out.flush()
		errs.flush()
	}()
	if tty {
		buf := make([]byte, 32<<10)
		for {
			n, err := r.Read(buf)
			out.write(buf[:n])
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return err
			}
		}
	}
	br := bufio.NewReaderSize(r, 32<<10)
	header := make([]byte, 8)
	payload := make([]byte, 0, 32<<10)
	for {
		if _, err := io.ReadFull(br, header); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return nil
			}
			return err
		}
		size := binary.BigEndian.Uint32(header[4:])
		if header[0] > 2 || header[1] != 0 || header[2] != 0 || header[3] != 0 || size > maxFrame {
			return errors.New("the log stream is not in the expected format")
		}
		if cap(payload) < int(size) {
			payload = make([]byte, size)
		}
		payload = payload[:size]
		if _, err := io.ReadFull(br, payload); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return nil
			}
			return err
		}
		if header[0] == 2 {
			errs.write(payload)
		} else {
			out.write(payload)
		}
	}
}

// ParseLine splits "2026-11-22T10:00:00.123456789Z message" (timestamps=1) into its parts. A line
// without a valid timestamp gets the zero time and is returned whole.
func ParseLine(line []byte) (time.Time, string) {
	if i := bytes.IndexByte(line, ' '); i > 0 && i <= 40 {
		if t, err := time.Parse(time.RFC3339Nano, string(line[:i])); err == nil {
			return t, string(line[i+1:])
		}
	}
	if len(line) >= 20 && len(line) <= 40 && line[len(line)-1] == 'Z' {
		if t, err := time.Parse(time.RFC3339Nano, string(line)); err == nil {
			return t, "" // an empty line with only its timestamp
		}
	}
	return time.Time{}, string(line)
}

// ---- severity ---------------------------------------------------------------------------------

var (
	kvLevelRe = regexp.MustCompile(`(?i)\b(?:level|lvl|severity|loglevel)\s*[=:]\s*"?([a-z]+)`)
	wordRe    = regexp.MustCompile(`\b(FATAL|PANIC|CRITICAL|CRIT|EMERG|ALERT|SEVERE|ERROR|ERR|WARNING|WARN|INFO|NOTICE|DEBUG|TRACE)\b|\[(?i:(fatal|panic|crit|critical|emerg|alert|error|err|warn|warning|notice|info|debug|trace))\]`)
	lowerRe   = regexp.MustCompile(`(?i)\b(exception|traceback|panic:|error:|fatal:|failed:)|\b(warning:|warn:)`)
	jsonKeys  = []string{"level", "severity", "lvl", "log.level", "levelname", "loglevel", "@l"}
)

// normalizeLevel maps a level word to ERROR, WARN, INFO, DEBUG or "".
func normalizeLevel(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "fatal", "panic", "crit", "critical", "emerg", "emergency", "alert", "severe", "error", "err", "e", "f":
		return "ERROR"
	case "warn", "warning", "w":
		return "WARN"
	case "info", "information", "informational", "notice", "i":
		return "INFO"
	case "debug", "trace", "verbose", "d", "t":
		return "DEBUG"
	}
	return ""
}

// GuessSeverity guesses the level of a log line from common formats: JSON ("level"), logfmt
// (level=), bracketed or upper-case words. It returns ERROR, WARN, INFO, DEBUG or "".
func GuessSeverity(msg string) string {
	trimmed := strings.TrimSpace(msg)
	if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
		var doc map[string]any
		if json.Unmarshal([]byte(trimmed), &doc) == nil {
			for _, k := range jsonKeys {
				switch v := doc[k].(type) {
				case string:
					if l := normalizeLevel(v); l != "" {
						return l
					}
				case float64: // pino / bunyan numeric levels
					switch {
					case v >= 50:
						return "ERROR"
					case v >= 40:
						return "WARN"
					case v >= 30:
						return "INFO"
					case v > 0:
						return "DEBUG"
					}
				}
			}
		}
	}
	if m := kvLevelRe.FindStringSubmatch(msg); m != nil {
		if l := normalizeLevel(m[1]); l != "" {
			return l
		}
	}
	if m := wordRe.FindStringSubmatch(msg); m != nil {
		word := m[1]
		if word == "" {
			word = m[2]
		}
		if l := normalizeLevel(word); l != "" {
			return l
		}
	}
	if m := lowerRe.FindStringSubmatch(msg); m != nil {
		if m[1] != "" {
			return "ERROR"
		}
		return "WARN"
	}
	return ""
}

// SeverityNumber is the OTLP severity number of a level text.
func SeverityNumber(level string) int {
	switch level {
	case "DEBUG":
		return 5
	case "INFO":
		return 9
	case "WARN":
		return 13
	case "ERROR":
		return 17
	}
	return 0
}

// ---- checkpoints ------------------------------------------------------------------------------

// checkpointMaxAge forgets containers that have not logged anything for a week.
const checkpointMaxAge = 7 * 24 * time.Hour

// Checkpoints remember, per container id, the timestamp of the last log line delivered, so a
// restarted agent continues where it stopped instead of sending lines twice.
type Checkpoints struct {
	mu    sync.Mutex
	path  string
	last  map[string]time.Time
	dirty bool
}

type checkpointFile struct {
	Containers map[string]string `json:"containers"`
}

// LoadCheckpoints reads the checkpoint file (a missing or damaged file means "no checkpoints").
func LoadCheckpoints(path string, now time.Time) *Checkpoints {
	cp := &Checkpoints{path: path, last: map[string]time.Time{}}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 4<<20 {
		return cp
	}
	var f checkpointFile
	if json.Unmarshal(data, &f) != nil {
		return cp
	}
	for id, ts := range f.Containers {
		if t, err := time.Parse(time.RFC3339Nano, ts); err == nil && validID(id) && now.Sub(t) < checkpointMaxAge {
			cp.last[id] = t
		}
	}
	return cp
}

// Get returns the checkpoint of a container (zero when there is none).
func (c *Checkpoints) Get(id string) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last[id]
}

// Advance moves a container's checkpoint forward (never backwards).
func (c *Checkpoints) Advance(id string, t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if t.After(c.last[id]) {
		c.last[id] = t
		c.dirty = true
	}
}

// Save writes the file when something changed.
func (c *Checkpoints) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.dirty || c.path == "" {
		return nil
	}
	f := checkpointFile{Containers: make(map[string]string, len(c.last))}
	for id, t := range c.last {
		f.Containers[id] = t.UTC().Format(time.RFC3339Nano)
	}
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.path); err != nil {
		os.Remove(tmp)
		return err
	}
	c.dirty = false
	return nil
}

var idRe = regexp.MustCompile(`^[a-f0-9]{12,64}$`)

func validID(id string) bool { return idRe.MatchString(id) }

// sinceParam formats a time for the logs endpoint's since parameter ("seconds.nanoseconds").
func sinceParam(t time.Time) string {
	return strconv.FormatInt(t.Unix(), 10) + "." + fmt.Sprintf("%09d", t.Nanosecond())
}

// ---- OTLP/HTTP JSON ---------------------------------------------------------------------------

type otlpValue struct {
	StringValue string `json:"stringValue"`
}

type otlpKV struct {
	Key   string    `json:"key"`
	Value otlpValue `json:"value"`
}

type otlpRecord struct {
	TimeUnixNano         string    `json:"timeUnixNano"`
	ObservedTimeUnixNano string    `json:"observedTimeUnixNano"`
	SeverityNumber       int       `json:"severityNumber,omitempty"`
	SeverityText         string    `json:"severityText,omitempty"`
	Body                 otlpValue `json:"body"`
	Attributes           []otlpKV  `json:"attributes"`
}

type otlpScopeLogs struct {
	Scope struct {
		Name    string `json:"name"`
		Version string `json:"version,omitempty"`
	} `json:"scope"`
	LogRecords []otlpRecord `json:"logRecords"`
}

type otlpResourceLogs struct {
	Resource struct {
		Attributes []otlpKV `json:"attributes"`
	} `json:"resource"`
	ScopeLogs []otlpScopeLogs `json:"scopeLogs"`
}

type otlpLogs struct {
	ResourceLogs []otlpResourceLogs `json:"resourceLogs"`
}

func kv(k, v string) otlpKV { return otlpKV{Key: k, Value: otlpValue{StringValue: v}} }
