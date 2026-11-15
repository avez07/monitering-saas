package services

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/yuktiops/agent/internal/remote"
)

func listener(t *testing.T, handle func(net.Conn)) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); handle(c) }()
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

func closedPort() int {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	p := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return p
}

func TestProbesAndPorts(t *testing.T) {
	redis := listener(t, func(c net.Conn) {
		b := make([]byte, 16)
		c.Read(b)
		c.Write([]byte("+PONG\r\n"))
	})
	noauth := listener(t, func(c net.Conn) {
		b := make([]byte, 16)
		c.Read(b)
		c.Write([]byte("-NOAUTH Authentication required.\r\n"))
	})
	mysql := listener(t, func(c net.Conn) { c.Write([]byte{0x4a, 0, 0, 0, 0x0a, '8', '.', '0', 0}) })
	pg := listener(t, func(c net.Conn) {
		b := make([]byte, 8)
		c.Read(b)
		if b[4] == 0x04 && b[5] == 0xd2 {
			c.Write([]byte("N"))
		}
	})
	junk := listener(t, func(c net.Conn) {
		b := make([]byte, 16)
		c.Read(b)
		c.Write([]byte("HTTP/1.1 400\r\n"))
	})
	dead := closedPort()
	list := []remote.Service{
		{Kind: "redis", Name: "r1", Port: redis},
		{Kind: "redis", Name: "r2", Port: noauth},
		{Kind: "redis", Name: "r3", Port: junk},
		{Kind: "mysql", Name: "my", Port: mysql},
		{Kind: "postgres", Name: "pg", Port: pg},
		{Kind: "port", Name: "open", Port: redis},
		{Kind: "port", Name: "closed", Port: dead},
		{Kind: "mysql", Name: "mydead", Port: dead},
	}
	res := New().Check(context.Background(), list)
	want := []string{"running", "running", "stopped", "running", "running", "running", "stopped", "stopped"}
	for i, w := range want {
		if res[i].State != w {
			t.Errorf("%s = %s, want %s", res[i].Name, res[i].State, w)
		}
	}
	if res[5].ResponseMs == nil || res[5].Port == nil || *res[5].Port != redis {
		t.Errorf("port result %+v", res[5])
	}
	if res[6].ResponseMs != nil {
		t.Error("stopped service must have no responseMs")
	}
}

func TestStatusPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/nginx_status":
			w.Write([]byte("Active connections: 12 \nserver accepts handled requests\n 1 1 1\n"))
		case "/server-status":
			w.Write([]byte("Total Accesses: 5\nBusyWorkers: 3\nIdleWorkers: 7\n"))
		case "/redirect":
			http.Redirect(w, r, "http://example.invalid/", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	res := New().Check(context.Background(), []remote.Service{
		{Kind: "nginx", Name: "n", URL: srv.URL + "/nginx_status"},
		{Kind: "apache", Name: "a", URL: srv.URL + "/server-status?auto"},
		{Kind: "nginx", Name: "missing", URL: srv.URL + "/nope"},
		{Kind: "nginx", Name: "redir", URL: srv.URL + "/redirect"},
		{Kind: "nginx", Name: "down", URL: "http://127.0.0.1:1/x"},
	})
	if res[0].State != "running" || res[0].Detail != "12 active connections" {
		t.Errorf("nginx %+v", res[0])
	}
	if res[1].State != "running" || res[1].Detail != "3 busy, 7 idle workers" {
		t.Errorf("apache %+v", res[1])
	}
	for _, i := range []int{2, 3, 4} {
		if res[i].State != "stopped" {
			t.Errorf("%s = %+v", res[i].Name, res[i])
		}
	}
}

func TestSystemdAndNameValidation(t *testing.T) {
	var asked []string
	var mu sync.Mutex
	c := New()
	c.Systemctl = func(_ context.Context, unit string) (string, error) {
		mu.Lock()
		asked = append(asked, unit)
		mu.Unlock()
		switch unit {
		case "nginx":
			return "LoadState=loaded\nActiveState=active\nSubState=running\n", nil
		case "broken.service":
			return "LoadState=loaded\nActiveState=failed\nSubState=failed\n", nil
		case "off":
			return "LoadState=loaded\nActiveState=inactive\nSubState=dead\n", nil
		case "starting":
			return "LoadState=loaded\nActiveState=activating\nSubState=start\n", nil
		}
		return "LoadState=not-found\nActiveState=inactive\nSubState=dead\n", nil
	}
	res := c.Check(context.Background(), []remote.Service{
		{Kind: "systemd", Name: "nginx"}, {Kind: "systemd", Name: "broken.service"}, {Kind: "systemd", Name: "off"},
		{Kind: "systemd", Name: "starting"}, {Kind: "systemd", Name: "ghost"},
		{Kind: "systemd", Name: "--now"}, {Kind: "systemd", Name: "a b"}, {Kind: "systemd", Name: "x;reboot"},
	})
	want := []string{"running", "failed", "stopped", "unknown", "unknown", "unknown", "unknown", "unknown"}
	for i, w := range want {
		if res[i].State != w {
			t.Errorf("%s = %s, want %s", res[i].Name, res[i].State, w)
		}
	}
	if res[0].Detail != "active (running)" {
		t.Errorf("detail %q", res[0].Detail)
	}
	for _, a := range asked {
		if !unitName.MatchString(a) || a[0] == '-' {
			t.Errorf("unvalidated unit passed to systemctl: %q", a)
		}
	}
}

func TestProcessScan(t *testing.T) {
	root := t.TempDir()
	mk := func(pid, comm, cmdline string) {
		os.MkdirAll(filepath.Join(root, pid), 0o755)
		os.WriteFile(filepath.Join(root, pid, "comm"), []byte(comm+"\n"), 0o644)
		os.WriteFile(filepath.Join(root, pid, "cmdline"), []byte(cmdline), 0o644)
	}
	mk("10", "php-fpm8.2", "php-fpm: master process\x00")
	mk("11", "mydaemon", "/usr/local/bin/my-long-daemon-name\x00--x\x00")
	os.MkdirAll(filepath.Join(root, "self"), 0o755)
	c := New()
	c.ProcRoot = root
	res := c.Check(context.Background(), []remote.Service{
		{Kind: "process", Name: "php-fpm8.2"}, {Kind: "process", Name: "my-long-daemon-name"},
		{Kind: "process", Name: "mydaemon"}, {Kind: "process", Name: "apache2"},
	})
	want := []string{"running", "running", "running", "stopped"}
	for i, w := range want {
		if res[i].State != w {
			t.Errorf("%s = %s", res[i].Name, res[i].State)
		}
	}
}
