// Package remote validates the settings the agent pulls from YuktiOps.
//
// Security boundary: remote settings can only switch the agent's built-in, read-only collectors
// on or off and change how often it samples and sends. Nothing received from the server is ever
// executed, used as a path, or passed to a shell. Fields this package does not know are ignored,
// values of the wrong type make the whole config be rejected, and out-of-range intervals are
// clamped to the limits below.
package remote

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Interval limits, identical to the backend's agentSettingsSchema.
const (
	MinSendSeconds   = 15
	MaxSendSeconds   = 300
	MinSampleSeconds = 5
	MaxSampleSeconds = 60

	DefaultSendSeconds   = 30
	DefaultSampleSeconds = 10

	// Prometheus remote_write (premium plans only).
	MinScrapeSeconds     = 15
	MaxScrapeSeconds     = 60
	DefaultScrapeSeconds = 15
	DefaultPromPath      = "/v1/prom/write"

	// MaxLogContainers bounds containerLogs.include and containerLogs.exclude.
	MaxLogContainers = 100
)

// Collectors says which built-in collectors run. These are the only switches a server can flip.
type Collectors struct {
	CPU       bool `json:"cpu"`
	Memory    bool `json:"memory"`
	Swap      bool `json:"swap"`
	Disk      bool `json:"disk"`
	DiskIO    bool `json:"diskIo"`
	Network   bool `json:"network"`
	Load      bool `json:"load"`
	Processes bool `json:"processes"`
	// Docker is opt-in (default false): list containers through the local Docker socket.
	Docker bool `json:"docker"`
	// Services are the things to check on every send (names, ports and local URLs only).
	Services []Service `json:"services"`
	// Prometheus is set by the backend from the plan (promMetrics). It switches on the
	// node_exporter / cAdvisor style metrics sent with Prometheus remote_write.
	Prometheus bool `json:"prometheus"`
	// ContainerLogs tails container logs and sends them as OTLP logs (all plans).
	ContainerLogs ContainerLogs `json:"containerLogs"`
}

// ContainerLogs says which containers' logs are collected. Empty Include means every running
// container; Exclude (and the Docker label yuktiops.logs=false) always wins.
type ContainerLogs struct {
	Enabled bool     `json:"enabled"`
	Include []string `json:"include"`
	Exclude []string `json:"exclude"`
}

// Prometheus configures remote_write. It is only used when Collectors.Prometheus is true.
type Prometheus struct {
	// Path is relative to the agent's API base URL.
	Path                  string `json:"path"`
	ScrapeIntervalSeconds int    `json:"scrapeIntervalSeconds"`
}

// MaxServices matches the backend limit.
const MaxServices = 50

// Service is one configured service check.
type Service struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
	Port int    `json:"port,omitempty"`
	Host string `json:"host,omitempty"`
	URL  string `json:"url,omitempty"`
	// CredentialsRef names local credentials (environment or credentials.d/<ref>.env). The secret
	// itself never comes from the server.
	CredentialsRef string `json:"credentialsRef,omitempty"`
}

// Settings is the validated, in-range result.
type Settings struct {
	SendIntervalSeconds   int        `json:"sendIntervalSeconds"`
	SampleIntervalSeconds int        `json:"sampleIntervalSeconds"`
	Collectors            Collectors `json:"collectors"`
	Prometheus            Prometheus `json:"prometheus"`
}

// Config is a setup profile as served by GET /v1/config.
type Config struct {
	ID       string   `json:"id"`
	Version  int      `json:"version"`
	Settings Settings `json:"settings"`
	// Plan is the optional display name of the organization's plan, only used in log messages.
	Plan string `json:"plan,omitempty"`
}

// DefaultSettings is what the agent uses until it has pulled its profile.
func DefaultSettings() Settings {
	return Settings{
		SendIntervalSeconds:   DefaultSendSeconds,
		SampleIntervalSeconds: DefaultSampleSeconds,
		Collectors: Collectors{
			CPU: true, Memory: true, Swap: true, Disk: true,
			DiskIO: true, Network: true, Load: true, Processes: true,
		},
		Prometheus: Prometheus{Path: DefaultPromPath, ScrapeIntervalSeconds: DefaultScrapeSeconds},
	}
}

var configID = regexp.MustCompile(`^st_[a-f0-9]{24}$`)

// ValidID reports whether id looks like a setup profile id.
func ValidID(id string) bool { return configID.MatchString(id) }

// The wire shapes use pointers so that "missing" and "false"/0 can be told apart. Unknown fields
// are dropped by encoding/json, which is exactly the rule: anything else the server sends is ignored.
type wireCollectors struct {
	CPU       *bool           `json:"cpu"`
	Memory    *bool           `json:"memory"`
	Swap      *bool           `json:"swap"`
	Disk      *bool           `json:"disk"`
	DiskIO    *bool           `json:"diskIo"`
	Network   *bool           `json:"network"`
	Load      *bool           `json:"load"`
	Processes *bool           `json:"processes"`
	Docker    *bool           `json:"docker"`
	Services  json.RawMessage `json:"services"`
	Prom      *bool           `json:"prometheus"`
	Logs      *wireLogs       `json:"containerLogs"`
}

type wireLogs struct {
	Enabled *bool    `json:"enabled"`
	Include []string `json:"include"`
	Exclude []string `json:"exclude"`
}

type wireProm struct {
	Path                  *string `json:"path"`
	ScrapeIntervalSeconds *int    `json:"scrapeIntervalSeconds"`
}

type wireSettings struct {
	SendIntervalSeconds   *int            `json:"sendIntervalSeconds"`
	SampleIntervalSeconds *int            `json:"sampleIntervalSeconds"`
	Collectors            *wireCollectors `json:"collectors"`
	Prometheus            *wireProm       `json:"prometheus"`
}

type wireConfig struct {
	ID       string          `json:"id"`
	Version  *int            `json:"version"`
	Settings *wireSettings   `json:"settings"`
	Plan     json.RawMessage `json:"plan"`
}

// Parse validates a config document. notes lists every value that had to be adjusted.
func Parse(data []byte) (cfg Config, notes []string, err error) {
	var w wireConfig
	if err := json.Unmarshal(data, &w); err != nil {
		return Config{}, nil, fmt.Errorf("settings are not in the expected format: %v", err)
	}
	if !ValidID(w.ID) {
		return Config{}, nil, errors.New("settings have no valid profile id")
	}
	if w.Version == nil || *w.Version < 1 {
		return Config{}, nil, errors.New("settings have no valid version")
	}
	if w.Settings == nil {
		return Config{}, nil, errors.New("settings are missing")
	}
	settings, notes, err := normalize(*w.Settings)
	if err != nil {
		return Config{}, nil, err
	}
	return Config{ID: w.ID, Version: *w.Version, Settings: settings, Plan: planName(w.Plan)}, notes, nil
}

var planNameRe = regexp.MustCompile(`^[A-Za-z0-9 ._+-]{1,40}$`)

// planName accepts "Pro" or {"name":"Pro"} (or {"id":"pro"}); anything else is ignored. It is
// only ever printed in a log line.
func planName(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var name string
	if json.Unmarshal(raw, &name) != nil {
		var obj struct {
			Name string `json:"name"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(raw, &obj) != nil {
			return ""
		}
		name = obj.Name
		if name == "" {
			name = obj.ID
		}
	}
	name = strings.TrimSpace(name)
	if !planNameRe.MatchString(name) {
		return ""
	}
	return name
}

func normalize(w wireSettings) (Settings, []string, error) {
	s := DefaultSettings()
	var notes []string
	clamp := func(name string, v *int, lo, hi, def int) int {
		if v == nil {
			return def
		}
		switch {
		case *v < lo:
			notes = append(notes, fmt.Sprintf("%s %d is below the minimum, using %d", name, *v, lo))
			return lo
		case *v > hi:
			notes = append(notes, fmt.Sprintf("%s %d is above the maximum, using %d", name, *v, hi))
			return hi
		}
		return *v
	}
	s.SendIntervalSeconds = clamp("sendIntervalSeconds", w.SendIntervalSeconds, MinSendSeconds, MaxSendSeconds, DefaultSendSeconds)
	s.SampleIntervalSeconds = clamp("sampleIntervalSeconds", w.SampleIntervalSeconds, MinSampleSeconds, MaxSampleSeconds, DefaultSampleSeconds)
	if s.SampleIntervalSeconds > s.SendIntervalSeconds {
		notes = append(notes, fmt.Sprintf("sampleIntervalSeconds %d is longer than sendIntervalSeconds, using %d",
			s.SampleIntervalSeconds, s.SendIntervalSeconds))
		s.SampleIntervalSeconds = s.SendIntervalSeconds
	}
	if c := w.Collectors; c != nil {
		set := func(dst *bool, src *bool) {
			if src != nil {
				*dst = *src
			}
		}
		set(&s.Collectors.CPU, c.CPU)
		set(&s.Collectors.Memory, c.Memory)
		set(&s.Collectors.Swap, c.Swap)
		set(&s.Collectors.Disk, c.Disk)
		set(&s.Collectors.DiskIO, c.DiskIO)
		set(&s.Collectors.Network, c.Network)
		set(&s.Collectors.Load, c.Load)
		set(&s.Collectors.Processes, c.Processes)
		set(&s.Collectors.Docker, c.Docker)
		if len(c.Services) > 0 && string(c.Services) != "null" {
			list, err := parseServices(c.Services)
			if err != nil {
				return s, nil, err
			}
			s.Collectors.Services = list
		}
		set(&s.Collectors.Prometheus, c.Prom)
		if l := c.Logs; l != nil {
			set(&s.Collectors.ContainerLogs.Enabled, l.Enabled)
			var err error
			if s.Collectors.ContainerLogs.Include, err = containerNames("include", l.Include); err != nil {
				return s, nil, err
			}
			if s.Collectors.ContainerLogs.Exclude, err = containerNames("exclude", l.Exclude); err != nil {
				return s, nil, err
			}
		}
	}
	if p := w.Prometheus; p != nil {
		if p.Path != nil {
			if !validPromPath(*p.Path) {
				return s, nil, errors.New("prometheus.path must be a path such as /v1/prom/write")
			}
			s.Prometheus.Path = *p.Path
		}
		s.Prometheus.ScrapeIntervalSeconds = clamp("prometheus.scrapeIntervalSeconds", p.ScrapeIntervalSeconds,
			MinScrapeSeconds, MaxScrapeSeconds, DefaultScrapeSeconds)
	}
	return s, notes, nil
}

var (
	promPathRe      = regexp.MustCompile(`^/[A-Za-z0-9_./-]{1,199}$`)
	containerNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
)

// validPromPath allows only a plain absolute path on the API host: no scheme, host, query,
// "..", or "//" (which would let a server point the agent at another host).
func validPromPath(p string) bool {
	return promPathRe.MatchString(p) && !strings.Contains(p, "..") && !strings.Contains(p, "//")
}

// containerNames validates a containerLogs list. Empty lists are returned as nil.
func containerNames(field string, in []string) ([]string, error) {
	if len(in) > MaxLogContainers {
		return nil, fmt.Errorf("collectors.containerLogs.%s has %d entries; the limit is %d", field, len(in), MaxLogContainers)
	}
	var out []string
	seen := map[string]bool{}
	for i, name := range in {
		name = strings.TrimPrefix(strings.TrimSpace(name), "/")
		if !containerNameRe.MatchString(name) {
			return nil, fmt.Errorf("collectors.containerLogs.%s[%d]: invalid container name", field, i)
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out, nil
}

// LoadCache reads the settings cached in the state directory. The cache goes through the same
// validation as a fresh download, so a damaged or tampered file can never widen what the agent does.
func LoadCache(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	cfg, _, err := Parse(data)
	return cfg, err
}

// SaveCache stores the validated settings (never the raw server response).
func SaveCache(path string, cfg Config) error {
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

var (
	serviceNameRe = regexp.MustCompile(`^[A-Za-z0-9 @._:/+-]{1,100}$`)
	hostNameRe    = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,253}$`)
	serviceKinds  = map[string]bool{"systemd": true, "process": true, "port": true, "nginx": true, "apache": true, "mysql": true, "postgres": true, "redis": true, "mssql": true}
	credRefRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)
	// DefaultPorts are the standard ports of the database kinds.
	DefaultPorts = map[string]int{"mysql": 3306, "postgres": 5432, "redis": 6379, "mssql": 1433}
)

// ValidCredentialsRef reports whether ref is an acceptable credentialsRef.
func ValidCredentialsRef(ref string) bool { return credRefRe.MatchString(ref) }

type wireService struct {
	Kind string  `json:"kind"`
	Name string  `json:"name"`
	Port *int    `json:"port"`
	Host *string `json:"host"`
	URL  *string `json:"url"`
	Cred *string `json:"credentialsRef"`
}

// parseServices validates every entry; one bad entry rejects the whole list (config_invalid).
func parseServices(raw json.RawMessage) ([]Service, error) {
	var in []wireService
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, fmt.Errorf("collectors.services is not a list of services: %v", err)
	}
	if len(in) > MaxServices {
		return nil, fmt.Errorf("collectors.services has %d entries; the limit is %d", len(in), MaxServices)
	}
	seen := map[string]bool{}
	out := make([]Service, 0, len(in))
	for i, e := range in {
		fail := func(msg string) error { return fmt.Errorf("collectors.services[%d]: %s", i, msg) }
		if !serviceKinds[e.Kind] {
			return nil, fail("unknown kind")
		}
		name := strings.TrimSpace(e.Name)
		if !serviceNameRe.MatchString(name) {
			return nil, fail("invalid name")
		}
		key := e.Kind + ":" + strings.ToLower(name)
		if seen[key] {
			return nil, fail("duplicate kind and name")
		}
		seen[key] = true
		svc := Service{Kind: e.Kind, Name: name}
		if e.Port != nil {
			if *e.Port < 1 || *e.Port > 65535 {
				return nil, fail("port out of range")
			}
			svc.Port = *e.Port
		}
		if e.Host != nil {
			if !hostNameRe.MatchString(*e.Host) {
				return nil, fail("invalid host")
			}
			svc.Host = *e.Host
		}
		if e.URL != nil {
			u, err := url.Parse(*e.URL)
			if err != nil || len(*e.URL) > 300 || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
				return nil, fail("invalid url")
			}
			svc.URL = *e.URL
		}
		if e.Cred != nil && *e.Cred != "" {
			if !credRefRe.MatchString(*e.Cred) {
				return nil, fail("invalid credentialsRef")
			}
			svc.CredentialsRef = *e.Cred
		}
		switch e.Kind {
		case "port":
			if svc.Port == 0 {
				return nil, fail("port is required")
			}
		case "nginx", "apache":
			if svc.URL == "" {
				return nil, fail("url is required")
			}
		case "mysql", "postgres", "redis", "mssql":
			if svc.Port == 0 {
				svc.Port = DefaultPorts[e.Kind]
			}
		}
		out = append(out, svc)
	}
	return out, nil
}
