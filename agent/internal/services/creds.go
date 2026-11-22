package services

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/yuktiops/agent/internal/remote"
)

// Credentials are the database login details for one credentialsRef. They are read from this
// machine only (never from YuktiOps) and must never be logged or sent anywhere except to the
// database itself.
type Credentials struct {
	URL      string
	User     string
	Password string
	Database string
	SSLMode  string
}

// String hides the secret, so a credential printed by mistake leaks nothing.
func (c Credentials) String() string { return "credentials(redacted)" }

// GoString hides the secret from %#v as well.
func (c Credentials) GoString() string { return c.String() }

// The fixed status details of credential problems (shown in the dashboard).
var (
	ErrCredentialsNotFound = errors.New("credentials not found")
	ErrCredentialsMode     = errors.New("credentials file must be 0600")
)

const maxCredFile = 16 << 10

// CredentialStore finds the credentials for a credentialsRef: first the environment
// (YUKTIOPS_CRED_<REF>_URL, or _USER with _PASSWORD), then <Dir>/<ref>.env.
type CredentialStore struct {
	Dir    string // <configDir>/credentials.d
	Getenv func(string) string
}

// NewCredentialStore looks in configDir/credentials.d and the process environment.
func NewCredentialStore(configDir string) *CredentialStore {
	return &CredentialStore{Dir: filepath.Join(configDir, "credentials.d"), Getenv: os.Getenv}
}

// EnvPrefix is the environment variable prefix for a ref: redis-main -> YUKTIOPS_CRED_REDIS_MAIN_.
func EnvPrefix(ref string) string {
	return "YUKTIOPS_CRED_" + strings.ReplaceAll(strings.ToUpper(ref), "-", "_") + "_"
}

// Load returns the credentials for ref, or ErrCredentialsNotFound / ErrCredentialsMode.
func (s *CredentialStore) Load(ref string) (Credentials, error) {
	if s == nil || !remote.ValidCredentialsRef(ref) {
		return Credentials{}, ErrCredentialsNotFound
	}
	getenv := s.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	p := EnvPrefix(ref)
	env := Credentials{
		URL: getenv(p + "URL"), User: getenv(p + "USER"), Password: getenv(p + "PASSWORD"),
		Database: getenv(p + "DATABASE"), SSLMode: getenv(p + "SSLMODE"),
	}
	// USER with PASSWORD is the documented form; PASSWORD alone is also accepted (a Redis
	// server with only requirepass has no user name).
	if env.URL != "" || env.Password != "" {
		return env, nil
	}
	if s.Dir == "" {
		return Credentials{}, ErrCredentialsNotFound
	}
	path := filepath.Join(s.Dir, ref+".env")
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return Credentials{}, ErrCredentialsNotFound
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&^0o600 != 0 {
		return Credentials{}, ErrCredentialsMode
	}
	if info.Size() > maxCredFile {
		return Credentials{}, fmt.Errorf("credentials file is too large")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return Credentials{}, errors.New("credentials file is not readable by the agent")
		}
		return Credentials{}, ErrCredentialsNotFound
	}
	c := parseEnvFile(data)
	if c.URL == "" && c.Password == "" && c.User == "" {
		return Credentials{}, ErrCredentialsNotFound
	}
	return c, nil
}

// parseEnvFile reads KEY=VALUE lines (# comments, optional "export " and quotes).
func parseEnvFile(data []byte) Credentials {
	var c Credentials
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.ToUpper(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"') {
			if u, err := strconv.Unquote(value); err == nil {
				value = u
			} else {
				value = value[1 : len(value)-1]
			}
		} else if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
			value = value[1 : len(value)-1]
		}
		switch key {
		case "URL":
			c.URL = value
		case "USER":
			c.User = value
		case "PASSWORD":
			c.Password = value
		case "DATABASE":
			c.Database = value
		case "SSLMODE":
			c.SSLMode = value
		}
	}
	return c
}
