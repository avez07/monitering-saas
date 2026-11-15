package config

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// File is the local agent.yaml. It is written by `yuktiops-agent register` and may be edited by
// hand. Keys the agent does not know are ignored, so newer installers can add settings.
type File struct {
	APIURL  string `yaml:"api_url"`
	Name    string `yaml:"name"`
	AgentID string `yaml:"agent_id"`
	SetupID string `yaml:"setup_id"`
	// Proxy is an optional outbound proxy. When empty, HTTPS_PROXY / NO_PROXY are honoured.
	Proxy string `yaml:"proxy"`
}

// ErrNotRegistered means agent.yaml or the credential does not exist yet.
var ErrNotRegistered = errors.New("this server is not registered with YuktiOps yet")

// LoadFile reads and validates agent.yaml.
func LoadFile(path string) (File, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return File{}, ErrNotRegistered
		}
		return File{}, err
	}
	return ParseFile(data)
}

// ParseFile validates the contents of an agent.yaml.
func ParseFile(data []byte) (File, error) {
	var f File
	if err := yaml.Unmarshal(data, &f); err != nil {
		return File{}, fmt.Errorf("agent.yaml is not valid YAML: %v", err)
	}
	if strings.TrimSpace(f.APIURL) == "" {
		f.APIURL = DefaultAPIURL
	}
	api, err := NormalizeAPIURL(f.APIURL)
	if err != nil {
		return File{}, fmt.Errorf("agent.yaml: %v", err)
	}
	f.APIURL = api
	proxy, err := NormalizeProxyURL(f.Proxy)
	if err != nil {
		return File{}, fmt.Errorf("agent.yaml: %v", err)
	}
	f.Proxy = proxy
	f.Name = strings.TrimSpace(f.Name)
	return f, nil
}

// Render produces the commented agent.yaml that register writes.
func (f File) Render() []byte {
	var b strings.Builder
	b.WriteString("# YuktiOps agent configuration, written by `yuktiops-agent register`.\n")
	b.WriteString("# What is collected and how often is managed from your YuktiOps dashboard.\n")
	b.WriteString("# The agent only ever reads system statistics; it never runs commands sent by YuktiOps.\n\n")
	b.WriteString("# Where the agent sends data (HTTPS only).\n")
	fmt.Fprintf(&b, "api_url: %s\n\n", strconv.Quote(f.APIURL))
	b.WriteString("# The name this server was registered with, and its id in your account.\n")
	fmt.Fprintf(&b, "name: %s\n", strconv.Quote(f.Name))
	fmt.Fprintf(&b, "agent_id: %s\n", strconv.Quote(f.AgentID))
	if f.SetupID != "" {
		fmt.Fprintf(&b, "setup_id: %s\n", strconv.Quote(f.SetupID))
	}
	b.WriteString("\n# Optional outbound proxy, for example http://proxy.example.com:3128.\n")
	b.WriteString("# When this is not set, the HTTPS_PROXY and NO_PROXY environment variables are honoured.\n")
	if f.Proxy != "" {
		fmt.Fprintf(&b, "proxy: %s\n", strconv.Quote(f.Proxy))
	} else {
		b.WriteString("# proxy: \"\"\n")
	}
	return []byte(b.String())
}

// LoadCredential reads this server's own credential.
func LoadCredential(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNotRegistered
		}
		return "", err
	}
	cred := strings.TrimSpace(string(data))
	if cred == "" || strings.ContainsAny(cred, " \t\r\n") || len(cred) > 512 {
		return "", fmt.Errorf("the credential file %s is empty or damaged", path)
	}
	return cred, nil
}

// ServiceIDs looks up the uid and gid of the yuktiops system user. ok is false when it does not
// exist (for example on a developer machine).
func ServiceIDs() (uid, gid int, ok bool) {
	u, err := user.Lookup(ServiceUser)
	if err != nil {
		return 0, 0, false
	}
	uid, err1 := strconv.Atoi(u.Uid)
	gid, err2 := strconv.Atoi(u.Gid)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return uid, gid, true
}

// EnsureConfigDir creates the config directory. As root it is made 0750 root:yuktiops, which is
// what the installer creates; otherwise it is private to the current user.
func EnsureConfigDir(dir string) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		if _, gid, ok := ServiceIDs(); ok {
			if err := os.Chown(dir, 0, gid); err != nil {
				return err
			}
			return os.Chmod(dir, 0o750)
		}
	}
	return nil
}

// WriteSecure writes a file atomically with the given mode. As root, the file is given to
// root:yuktiops so the service (which runs as yuktiops) can read it but not change it.
func WriteSecure(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if os.Geteuid() == 0 {
		if _, gid, ok := ServiceIDs(); ok {
			if err := tmp.Chown(0, gid); err != nil {
				return fail(err)
			}
		}
	}
	if err := tmp.Chmod(mode); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// LoadEnvironmentFile applies proxy variables from the optional /etc/yuktiops/environment file
// (the unit's EnvironmentFile) to this process, without overriding variables that are already
// set. This lets `doctor` and `register` see the same proxy settings as the service.
func LoadEnvironmentFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	allowed := map[string]bool{
		"HTTPS_PROXY": true, "https_proxy": true,
		"HTTP_PROXY": true, "http_proxy": true,
		"NO_PROXY": true, "no_proxy": true,
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !found || !allowed[key] {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), "\"'")
		if _, set := os.LookupEnv(key); !set {
			os.Setenv(key, value)
		}
	}
}
