package runner

import (
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yuktiops/agent/internal/client"
)

const (
	// A problem that keeps happening is reported again after this long, so the dashboard can
	// tell "still broken" from "happened once", without receiving it with every payload.
	resendAfter = time.Hour
	// Problems that have not occurred for this long are forgotten.
	forgetAfter   = 24 * time.Hour
	maxErrorCodes = 64
	maxPerPayload = 20 // the ingest schema allows at most 20 errors per request
	maxMessageLen = 300
	maxCodeLen    = 60
)

type errorEntry struct {
	message  string
	lastSeen time.Time
	lastSent time.Time
}

// errorRegistry de-duplicates the problems the agent reports. Collectors may report the same
// code every few seconds; it is sent once, and again only after resendAfter if it persists.
type errorRegistry struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]*errorEntry
}

func newErrorRegistry(now func() time.Time) *errorRegistry {
	return &errorRegistry{now: now, entries: map[string]*errorEntry{}}
}

// sanitizeCode forces a code into ^[a-z0-9_]{1,60}$, the only form the backend accepts.
func sanitizeCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(code) {
		if b.Len() >= maxCodeLen {
			break
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "agent_error"
	}
	return b.String()
}

func sanitizeMessage(message string) string {
	message = strings.ToValidUTF8(strings.TrimSpace(message), "?")
	if len(message) > maxMessageLen {
		message = strings.ToValidUTF8(message[:maxMessageLen], "")
	}
	return message
}

// Report records that a problem occurred. It is safe to call from any goroutine, as often as
// the problem happens.
func (e *errorRegistry) Report(code, message string) {
	code = sanitizeCode(code)
	e.mu.Lock()
	defer e.mu.Unlock()
	entry := e.entries[code]
	if entry == nil {
		if len(e.entries) >= maxErrorCodes {
			return
		}
		entry = &errorEntry{}
		e.entries[code] = entry
	}
	entry.message = sanitizeMessage(message)
	entry.lastSeen = e.now()
}

// Pending returns the problems that should go out with the next payload.
func (e *errorRegistry) Pending() []client.ErrorReport {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	out := []client.ErrorReport{}
	for code, entry := range e.entries {
		if now.Sub(entry.lastSeen) > forgetAfter {
			delete(e.entries, code)
			continue
		}
		neverSent := entry.lastSent.IsZero()
		stillHappening := entry.lastSeen.After(entry.lastSent) && now.Sub(entry.lastSent) >= resendAfter
		if neverSent || stillHappening {
			out = append(out, client.ErrorReport{Code: code, Message: entry.message})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	if len(out) > maxPerPayload {
		out = out[:maxPerPayload]
	}
	return out
}

// MarkSent records that the backend has received these reports.
func (e *errorRegistry) MarkSent(reports []client.ErrorReport) {
	if len(reports) == 0 {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	for _, r := range reports {
		if entry := e.entries[r.Code]; entry != nil {
			entry.lastSent = now
		}
	}
}
