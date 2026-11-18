package client

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

func newTestClient(t *testing.T, url string) *Client {
	t.Helper()
	t.Setenv("YUKTIOPS_ALLOW_INSECURE", "")
	c, err := New(url, "", "test")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestExplainRefusedNamesURLSchemeAndReason(t *testing.T) {
	// Grab a free port and close it so nothing listens there.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	c := newTestClient(t, "http://"+addr)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := c.Health(ctx)
	if err == nil {
		t.Fatal("expected an error")
	}
	msg := c.Explain(err)
	for _, want := range []string{"http://" + addr, "scheme http", "connection refused", "resolved 127.0.0.1"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q lacks %q", msg, want)
		}
	}
	if strings.Contains(msg, "over HTTPS") {
		t.Errorf("an http:// URL must not be reported as an HTTPS problem: %q", msg)
	}
	if Classify(err).Code() != "https_unreachable" {
		t.Errorf("code should stay stable for the catalog, got %s", Classify(err).Code())
	}
}

func TestExplainDNS(t *testing.T) {
	c := newTestClient(t, "https://no-such-host.invalid")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.Health(ctx)
	if err == nil {
		t.Fatal("expected an error")
	}
	msg := c.Explain(err)
	if !strings.Contains(msg, "DNS failure") || !strings.Contains(msg, "scheme https") {
		t.Errorf("unexpected message %q", msg)
	}
}

func TestLocalhostHintOnlyForLoopbackInContainer(t *testing.T) {
	c := newTestClient(t, "https://api.example.com")
	if c.LocalhostHint() != "" {
		t.Error("no hint for a public host")
	}
}
