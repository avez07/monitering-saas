package runner

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yuktiops/agent/internal/client"
	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/prom"
	"github.com/yuktiops/agent/internal/remote"
)

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *syncBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// fakeCollector records starts and stops of a background collector.
type fakeCollector struct {
	mu      sync.Mutex
	running int
	starts  int
	configs []remote.Config
	result  error // returned at once instead of blocking (simulates a 402)
}

func (f *fakeCollector) run(ctx context.Context, cfg *remote.Config) error {
	f.mu.Lock()
	f.starts++
	f.configs = append(f.configs, *cfg)
	if f.result != nil {
		err := f.result
		f.mu.Unlock()
		return err
	}
	f.running++
	f.mu.Unlock()
	<-ctx.Done()
	f.mu.Lock()
	f.running--
	f.mu.Unlock()
	return nil
}

func (f *fakeCollector) state() (running, starts int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.running, f.starts
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestAdvancedCollectorsHotToggle changes the plan-driven settings through the real settings
// download and checks that the collectors start and stop without a restart.
func TestAdvancedCollectorsHotToggle(t *testing.T) {
	var mu sync.Mutex
	doc := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path != "/v1/config" || r.Header.Get("Authorization") != "Bearer agent_x" {
			w.WriteHeader(404)
			return
		}
		io.WriteString(w, doc)
	}))
	defer srv.Close()
	setDoc := func(version int, settings string) {
		mu.Lock()
		doc = `{"id":"st_0123456789abcdef01234567","version":` + itoa(version) + `,"plan":{"name":"Pro"},"settings":` + settings + `}`
		mu.Unlock()
	}

	dir := t.TempDir()
	paths := config.Paths{ConfigDir: filepath.Join(dir, "etc"), StateDir: filepath.Join(dir, "var")}
	os.MkdirAll(paths.ConfigDir, 0o755)
	os.MkdirAll(paths.StateDir, 0o755)
	os.WriteFile(paths.ConfigFile(), config.File{APIURL: srv.URL, Name: "t", AgentID: "agt_1"}.Render(), 0o644)
	os.WriteFile(paths.CredentialFile(), []byte("agent_x\n"), 0o600)
	logs := &syncBuffer{}
	r, err := newRunner(Options{Paths: paths, Version: "test", Logger: log.New(logs, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	r.errs = newErrorRegistry(r.now)
	r.promSupported = true
	metrics, tail := &fakeCollector{}, &fakeCollector{}
	r.runProm, r.runLogs = metrics.run, tail.run
	start := remote.Config{ID: "st_0123456789abcdef01234567", Version: 1, Settings: remote.DefaultSettings()}
	r.settings.Store(&start)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); r.advancedLoop(ctx) }()
	pull := func(version int) {
		r.pullConfigIfChanged(ctx, &client.IngestResponse{ConfigVersion: version})
	}

	// Upgrade: prometheus on, container logs on.
	setDoc(2, `{"collectors":{"prometheus":true,"containerLogs":{"enabled":true}},"prometheus":{"scrapeIntervalSeconds":30}}`)
	pull(2)
	waitUntil(t, "collectors on", func() bool {
		m, _ := metrics.state()
		l, _ := tail.state()
		return m == 1 && l == 1
	})
	waitUntil(t, "log line", func() bool { return strings.Contains(logs.String(), "Advanced metrics on (plan Pro)") })
	if !strings.Contains(logs.String(), "Container logs on (all running containers)") {
		t.Errorf("log: %s", logs.String())
	}
	if metrics.configs[0].Settings.Prometheus.ScrapeIntervalSeconds != 30 {
		t.Errorf("collector got %+v", metrics.configs[0].Settings.Prometheus)
	}

	// A change of include list restarts only the log tailer.
	setDoc(3, `{"collectors":{"prometheus":true,"containerLogs":{"enabled":true,"include":["web"]}},"prometheus":{"scrapeIntervalSeconds":30}}`)
	pull(3)
	waitUntil(t, "logs restarted", func() bool { l, s := tail.state(); return l == 1 && s == 2 })
	if _, s := metrics.state(); s != 1 {
		t.Errorf("metrics restarted needlessly (%d starts)", s)
	}

	// Downgrade: both off, without a restart of the agent.
	setDoc(4, `{"collectors":{"prometheus":false}}`)
	pull(4)
	waitUntil(t, "collectors off", func() bool {
		m, _ := metrics.state()
		l, _ := tail.state()
		return m == 0 && l == 0
	})
	waitUntil(t, "off log", func() bool {
		return strings.Contains(logs.String(), "Advanced metrics off") && strings.Contains(logs.String(), "Container logs off")
	})

	// 402 from the API: the collector stays off until the settings version changes.
	metrics.mu.Lock()
	metrics.result = prom.ErrNotEntitled
	metrics.mu.Unlock()
	setDoc(5, `{"collectors":{"prometheus":true}}`)
	pull(5)
	waitUntil(t, "402 handled", func() bool { return strings.Contains(logs.String(), "plan does not include them") })
	r.wakeAdvanced()
	time.Sleep(50 * time.Millisecond)
	if _, s := metrics.state(); s != 2 {
		t.Errorf("collector retried after 402 for the same settings: %d starts", s)
	}
	metrics.mu.Lock()
	metrics.result = nil
	metrics.mu.Unlock()
	setDoc(6, `{"collectors":{"prometheus":true}}`)
	pull(6)
	waitUntil(t, "on again with new settings", func() bool { m, _ := metrics.state(); return m == 1 })

	cancel()
	<-done
	if m, _ := metrics.state(); m != 0 {
		t.Error("collector still running after shutdown")
	}
}

func TestAdvancedMetricsNeedLinux(t *testing.T) {
	dir := t.TempDir()
	paths := config.Paths{ConfigDir: filepath.Join(dir, "etc"), StateDir: filepath.Join(dir, "var")}
	os.MkdirAll(paths.ConfigDir, 0o755)
	os.WriteFile(paths.ConfigFile(), config.File{APIURL: "http://127.0.0.1:1", Name: "t"}.Render(), 0o644)
	os.WriteFile(paths.CredentialFile(), []byte("agent_x\n"), 0o600)
	logs := &syncBuffer{}
	r, err := newRunner(Options{Paths: paths, Version: "test", Logger: log.New(logs, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	r.errs = newErrorRegistry(r.now)
	r.promSupported = false
	metrics := &fakeCollector{}
	r.runProm, r.runLogs = metrics.run, (&fakeCollector{}).run
	cfg := remote.Config{ID: "st_0123456789abcdef01234567", Version: 2, Settings: remote.DefaultSettings()}
	cfg.Settings.Collectors.Prometheus = true
	r.settings.Store(&cfg)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); r.advancedLoop(ctx) }()
	waitUntil(t, "warning", func() bool { return strings.Contains(logs.String(), "need a Linux host") })
	cancel()
	<-done
	if _, s := metrics.state(); s != 0 {
		t.Error("collector started on an unsupported OS")
	}
}

func itoa(n int) string {
	b := []byte{}
	for {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
		if n == 0 {
			return string(b)
		}
	}
}
