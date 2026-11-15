// Package config holds everything the agent reads from its own machine: where its files live,
// the local agent.yaml, the per-server credential and the machine fingerprint.
package config

import (
	"os"
	"path/filepath"
)

const (
	// DefaultConfigDir is created by the installer as 0750 root:yuktiops.
	DefaultConfigDir = "/etc/yuktiops"
	// DefaultStateDir is owned by the yuktiops user (offline buffer, cached settings, status).
	DefaultStateDir = "/var/lib/yuktiops"
	// DefaultAPIURL is used when neither --api, YUKTIOPS_API_URL nor agent.yaml names one.
	DefaultAPIURL = "https://api.yuktiops.com"

	ServiceUser = "yuktiops"
	ServiceName = "yuktiops-agent"

	EnvConfigDir = "YUKTIOPS_CONFIG_DIR"
	EnvStateDir  = "YUKTIOPS_STATE_DIR"
	EnvAPIURL    = "YUKTIOPS_API_URL"
	EnvAPIKey    = "YUKTIOPS_API_KEY"
)

// Paths says where the agent keeps its files. Both directories can be overridden (flag, then
// environment variable, then the default) so the agent can run without root during development.
type Paths struct {
	ConfigDir string
	StateDir  string
}

// ResolvePaths applies the precedence flag > environment > default.
func ResolvePaths(flagConfigDir, flagStateDir string) Paths {
	pick := func(flag, env, def string) string {
		if flag != "" {
			return filepath.Clean(flag)
		}
		if v := os.Getenv(env); v != "" {
			return filepath.Clean(v)
		}
		return def
	}
	return Paths{
		ConfigDir: pick(flagConfigDir, EnvConfigDir, DefaultConfigDir),
		StateDir:  pick(flagStateDir, EnvStateDir, DefaultStateDir),
	}
}

// IsDefault reports whether the standard system locations are in use.
func (p Paths) IsDefault() bool {
	return p.ConfigDir == DefaultConfigDir && p.StateDir == DefaultStateDir
}

func (p Paths) ConfigFile() string      { return filepath.Join(p.ConfigDir, "agent.yaml") }
func (p Paths) CredentialFile() string  { return filepath.Join(p.ConfigDir, "credential") }
func (p Paths) MachineIDFile() string   { return filepath.Join(p.ConfigDir, "machine-id") }
func (p Paths) EnvironmentFile() string { return filepath.Join(p.ConfigDir, "environment") }

func (p Paths) StateFile() string        { return filepath.Join(p.StateDir, "state.json") }
func (p Paths) BufferFile() string       { return filepath.Join(p.StateDir, "buffer.jsonl") }
func (p Paths) RemoteConfigFile() string { return filepath.Join(p.StateDir, "remote-config.json") }

// ConfigFiles and StateFiles list every file the agent itself creates, so uninstall can remove
// exactly those and nothing else.
func (p Paths) ConfigFiles() []string {
	return []string{p.ConfigFile(), p.CredentialFile(), p.MachineIDFile(), p.EnvironmentFile()}
}

func (p Paths) StateFiles() []string {
	return []string{p.StateFile(), p.BufferFile(), p.RemoteConfigFile()}
}
