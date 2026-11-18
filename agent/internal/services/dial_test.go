package services

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestDialDetailExplainsTheCause(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := dial(ctx, "127.0.0.1", port)
	if got := dialDetail(err); got != "connection refused" {
		t.Errorf("closed port: %q", got)
	}
	_, err = dial(ctx, "no-such-host.invalid", 80)
	if got := dialDetail(err); got != "DNS lookup failed" {
		t.Errorf("unknown host: %q", got)
	}
}
