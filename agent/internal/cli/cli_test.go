package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/state"
)

const goodConfig = `{"id":"st_0123456789abcdef01234567","version":3,"settings":{}}`

// fakeAPI is a minimal stand-in for the YuktiOps API. clockOffset shifts the Date header it sends.
type fakeAPI struct {
	clockOffset time.Duration
	revoked     bool
	server      *httptest.Server
}

func newFakeAPI(t *testing.T) *fakeAPI {
	f := &fakeAPI{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", time.Now().Add(f.clockOffset).UTC().Format(http.TimeFormat))
		switch r.URL.Path {
		case "/api/health":
			w.Write([]byte(`{"status":"ok"}`))
		case "/v1/config":
			if f.revoked || r.Header.Get("Authorization") != "Bearer agent_secret" {
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error":"This server has been disconnected."}`))
				return
			}
			w.Write([]byte(goodConfig))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func setup(t *testing.T, apiURL string) *Doctor {
	t.Helper()
	dir := t.TempDir()
	paths := config.Paths{ConfigDir: filepath.Join(dir, "etc"), StateDir: filepath.Join(dir, "var")}
	os.MkdirAll(paths.ConfigDir, 0o750)
	os.MkdirAll(paths.StateDir, 0o755)
	file := config.File{APIURL: apiURL, Name: "web-1", AgentID: "a1"}
	if err := os.WriteFile(paths.ConfigFile(), file.Render(), 0o640); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(paths.CredentialFile(), []byte("agent_secret\n"), 0o640)
	d := NewDoctor(paths, "test")
	d.Service = func() ServiceState { return ServiceState{} }
	d.LookupHost = func(context.Context, string) ([]string, error) { return []string{"203.0.113.9"}, nil }
	return d
}

func find(results []Result, name string) Result {
	for _, r := range results {
		if r.Name == name {
			return r
		}
	}
	return Result{Name: "(missing " + name + ")"}
}

func TestDoctorHealthy(t *testing.T) {
	api := newFakeAPI(t)
	results := setup(t, api.server.URL).Run(context.Background())
	for _, name := range []string{"Settings", "HTTPS connection", "Clock", "Credential"} {
		if r := find(results, name); r.Status != StatusOK {
			t.Errorf("%s = %+v, want ok", name, r)
		}
	}
	var out bytes.Buffer
	if n := Print(&out, "test", results); n != 0 || !strings.Contains(out.String(), "No problems found") {
		t.Errorf("unexpected output (%d problems):\n%s", n, out.String())
	}
}

func TestDoctorBlockedHTTPS(t *testing.T) {
	// A port nobody listens on behaves like a firewall that refuses the connection.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	results := setup(t, "http://"+addr).Run(context.Background())
	r := find(results, "HTTPS connection")
	if r.Status != StatusFail || r.Code != CodeHTTPSUnreachable || !strings.Contains(r.Fix, "443") {
		t.Errorf("blocked HTTPS = %+v", r)
	}
	if c := find(results, "Credential"); c.Status != StatusSkip {
		t.Errorf("the credential cannot be checked without a connection: %+v", c)
	}
}

func TestDoctorDNSFailure(t *testing.T) {
	d := setup(t, "https://api.example.invalid")
	d.LookupHost = func(context.Context, string) ([]string, error) { return nil, errors.New("no such host") }
	r := find(d.Run(context.Background()), "DNS lookup")
	if r.Status != StatusFail || r.Code != CodeDNSFailed {
		t.Errorf("DNS = %+v", r)
	}
}

func TestDoctorProxyUnreachable(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	d := setup(t, "https://api.example.invalid")
	var f config.File
	f, _ = config.LoadFile(d.Paths.ConfigFile())
	f.Proxy = "http://" + addr
	os.WriteFile(d.Paths.ConfigFile(), f.Render(), 0o640)
	results := d.Run(context.Background())
	if r := find(results, "Proxy"); r.Status != StatusFail || r.Code != CodeProxyError {
		t.Errorf("proxy = %+v", r)
	}
	if r := find(results, "HTTPS connection"); r.Status != StatusFail || r.Code != CodeProxyError {
		t.Errorf("https through a dead proxy = %+v", r)
	}
}

func TestDoctorWrongClock(t *testing.T) {
	api := newFakeAPI(t)
	d := setup(t, api.server.URL)
	api.clockOffset = 7 * time.Minute // the server believes it is 7 minutes later than this machine does
	r := find(d.Run(context.Background()), "Clock")
	if r.Status != StatusFail || r.Code != CodeClockSkew || !strings.Contains(r.Detail, "behind") || !strings.Contains(r.Fix, "timedatectl") {
		t.Errorf("clock = %+v", r)
	}
	api.clockOffset = -90 * time.Second
	if r := find(d.Run(context.Background()), "Clock"); r.Status != StatusWarn || !strings.Contains(r.Detail, "ahead") {
		t.Errorf("a 90 second error should warn: %+v", r)
	}
	api.clockOffset = 0
	if r := find(d.Run(context.Background()), "Clock"); r.Status != StatusOK {
		t.Errorf("a correct clock should be fine: %+v", r)
	}
}

func TestDoctorRevokedCredential(t *testing.T) {
	api := newFakeAPI(t)
	api.revoked = true
	results := setup(t, api.server.URL).Run(context.Background())
	r := find(results, "Credential")
	if r.Status != StatusFail || r.Code != CodeCredentialRevoked || !strings.Contains(r.Fix, "register") {
		t.Errorf("credential = %+v", r)
	}
	if find(results, "HTTPS connection").Status != StatusOK {
		t.Error("the network itself is fine when only the credential is revoked")
	}
}

func TestDoctorBeforeRegistering(t *testing.T) {
	api := newFakeAPI(t)
	dir := t.TempDir()
	d := NewDoctor(config.Paths{ConfigDir: dir, StateDir: dir}, "test")
	d.APIOverride = api.server.URL
	d.Service = func() ServiceState { return ServiceState{} }
	results := d.Run(context.Background())
	if r := find(results, "Settings"); r.Status != StatusWarn || !strings.Contains(r.Fix, "register") {
		t.Errorf("settings = %+v", r)
	}
	if find(results, "HTTPS connection").Status != StatusOK {
		t.Error("connectivity should still be tested before registering")
	}
}

func TestStatusReport(t *testing.T) {
	d := setup(t, "https://api.yuktiops.com")
	now := time.Now()
	text, healthy := statusReport(d.Paths, ServiceState{Systemd: true, Active: "active", Enabled: "enabled"}, now, "1.0")
	if healthy || !strings.Contains(text, "no data sent yet") {
		t.Errorf("before the first send:\n%s", text)
	}
	last := now.Add(-12 * time.Second)
	state.Save(d.Paths.StateFile(), state.State{
		Connection: state.Connected, LastSuccessAt: &last, UpdatedAt: now, SendIntervalSeconds: 30,
	})
	text, healthy = statusReport(d.Paths, ServiceState{Systemd: true, Active: "active", Enabled: "enabled"}, now, "1.0")
	if !healthy || !strings.Contains(text, "running") || !strings.Contains(text, "Connected, last data sent 12 seconds ago") {
		t.Errorf("healthy status:\n%s", text)
	}
	text, healthy = statusReport(d.Paths, ServiceState{Systemd: true, Active: "inactive"}, now, "1.0")
	if healthy || !strings.Contains(text, "NOT running") || !strings.Contains(text, "systemctl enable --now") {
		t.Errorf("stopped service:\n%s", text)
	}
	os.Remove(d.Paths.ConfigFile())
	text, healthy = statusReport(d.Paths, ServiceState{}, now, "1.0")
	if healthy || !strings.Contains(text, "not registered") {
		t.Errorf("unregistered:\n%s", text)
	}
}

func TestUninstallRemovesEverythingItCreated(t *testing.T) {
	d := setup(t, "https://api.yuktiops.com")
	os.WriteFile(d.Paths.MachineIDFile(), []byte("x"), 0o640)
	os.WriteFile(d.Paths.StateFile(), []byte("{}"), 0o644)
	os.WriteFile(d.Paths.BufferFile(), []byte("{}"), 0o644)
	run := func(keep bool) (bool, string) {
		var out bytes.Buffer
		u := NewUninstaller(d.Paths, keep, &out)
		return u.Execute(), out.String()
	}
	// --keep-config keeps agent.yaml and the credential but still clears the state directory.
	if ok, out := run(true); !ok {
		t.Fatalf("uninstall failed:\n%s", out)
	}
	if _, err := os.Stat(d.Paths.ConfigFile()); err != nil {
		t.Error("--keep-config must keep agent.yaml")
	}
	if _, err := os.Stat(d.Paths.StateDir); err == nil {
		t.Error("the state directory should be gone")
	}
	if ok, out := run(false); !ok {
		t.Fatalf("second uninstall failed:\n%s", out)
	}
	if _, err := os.Stat(d.Paths.ConfigDir); err == nil {
		t.Error("the config directory should be gone")
	}
}

func TestUnknownCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := Main([]string{"frobnicate"}, &out, &errOut, Build{Version: "1"}); code != 2 || !strings.Contains(errOut.String(), "Unknown command") {
		t.Errorf("code %d, %q", code, errOut.String())
	}
	out.Reset()
	if code := Main([]string{"version"}, &out, &errOut, Build{Version: "9.9.9"}); code != 0 || !strings.Contains(out.String(), "9.9.9") {
		t.Errorf("version: %d %q", code, out.String())
	}
}

func TestRegisterWritesCredentialButNotTheAPIKey(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"agentId":"a-1","credential":"agent_newcredential","endpoint":"x","reconnected":false,"config":{}}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	cfgDir, stateDir := filepath.Join(dir, "etc"), filepath.Join(dir, "var")
	key := "yk_live_" + strings.Repeat("a", 64)
	var out, errOut bytes.Buffer
	code := Main([]string{"register", "--key=" + key, "--api=" + srv.URL, "--name=test box", "--config-dir=" + cfgDir, "--state-dir=" + stateDir},
		&out, &errOut, Build{Version: "1.2.3"})
	if code != 0 {
		t.Fatalf("register failed (%d): %s %s", code, out.String(), errOut.String())
	}
	if gotAuth != "Bearer "+key {
		t.Errorf("authorization = %q", gotAuth)
	}
	if fp, _ := gotBody["fingerprint"].(string); len(fp) != 64 || gotBody["name"] != "test box" || gotBody["version"] != "1.2.3" {
		t.Errorf("body = %v", gotBody)
	}
	p := config.Paths{ConfigDir: cfgDir, StateDir: stateDir}
	if cred, err := config.LoadCredential(p.CredentialFile()); err != nil || cred != "agent_newcredential" {
		t.Errorf("credential = %q, %v", cred, err)
	}
	entries, _ := os.ReadDir(cfgDir)
	for _, e := range entries {
		data, _ := os.ReadFile(filepath.Join(cfgDir, e.Name()))
		if strings.Contains(string(data), key) {
			t.Errorf("the account API key was written to %s", e.Name())
		}
	}
	if strings.Contains(out.String()+errOut.String(), key) {
		t.Error("the account API key must never be printed")
	}
	// Registering the same machine again must send the same fingerprint (no duplicate server).
	first := gotBody["fingerprint"]
	Main([]string{"register", "--key=" + key, "--api=" + srv.URL, "--config-dir=" + cfgDir, "--state-dir=" + stateDir}, &out, &errOut, Build{Version: "1.2.3"})
	if gotBody["fingerprint"] != first {
		t.Error("the fingerprint must be stable between registrations")
	}
	// A bad key is rejected before any request.
	if code := Main([]string{"register", "--key=nope", "--config-dir=" + cfgDir}, &out, &errOut, Build{}); code != 2 {
		t.Errorf("bad key accepted: %d", code)
	}
}
