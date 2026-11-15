package config

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func TestNormalizeAPIURL(t *testing.T) {
	ok := map[string]string{
		"https://api.yuktiops.com":       "https://api.yuktiops.com",
		"https://api.yuktiops.com/":      "https://api.yuktiops.com",
		"HTTPS://api.yuktiops.com/base/": "https://api.yuktiops.com/base",
		"https://10.0.0.5:8443":          "https://10.0.0.5:8443",
		"http://localhost:4000":          "http://localhost:4000",
		"http://127.0.0.1:4000/":         "http://127.0.0.1:4000",
		"http://[::1]:4000":              "http://[::1]:4000",
		" https://api.yuktiops.com ":     "https://api.yuktiops.com",
	}
	for in, want := range ok {
		got, err := NormalizeAPIURL(in)
		if err != nil || got != want {
			t.Errorf("NormalizeAPIURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{
		"",
		"http://api.yuktiops.com",            // plain http to a remote host
		"http://192.168.1.10:4000",           // a LAN address is not this machine
		"http://127.0.0.2:4000",              // only the exact loopback names are allowed
		"http://localhost.evil.example",      // looks like localhost, is not
		"http://host.docker.internal:4000",   // resolves to the host, still not allowed
		"ftp://api.yuktiops.com",             // wrong scheme
		"api.yuktiops.com",                   // no scheme
		"https://",                           // no host
		"https://user:pass@api.yuktiops.com", // credentials in the URL
		"https://api.yuktiops.com/?x=1",      // query
		"file:///etc/passwd",
	}
	for _, in := range bad {
		if got, err := NormalizeAPIURL(in); err == nil {
			t.Errorf("NormalizeAPIURL(%q) = %q, want an error", in, got)
		}
	}
	if _, err := NormalizeAPIURL("http://example.com"); err == nil || !strings.Contains(err.Error(), "https://") {
		t.Errorf("the http error should tell the user to use https, got %v", err)
	}
}

func TestNormalizeProxyURL(t *testing.T) {
	for _, in := range []string{"", "http://proxy:3128", "https://proxy.example.com", "socks5://127.0.0.1:1080"} {
		if _, err := NormalizeProxyURL(in); err != nil {
			t.Errorf("NormalizeProxyURL(%q) failed: %v", in, err)
		}
	}
	for _, in := range []string{"proxy:3128", "ftp://proxy", "http://"} {
		if _, err := NormalizeProxyURL(in); err == nil {
			t.Errorf("NormalizeProxyURL(%q) should fail", in)
		}
	}
}

func TestFileRoundTrip(t *testing.T) {
	in := File{
		APIURL:  "https://api.yuktiops.com",
		Name:    `web "one" #1`,
		AgentID: "0b8f8c4e-1111-2222-3333-444455556666",
		SetupID: "st_0123456789abcdef01234567",
		Proxy:   "http://proxy.example.com:3128",
	}
	out, err := ParseFile(in.Render())
	if err != nil {
		t.Fatalf("ParseFile: %v\n%s", err, in.Render())
	}
	if out != in {
		t.Errorf("round trip changed the file:\n got %+v\nwant %+v", out, in)
	}
}

func TestParseFileRules(t *testing.T) {
	f, err := ParseFile([]byte("name: box\nfuture_setting: {a: 1}\n"))
	if err != nil {
		t.Fatalf("unknown keys must be ignored: %v", err)
	}
	if f.APIURL != DefaultAPIURL {
		t.Errorf("missing api_url should default, got %q", f.APIURL)
	}
	if _, err := ParseFile([]byte("api_url: http://example.com\n")); err == nil {
		t.Error("plain http to a remote host must be refused when loading agent.yaml")
	}
	if _, err := ParseFile([]byte("api_url: [not, a, string\n")); err == nil {
		t.Error("broken YAML must be an error")
	}
	if _, err := ParseFile([]byte("proxy: nonsense\n")); err == nil {
		t.Error("a bad proxy must be an error")
	}
}

func TestCredentialAndSecureWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credential")
	if _, err := LoadCredential(path); err != ErrNotRegistered {
		t.Fatalf("missing credential should be ErrNotRegistered, got %v", err)
	}
	if err := WriteSecure(path, []byte("agent_abc123\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	got, err := LoadCredential(path)
	if err != nil || got != "agent_abc123" {
		t.Fatalf("LoadCredential = %q, %v", got, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o640 { // Windows has no Unix permission bits
		t.Errorf("mode = %o, want 640", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("temporary files were left behind: %v", entries)
	}
	os.WriteFile(path, []byte("  \n"), 0o600)
	if _, err := LoadCredential(path); err == nil {
		t.Error("an empty credential must be an error")
	}
}

func TestFingerprint(t *testing.T) {
	dir := t.TempDir()
	hex64 := regexp.MustCompile(`^[a-f0-9]{64}$`)
	machine := filepath.Join(dir, "machine-id")
	fallback := filepath.Join(dir, "fallback-id")
	os.WriteFile(machine, []byte("abc\n"), 0o644)

	a, err := fingerprintFrom([]string{machine}, fallback)
	if err != nil || !hex64.MatchString(a) {
		t.Fatalf("fingerprint = %q, %v", a, err)
	}
	// SHA-256 of the trimmed id ("abc"), exactly as the backend and the reference agent expect.
	if a != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Errorf("fingerprint must be the SHA-256 of the trimmed machine id, got %s", a)
	}
	if _, err := os.Stat(fallback); err == nil {
		t.Error("no fallback id should be written when /etc/machine-id exists")
	}

	// Missing and empty machine ids fall back to a generated id that is stable across calls.
	empty := filepath.Join(dir, "empty")
	os.WriteFile(empty, []byte("\n"), 0o644)
	sources := []string{filepath.Join(dir, "missing"), empty}
	b, err := fingerprintFrom(sources, fallback)
	if err != nil || !hex64.MatchString(b) {
		t.Fatalf("fallback fingerprint = %q, %v", b, err)
	}
	c, _ := fingerprintFrom(sources, fallback)
	if b != c {
		t.Error("the fallback fingerprint must not change between runs")
	}
	if a == b {
		t.Error("fallback fingerprint should differ from the machine-id one")
	}
}

func TestResolvePaths(t *testing.T) {
	t.Setenv(EnvConfigDir, "")
	t.Setenv(EnvStateDir, "")
	p := ResolvePaths("", "")
	if !p.IsDefault() || p.CredentialFile() != filepath.Join("/etc/yuktiops", "credential") || p.StateFile() != filepath.Join("/var/lib/yuktiops", "state.json") {
		t.Errorf("defaults wrong: %+v", p)
	}
	t.Setenv(EnvConfigDir, "/tmp/env-config")
	t.Setenv(EnvStateDir, "/tmp/env-state")
	p = ResolvePaths("", "/tmp/flag-state")
	if p.ConfigDir != filepath.Clean("/tmp/env-config") || p.StateDir != filepath.Clean("/tmp/flag-state") {
		t.Errorf("precedence wrong: %+v", p)
	}
}

func TestLoadEnvironmentFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "environment")
	os.WriteFile(path, []byte("# proxy\nHTTPS_PROXY=\"http://proxy:3128\"\nNO_PROXY=internal\nLD_PRELOAD=/evil.so\n"), 0o644)
	t.Setenv("NO_PROXY", "already-set")
	t.Setenv("HTTPS_PROXY", "")
	os.Unsetenv("HTTPS_PROXY")
	t.Setenv("LD_PRELOAD", "")
	os.Unsetenv("LD_PRELOAD")
	LoadEnvironmentFile(path)
	if got := os.Getenv("HTTPS_PROXY"); got != "http://proxy:3128" {
		t.Errorf("HTTPS_PROXY = %q", got)
	}
	if got := os.Getenv("NO_PROXY"); got != "already-set" {
		t.Errorf("existing variables must win, NO_PROXY = %q", got)
	}
	if got := os.Getenv("LD_PRELOAD"); got != "" {
		t.Errorf("only proxy variables may be imported, LD_PRELOAD = %q", got)
	}
}
