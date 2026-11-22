package services

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/yuktiops/agent/internal/remote"
)

func TestMSSQLPreloginProbe(t *testing.T) {
	var got []byte
	tds := listener(t, func(c net.Conn) {
		b := make([]byte, 64)
		n, _ := c.Read(b)
		got = append([]byte(nil), b[:n]...)
		c.Write([]byte{0x04, 0x01, 0x00, 0x2b, 0x00, 0x00, 0x01, 0x00, 0x00})
	})
	other := listener(t, func(c net.Conn) {
		b := make([]byte, 64)
		c.Read(b)
		c.Write([]byte("HTTP/1.1 400 Bad\r\n"))
	})
	ck := New()
	res := ck.Check(context.Background(), []remote.Service{
		{Kind: "mssql", Name: "sql", Port: tds},
		{Kind: "mssql", Name: "web", Port: other},
		{Kind: "mssql", Name: "down", Port: closedPort()},
	})
	if res[0].State != "running" || res[0].Detail != "responding" {
		t.Errorf("tds: %+v", res[0])
	}
	if len(got) < 8 || got[0] != 0x12 || got[1] != 0x01 || int(got[2])<<8|int(got[3]) != len(got) {
		t.Errorf("prelogin packet % x", got)
	}
	if res[1].State != "stopped" || res[1].Detail != "unexpected reply" {
		t.Errorf("non-tds: %+v", res[1])
	}
	if res[2].State != "stopped" || res[2].Detail != "connection refused" {
		t.Errorf("down: %+v", res[2])
	}
}

func TestCredentialLookup(t *testing.T) {
	dir := t.TempDir()
	credDir := filepath.Join(dir, "credentials.d")
	os.MkdirAll(credDir, 0o755)
	env := map[string]string{}
	store := &CredentialStore{Dir: credDir, Getenv: func(k string) string { return env[k] }}

	if _, err := store.Load("redis-main"); !errors.Is(err, ErrCredentialsNotFound) {
		t.Errorf("missing: %v", err)
	}
	if _, err := store.Load("../etc/passwd"); !errors.Is(err, ErrCredentialsNotFound) {
		t.Errorf("invalid ref: %v", err)
	}

	file := filepath.Join(credDir, "redis-main.env")
	os.WriteFile(file, []byte("# monitoring user\nexport USER=yuktiops\nPASSWORD=\"p@ss word\"\nDATABASE='app'\nSSLMODE=require\n"), 0o600)
	c, err := store.Load("redis-main")
	if err != nil || c.User != "yuktiops" || c.Password != "p@ss word" || c.Database != "app" || c.SSLMode != "require" {
		t.Fatalf("file: %v %v", c.User, err)
	}
	if s := fmt.Sprintf("%v %+v %#v", c, c, c); strings.Contains(s, "p@ss") {
		t.Errorf("credentials printed their secret: %s", s)
	}

	if runtime.GOOS != "windows" {
		os.Chmod(file, 0o644)
		if _, err := store.Load("redis-main"); !errors.Is(err, ErrCredentialsMode) || AuthDetail(err) != "credentials file must be 0600" {
			t.Errorf("0644: %v", err)
		}
		os.Chmod(file, 0o400)
		if _, err := store.Load("redis-main"); err != nil {
			t.Errorf("0400 is stricter than 0600 and must be accepted: %v", err)
		}
	}

	// The environment comes first: REF upper-cased, "-" -> "_".
	env["YUKTIOPS_CRED_REDIS_MAIN_USER"] = "envuser"
	env["YUKTIOPS_CRED_REDIS_MAIN_PASSWORD"] = "envpass"
	if c, err := store.Load("redis-main"); err != nil || c.User != "envuser" || c.Password != "envpass" {
		t.Errorf("env: %v %v", c.User, err)
	}
	env = map[string]string{"YUKTIOPS_CRED_PG_URL": "postgres://u:p@db/x"}
	if c, err := store.Load("pg"); err != nil || c.URL == "" {
		t.Errorf("env url: %v", err)
	}
}

func TestAuthDetails(t *testing.T) {
	cases := map[error]string{
		nil:                                     "authenticated",
		ErrAuthFailed:                           "auth failed: wrong user or password",
		ErrCredentialsNotFound:                  "credentials not found",
		ErrCredentialsMode:                      "credentials file must be 0600",
		context.DeadlineExceeded:                "auth check failed: timed out",
		errors.New("password=hunter2 rejected"): "auth check failed",
	}
	for err, want := range cases {
		if got := AuthDetail(err); got != want {
			t.Errorf("AuthDetail(%v) = %q, want %q", err, got, want)
		}
	}
}

func TestAuthenticatedChecks(t *testing.T) {
	redis := listener(t, func(c net.Conn) {
		b := make([]byte, 64)
		c.Read(b)
		c.Write([]byte("-NOAUTH Authentication required.\r\n"))
	})
	ck := New()
	ck.Creds = &CredentialStore{Getenv: func(k string) string {
		return map[string]string{"YUKTIOPS_CRED_GOOD_PASSWORD": "right", "YUKTIOPS_CRED_BAD_PASSWORD": "wrong"}[k]
	}}
	ck.Query = func(_ context.Context, s remote.Service, c Credentials, metrics bool) ([]Metric, error) {
		if metrics {
			t.Error("the service check must not collect metrics")
		}
		if c.Password != "right" {
			return nil, ErrAuthFailed
		}
		return nil, nil
	}
	res := ck.Check(context.Background(), []remote.Service{
		{Kind: "redis", Name: "a", Port: redis, CredentialsRef: "good"},
		{Kind: "redis", Name: "b", Port: redis, CredentialsRef: "bad"},
		{Kind: "redis", Name: "c", Port: redis, CredentialsRef: "none"},
		{Kind: "redis", Name: "d", Port: redis},
	})
	want := []string{"authenticated", "auth failed: wrong user or password", "credentials not found", "responding (password required)"}
	for i, w := range want {
		if res[i].State != "running" || res[i].Detail != w {
			t.Errorf("%d: %+v, want detail %q", i, res[i], w)
		}
	}
}

// fakeRedis speaks enough RESP for AUTH and INFO.
func fakeRedis(t *testing.T, password string) int {
	return listener(t, func(c net.Conn) {
		r := bufio.NewReader(c)
		for {
			args, err := readCommand(r)
			if err != nil {
				return
			}
			switch strings.ToUpper(args[0]) {
			case "AUTH":
				if args[len(args)-1] == password {
					c.Write([]byte("+OK\r\n"))
				} else {
					c.Write([]byte("-WRONGPASS invalid username-password pair or user is disabled.\r\n"))
				}
			case "INFO":
				info := "# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:100\r\n# Clients\r\nconnected_clients:3\r\nrole:master\r\n" +
					"total_commands_processed:42\r\nused_memory:1024\r\n# Keyspace\r\ndb0:keys=5,expires=1,avg_ttl=0\r\n"
				fmt.Fprintf(c, "$%d\r\n%s\r\n", len(info), info)
			}
		}
	})
}

func readCommand(r *bufio.Reader) ([]string, error) {
	head, err := readLine(r)
	if err != nil {
		return nil, err
	}
	var n int
	fmt.Sscanf(head, "*%d", &n)
	args := make([]string, 0, n)
	for i := 0; i < n; i++ {
		if _, err := readLine(r); err != nil {
			return nil, err
		}
		v, err := readLine(r)
		if err != nil {
			return nil, err
		}
		args = append(args, v)
	}
	return args, nil
}

func TestRedisAuthAndInfo(t *testing.T) {
	port := fakeRedis(t, "s3cret")
	svc := remote.Service{Kind: "redis", Name: "cache", Host: "127.0.0.1", Port: port}
	if _, err := QueryDB(context.Background(), svc, Credentials{Password: "nope"}, false); !errors.Is(err, ErrAuthFailed) {
		t.Errorf("wrong password: %v", err)
	}
	metrics, err := QueryDB(context.Background(), svc, Credentials{User: "yuktiops", Password: "s3cret"}, true)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, m := range metrics {
		key := m.Name
		if db := m.Labels["db"]; db != "" {
			key += "{" + db + "}"
		}
		got[key] = m.Value
	}
	want := map[string]float64{"redis_up": 1, "redis_connected_clients": 3, "redis_commands_processed_total": 42,
		"redis_memory_used_bytes": 1024, "redis_db_keys{db0}": 5, "redis_db_keys_expiring{db0}": 1, "redis_instance_info": 1}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v (all: %v)", k, got[k], v, got)
		}
	}
	// URL form.
	if _, err := QueryDB(context.Background(), remote.Service{Kind: "redis"}, Credentials{URL: fmt.Sprintf("redis://:s3cret@127.0.0.1:%d", port)}, false); err != nil {
		t.Errorf("url: %v", err)
	}
}

func TestSQLLoginFailuresHideSecrets(t *testing.T) {
	for _, kind := range []string{"mysql", "postgres", "mssql"} {
		port := closedPort()
		_, err := QueryDB(context.Background(), remote.Service{Kind: kind, Host: "127.0.0.1", Port: port},
			Credentials{User: "yuktiops", Password: "hunter2"}, false)
		if err == nil {
			t.Errorf("%s: no error against a closed port", kind)
			continue
		}
		d := AuthDetail(err)
		if strings.Contains(err.Error(), "hunter2") || strings.Contains(d, "hunter2") || strings.Contains(d, "yuktiops") {
			t.Errorf("%s: secret in %q / %q", kind, err, d)
		}
		if !strings.HasPrefix(d, "auth check failed") {
			t.Errorf("%s: detail %q", kind, d)
		}
	}
	for _, kind := range []string{"mysql", "postgres", "mssql"} {
		_, dsn, err := dsnFor(kind, "127.0.0.1:1", Credentials{User: "u", Password: "p@ss/w:rd", Database: "app"})
		if err != nil || dsn == "" {
			t.Errorf("%s dsn: %v", kind, err)
		}
	}
}

func TestMySQLStatusNames(t *testing.T) {
	if v, ok := parseStatusValue("ON"); !ok || v != 1 {
		t.Error("ON")
	}
	if _, ok := parseStatusValue("abc"); ok {
		t.Error("non-numeric accepted")
	}
	if sanitizeName("Innodb_Buffer-Pool") != "innodb_buffer_pool" {
		t.Error(sanitizeName("Innodb_Buffer-Pool"))
	}
}
