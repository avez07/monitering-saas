// Package services checks the services named in the remote settings: systemd units, processes,
// local TCP ports, nginx/Apache status pages and Redis, MySQL, PostgreSQL and SQL Server liveness.
//
// Everything is read-only. Liveness checks are credential-free; a database service with a
// credentialsRef is additionally logged in to with credentials read from this machine only
// (see creds.go), and the secret is never logged or sent to YuktiOps. The only program ever
// executed is `systemctl show` with a validated unit name; nothing else is run, whatever the
// settings say.
package services

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/remote"
)

const (
	checkTimeout = 3 * time.Second
	concurrency  = 8
	maxBody      = 64 << 10
)

// Result is one entry of the ingest payload's "services" array.
type Result struct {
	Name       string   `json:"name"`
	Kind       string   `json:"kind"`
	State      string   `json:"state"`
	Detail     string   `json:"detail,omitempty"`
	ResponseMs *float64 `json:"responseMs,omitempty"`
	Port       *int     `json:"port,omitempty"`
}

var unitName = regexp.MustCompile(`^[A-Za-z0-9@_.:-]+$`)

// Checker runs the configured checks. The fields can be replaced in tests.
type Checker struct {
	ProcRoot string
	// Systemctl runs `systemctl show` for a unit and returns its output.
	Systemctl func(ctx context.Context, unit string) (string, error)
	HTTP      *http.Client
	// Creds finds credentials for services with a credentialsRef (nil: none configured).
	Creds *CredentialStore
	// Query logs in to a database (QueryDB; replaced in tests).
	Query func(ctx context.Context, s remote.Service, creds Credentials, metrics bool) ([]Metric, error)
}

// New returns a checker for the running system.
func New() *Checker {
	return &Checker{
		ProcRoot:  config.HostPath(config.HostRoot(), "/proc"),
		Systemctl: runSystemctl,
		Query:     QueryDB,
		HTTP: &http.Client{
			Timeout: checkTimeout,
			Transport: &http.Transport{
				Proxy:                 nil, // local status pages are never sent through a proxy
				DisableKeepAlives:     true,
				DisableCompression:    true,
				ResponseHeaderTimeout: checkTimeout,
				DialContext:           (&net.Dialer{Timeout: checkTimeout}).DialContext,
			},
			// A redirect could lead off-host; treat the 3xx itself as the answer.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func runSystemctl(ctx context.Context, unit string) (string, error) {
	// Fixed argument list; the unit name was validated by the caller and cannot start with "-".
	cmd := exec.CommandContext(ctx, "systemctl", "show", "--property=LoadState,ActiveState,SubState", "--", unit)
	out, err := cmd.Output()
	return string(out), err
}

// Check runs every check (at most `concurrency` at a time) and returns the results in order.
func (c *Checker) Check(ctx context.Context, list []remote.Service) []Result {
	out := make([]Result, len(list))
	var procs map[string]bool
	for _, s := range list {
		if s.Kind == "process" {
			procs = c.processNames()
			break
		}
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)
	for i, s := range list {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, s remote.Service) {
			defer wg.Done()
			defer func() { <-sem }()
			cctx, cancel := context.WithTimeout(ctx, checkTimeout+time.Second)
			defer cancel()
			out[i] = c.one(cctx, s, procs)
			if out[i].State == "running" && s.CredentialsRef != "" && isDatabase(s.Kind) {
				out[i].Detail = c.authenticate(ctx, s)
			}
		}(i, s)
	}
	wg.Wait()
	return out
}

func isDatabase(kind string) bool {
	return kind == "redis" || kind == "mysql" || kind == "postgres" || kind == "mssql"
}

// authenticate logs in with the service's local credentials and returns the status detail:
// "authenticated", "auth failed: wrong user or password", "credentials not found", ...
func (c *Checker) authenticate(ctx context.Context, s remote.Service) string {
	creds, err := c.Creds.Load(s.CredentialsRef)
	if err != nil {
		return AuthDetail(err)
	}
	query := c.Query
	if query == nil {
		query = QueryDB
	}
	_, err = query(ctx, s, creds, false)
	return AuthDetail(err)
}

func (c *Checker) one(ctx context.Context, s remote.Service, procs map[string]bool) Result {
	r := Result{Name: s.Name, Kind: s.Kind, State: "stopped"}
	if s.Port > 0 {
		p := s.Port
		r.Port = &p
	}
	host := s.Host
	if host == "" {
		host = "127.0.0.1"
	}
	start := time.Now()
	ms := func() { v := float64(time.Since(start).Microseconds()) / 1000; r.ResponseMs = &v }
	switch s.Kind {
	case "systemd":
		r.State, r.Detail = c.systemd(ctx, s.Name)
	case "process":
		if procs[s.Name] || procs[trunc15(s.Name)] {
			r.State = "running"
		}
	case "port":
		conn, err := dial(ctx, host, s.Port)
		if err != nil {
			r.Detail = dialDetail(err)
			break
		}
		conn.Close()
		r.State = "running"
		ms()
	case "nginx", "apache":
		r.State, r.Detail = c.status(ctx, s)
		if r.State == "running" {
			ms()
		}
	case "redis", "mysql", "postgres", "mssql":
		conn, err := dial(ctx, host, s.Port)
		if err != nil {
			r.Detail = dialDetail(err)
			break
		}
		detail, ok := probe(s.Kind, conn)
		conn.Close()
		r.Detail = detail
		if ok {
			r.State = "running"
			ms()
		}
	}
	return r
}

// dialDetail says why a connection failed, in words the dashboard can classify: "connection
// refused", "timed out" or "DNS lookup failed". It never contains the host or anything secret.
func dialDetail(err error) string {
	var dns *net.DNSError
	switch {
	case errors.As(err, &dns):
		return "DNS lookup failed"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection refused"
	case errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err):
		return "timed out"
	}
	return "connection failed"
}

func dial(ctx context.Context, host string, port int) (net.Conn, error) {
	d := net.Dialer{Timeout: checkTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(checkTimeout))
	return conn, nil
}

// probe sends the smallest possible, credential-free request and reads the first answer.
func probe(kind string, conn net.Conn) (string, bool) {
	buf := make([]byte, 64)
	switch kind {
	case "redis":
		if _, err := conn.Write([]byte("PING\r\n")); err != nil {
			return "no answer", false
		}
		n, _ := conn.Read(buf)
		reply := string(buf[:n])
		switch {
		case strings.HasPrefix(reply, "+PONG"):
			return "PONG", true
		case strings.HasPrefix(reply, "-NOAUTH"):
			return "responding (password required)", true
		}
		return "unexpected reply", false
	case "mysql":
		n, _ := io.ReadAtLeast(conn, buf, 5)
		if n >= 5 && buf[4] == 0x0a {
			return "greeting received", true
		}
		if n >= 5 && buf[4] == 0xff {
			return "responding (connection refused by server)", true
		}
		return "no greeting", false
	case "postgres":
		// SSLRequest: length 8, code 80877103.
		if _, err := conn.Write([]byte{0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f}); err != nil {
			return "no answer", false
		}
		n, _ := conn.Read(buf[:1])
		if n == 1 && (buf[0] == 'S' || buf[0] == 'N') {
			return "responding", true
		}
		return "unexpected reply", false
	case "mssql":
		return probeMSSQL(conn)
	}
	return "", false
}

func (c *Checker) systemd(ctx context.Context, name string) (string, string) {
	if !unitName.MatchString(name) || strings.HasPrefix(name, "-") {
		return "unknown", "invalid unit name"
	}
	if c.Systemctl == nil {
		return "unknown", "systemd is not available"
	}
	out, err := c.Systemctl(ctx, name)
	if err != nil && out == "" {
		return "unknown", "systemd is not available"
	}
	props := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			props[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	if props["LoadState"] == "not-found" {
		return "unknown", "unit not found"
	}
	active, sub := props["ActiveState"], props["SubState"]
	detail := active
	if sub != "" {
		detail = fmt.Sprintf("%s (%s)", active, sub)
	}
	switch active {
	case "active":
		return "running", detail
	case "failed":
		return "failed", detail
	case "inactive", "deactivating":
		return "stopped", detail
	}
	return "unknown", detail
}

func (c *Checker) status(ctx context.Context, s remote.Service) (string, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.URL, nil)
	if err != nil {
		return "stopped", "invalid URL"
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "stopped", "no answer"
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, maxBody))
	if res.StatusCode != http.StatusOK {
		return "stopped", fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	if s.Kind == "nginx" {
		return "running", nginxDetail(string(body))
	}
	return "running", apacheDetail(string(body))
}

func nginxDetail(body string) string {
	for _, line := range strings.Split(body, "\n") {
		if v, ok := strings.CutPrefix(line, "Active connections:"); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
				return fmt.Sprintf("%d active connections", n)
			}
		}
	}
	return ""
}

func apacheDetail(body string) string {
	var busy, idle string
	for _, line := range strings.Split(body, "\n") {
		if v, ok := strings.CutPrefix(line, "BusyWorkers:"); ok {
			busy = strings.TrimSpace(v)
		}
		if v, ok := strings.CutPrefix(line, "IdleWorkers:"); ok {
			idle = strings.TrimSpace(v)
		}
	}
	if busy != "" && idle != "" {
		return fmt.Sprintf("%s busy, %s idle workers", busy, idle)
	}
	return ""
}

func trunc15(s string) string {
	if len(s) > 15 {
		return s[:15]
	}
	return s
}

// processNames returns the set of process names (comm and the base name of argv[0]) found in /proc.
func (c *Checker) processNames() map[string]bool {
	names := map[string]bool{}
	entries, err := os.ReadDir(c.ProcRoot)
	if err != nil {
		return names
	}
	for _, e := range entries {
		if !e.IsDir() || !isNumber(e.Name()) {
			continue
		}
		dir := filepath.Join(c.ProcRoot, e.Name())
		if b, err := os.ReadFile(filepath.Join(dir, "comm")); err == nil {
			names[strings.TrimSpace(string(b))] = true
		}
		if f, err := os.Open(filepath.Join(dir, "cmdline")); err == nil {
			arg, _ := bufio.NewReaderSize(f, 512).ReadString(0)
			f.Close()
			if arg = strings.TrimRight(arg, "\x00"); arg != "" {
				names[filepath.Base(strings.Fields(arg)[0])] = true
			}
		}
	}
	return names
}

func isNumber(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
