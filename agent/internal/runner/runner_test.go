package runner

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/yuktiops/agent/internal/backoff"
	"github.com/yuktiops/agent/internal/client"
	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/state"
)

// TestBackfillAfterOutage runs the real sampler and sender against a fake API that goes away for a
// while. Every data point taken during the outage must arrive afterwards, in the same order.
func TestBackfillAfterOutage(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the collectors read /proc")
	}
	var mu sync.Mutex
	var down bool
	var times []string
	var errorsSeen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if down {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		var body io.Reader = r.Body
		if r.Header.Get("Content-Encoding") == "gzip" {
			gz, err := gzip.NewReader(r.Body)
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			body = gz
		}
		var req struct {
			Samples []struct {
				Time string `json:"time"`
			} `json:"samples"`
			Errors []struct{ Code string } `json:"errors"`
		}
		if err := json.NewDecoder(body).Decode(&req); err != nil || len(req.Samples) == 0 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		for _, s := range req.Samples {
			times = append(times, s.Time)
		}
		for _, e := range req.Errors {
			errorsSeen = append(errorsSeen, e.Code)
		}
		json.NewEncoder(w).Encode(map[string]any{"accepted": len(req.Samples), "dropped": 0,
			"config": map[string]any{"id": "", "version": 0}, "serverTime": time.Now().UTC().Format(time.RFC3339Nano)})
	}))
	defer srv.Close()

	dir := t.TempDir()
	paths := config.Paths{ConfigDir: filepath.Join(dir, "etc"), StateDir: filepath.Join(dir, "var")}
	os.MkdirAll(paths.ConfigDir, 0o755)
	os.WriteFile(paths.ConfigFile(), config.File{APIURL: srv.URL, Name: "t"}.Render(), 0o644)
	os.WriteFile(paths.CredentialFile(), []byte("agent_x\n"), 0o600)

	r, err := newRunner(Options{Paths: paths, Version: "test", Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	// Run 100 times faster: a 30 second send interval becomes 300 ms.
	r.seconds = func(n int) time.Duration { return time.Duration(n) * 10 * time.Millisecond }
	r.firstSample = 20 * time.Millisecond
	r.netBackoff = backoff.Policy{Base: 40 * time.Millisecond, Max: 200 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.run(ctx) }()

	count := func() int { mu.Lock(); defer mu.Unlock(); return len(times) }
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitFor("data while the API is up", func() bool { return count() >= 2 })

	mu.Lock()
	down = true
	downSince := time.Now()
	before := len(times)
	mu.Unlock()
	time.Sleep(2500 * time.Millisecond) // about 8 data points are produced during the outage
	mu.Lock()
	if len(times) != before {
		t.Errorf("data arrived while the API was down")
	}
	down = false
	mu.Unlock()
	downUntil := time.Now()

	waitFor("the back-fill", func() bool {
		mu.Lock()
		defer mu.Unlock()
		inGap := 0
		for _, s := range times {
			if ts, err := time.Parse(time.RFC3339Nano, s); err == nil && ts.After(downSince) && ts.Before(downUntil) {
				inGap++
			}
		}
		return inGap >= 6
	})
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	seen := map[string]bool{}
	for i, s := range times {
		if seen[s] {
			t.Errorf("point %s was delivered twice", s)
		}
		seen[s] = true
		if i > 0 && s < times[i-1] {
			t.Errorf("points arrived out of order: %s after %s", s, times[i-1])
		}
	}
	st, err := state.Load(paths.StateFile())
	if err != nil || st.Connection != state.Stopped {
		t.Errorf("final state = %+v, %v", st, err)
	}
	if st.Buffered != 0 {
		t.Logf("still buffered at shutdown: %d (kept on disk for the next start)", st.Buffered)
	}
}

func TestRetryAfterDelayCappedWithJitter(t *testing.T) {
	if d := retryAfterDelay(30*time.Second, func() float64 { return 0 }); d != 30*time.Second {
		t.Errorf("no jitter: got %s", d)
	}
	if d := retryAfterDelay(30*time.Second, func() float64 { return 0.5 }); d != 33*time.Second {
		t.Errorf("jitter: got %s", d)
	}
	if d := retryAfterDelay(time.Hour, func() float64 { return 0.9 }); d != maxRetryAfter {
		t.Errorf("cap: got %s", d)
	}
}

func TestOnFailure503HonoursRetryAfterAndKeepsCredential(t *testing.T) {
	dir := t.TempDir()
	paths := config.Paths{ConfigDir: filepath.Join(dir, "etc"), StateDir: filepath.Join(dir, "var")}
	os.MkdirAll(paths.ConfigDir, 0o755)
	os.WriteFile(paths.ConfigFile(), config.File{APIURL: "http://127.0.0.1:1", Name: "t"}.Render(), 0o644)
	os.WriteFile(paths.CredentialFile(), []byte("agent_x\n"), 0o600)
	r, err := newRunner(Options{Paths: paths, Version: "test", Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	r.netBackoff = backoff.Policy{Base: time.Second, Max: 2 * time.Second, Rand: func() float64 { return 0.5 }}
	r.now = func() time.Time { return time.Unix(1_000_000, 0) }
	retry := r.onFailure(&client.APIError{Status: 503, RetryAfter: 60 * time.Second}, 5, 5, nil)
	if retry {
		t.Error("503 must not trigger an immediate retry")
	}
	if wait := r.notBefore.Sub(r.now()); wait < 60*time.Second || wait > 72*time.Second {
		t.Errorf("wait %s, want 60-72s", wait)
	}
	if r.st.Connection != state.Retrying {
		t.Errorf("connection = %v, want retrying", r.st.Connection)
	}
	if r.authFailures != 0 {
		t.Error("503 counted as an auth failure")
	}
	r.onFailure(&client.APIError{Status: 503, RetryAfter: time.Hour}, 5, 5, nil)
	if wait := r.notBefore.Sub(r.now()); wait > maxRetryAfter {
		t.Errorf("wait %s exceeds cap", wait)
	}
}
