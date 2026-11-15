package docker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type fake struct {
	mu       sync.Mutex
	state    string // state of "web"
	restarts int
	total    uint64
	system   uint64
	methods  []string
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.methods = append(f.methods, r.Method)
	switch r.URL.Path {
	case "/containers/json":
		fmt.Fprintf(w, `[
		 {"Id":"aaaaaaaaaaaaaaaaaaaa","Names":["/web"],"Image":"nginx:1.27","State":%q,"Status":"Up 3 hours"},
		 {"Id":"bbbbbbbbbbbbbbbbbbbb","Names":["/old"],"Image":"busybox","State":"exited","Status":"Exited (0) 2 days ago"}]`, f.state)
	case "/containers/aaaaaaaaaaaaaaaaaaaa/json":
		fmt.Fprintf(w, `{"RestartCount":%d,"State":{"StartedAt":"2026-11-15T07:00:00.123456789Z","OOMKilled":false},"HostConfig":{"Memory":536870912}}`, f.restarts)
	case "/containers/bbbbbbbbbbbbbbbbbbbb/json":
		w.Write([]byte(`{"RestartCount":0,"State":{"StartedAt":"0001-01-01T00:00:00Z","OOMKilled":true},"HostConfig":{"Memory":0}}`))
	case "/containers/aaaaaaaaaaaaaaaaaaaa/stats":
		if r.URL.Query().Get("one-shot") != "true" || r.URL.Query().Get("stream") != "false" {
			http.Error(w, "bad query", 400)
			return
		}
		fmt.Fprintf(w, `{"cpu_stats":{"cpu_usage":{"total_usage":%d},"system_cpu_usage":%d,"online_cpus":4},
		  "precpu_stats":{"cpu_usage":{"total_usage":0},"system_cpu_usage":0},
		  "memory_stats":{"usage":104857600,"stats":{"inactive_file":52428800,"active_file":1}}}`, f.total, f.system)
	default:
		http.NotFound(w, r)
	}
}

func serve(t *testing.T, h http.Handler) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "dk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	return sock
}

func TestCollectLifecycle(t *testing.T) {
	f := &fake{state: "running", total: 1_000, system: 100_000}
	c := New(serve(t, f))
	list, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Name != "web" || list[1].Name != "old" {
		t.Fatalf("%+v", list)
	}
	web := list[0]
	if web.ID != "aaaaaaaaaaaa" || web.State != "running" || web.Image != "nginx:1.27" || web.StartedAt != "2026-11-15T07:00:00.123Z" {
		t.Errorf("web %+v", web)
	}
	if web.CPUPercent != nil {
		t.Error("first sample has nothing to compare with, cpuPercent must be omitted")
	}
	if *web.MemoryBytes != 52428800 || *web.MemoryLimitBytes != 536870912 {
		t.Errorf("memory %v %v", *web.MemoryBytes, *web.MemoryLimitBytes)
	}
	if old := list[1]; old.State != "exited" || old.StartedAt != "" || !old.OOMKilled || old.MemoryBytes != nil || old.MemoryLimitBytes != nil {
		t.Errorf("old %+v", old)
	}

	// Second round: 4 cpus, container used 500 of 10000 system ticks -> 0.05*4*100 = 20%. Also a restart.
	f.mu.Lock()
	f.total, f.system, f.restarts = 1_500, 110_000, 2
	f.mu.Unlock()
	list, err = c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if list[0].CPUPercent == nil || *list[0].CPUPercent != 20 || list[0].RestartCount != 2 {
		t.Errorf("round 2 %+v", list[0])
	}

	// The container stops.
	f.mu.Lock()
	f.state = "exited"
	f.mu.Unlock()
	list, _ = c.Collect(context.Background())
	for _, ct := range list {
		if ct.State == "running" || ct.CPUPercent != nil || ct.MemoryBytes != nil {
			t.Errorf("stopped container %+v", ct)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.methods {
		if m != http.MethodGet {
			t.Errorf("non-GET request %s", m)
		}
	}
}

func TestCPUPercentAndMemory(t *testing.T) {
	if p, ok := CPUPercent(100, 1000, 200, 2000, 2); !ok || p != 20 {
		t.Errorf("%v %v", p, ok)
	}
	if _, ok := CPUPercent(100, 1000, 200, 1000, 2); ok {
		t.Error("no system delta")
	}
	if _, ok := CPUPercent(300, 1000, 200, 2000, 2); ok {
		t.Error("counter went backwards (container restarted)")
	}
	if MemoryUsed(100, map[string]uint64{"total_inactive_file": 30}) != 70 || MemoryUsed(100, map[string]uint64{"cache": 30}) != 70 ||
		MemoryUsed(10, map[string]uint64{"inactive_file": 30}) != 0 || MemoryUsed(100, nil) != 100 {
		t.Error("memory math")
	}
}

func TestNeverWrites(t *testing.T) {
	c := New("/nonexistent.sock")
	req, _ := http.NewRequest(http.MethodPost, "http://docker/containers/x/kill", nil)
	if _, err := c.client.Do(req); err == nil {
		t.Fatal("POST must be refused")
	}
	if len(c.Requests()) != 0 {
		t.Error("a refused request must not reach the socket")
	}
}

func TestPermissionDeniedAndMissing(t *testing.T) {
	sock := serve(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "denied", http.StatusForbidden)
	}))
	if _, err := New(sock).Collect(context.Background()); !errors.Is(err, ErrDenied) {
		t.Errorf("403: %v", err)
	}
	if os.Geteuid() != 0 {
		// Unreachable socket path -> EACCES at connect time.
		locked := filepath.Join(t.TempDir(), "sub")
		os.Mkdir(locked, 0o700)
		s2 := filepath.Join(locked, "d.sock")
		l, _ := net.Listen("unix", s2)
		defer l.Close()
		os.Chmod(locked, 0)
		defer os.Chmod(locked, 0o700)
		if _, err := New(s2).Collect(context.Background()); !errors.Is(err, ErrDenied) {
			t.Errorf("eacces: %v", err)
		}
	}
	if _, err := New(filepath.Join(t.TempDir(), "none.sock")).Collect(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Errorf("missing: %v", err)
	}
}

func TestContainerCap(t *testing.T) {
	sock := serve(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/containers/json" {
			w.Write([]byte(`{}`))
			return
		}
		w.Write([]byte("["))
		for i := 0; i < 150; i++ {
			if i > 0 {
				w.Write([]byte(","))
			}
			fmt.Fprintf(w, `{"Id":"id%d","Names":["/c%d"],"Image":"i","State":"exited"}`, i, i)
		}
		w.Write([]byte("]"))
	}))
	list, err := New(sock).Collect(context.Background())
	if err != nil || len(list) != MaxContainers {
		t.Errorf("%d %v", len(list), err)
	}
}
