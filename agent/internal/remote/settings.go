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
	"os"
	"regexp"
)

// Interval limits, identical to the backend's agentSettingsSchema.
const (
	MinSendSeconds   = 15
	MaxSendSeconds   = 300
	MinSampleSeconds = 5
	MaxSampleSeconds = 60

	DefaultSendSeconds   = 30
	DefaultSampleSeconds = 10
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
}

// Settings is the validated, in-range result.
type Settings struct {
	SendIntervalSeconds   int        `json:"sendIntervalSeconds"`
	SampleIntervalSeconds int        `json:"sampleIntervalSeconds"`
	Collectors            Collectors `json:"collectors"`
}

// Config is a setup profile as served by GET /v1/config.
type Config struct {
	ID       string   `json:"id"`
	Version  int      `json:"version"`
	Settings Settings `json:"settings"`
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
	}
}

var configID = regexp.MustCompile(`^st_[a-f0-9]{24}$`)

// ValidID reports whether id looks like a setup profile id.
func ValidID(id string) bool { return configID.MatchString(id) }

// The wire shapes use pointers so that "missing" and "false"/0 can be told apart. Unknown fields
// are dropped by encoding/json, which is exactly the rule: anything else the server sends is ignored.
type wireCollectors struct {
	CPU       *bool `json:"cpu"`
	Memory    *bool `json:"memory"`
	Swap      *bool `json:"swap"`
	Disk      *bool `json:"disk"`
	DiskIO    *bool `json:"diskIo"`
	Network   *bool `json:"network"`
	Load      *bool `json:"load"`
	Processes *bool `json:"processes"`
}

type wireSettings struct {
	SendIntervalSeconds   *int            `json:"sendIntervalSeconds"`
	SampleIntervalSeconds *int            `json:"sampleIntervalSeconds"`
	Collectors            *wireCollectors `json:"collectors"`
}

type wireConfig struct {
	ID       string        `json:"id"`
	Version  *int          `json:"version"`
	Settings *wireSettings `json:"settings"`
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
	settings, notes := normalize(*w.Settings)
	return Config{ID: w.ID, Version: *w.Version, Settings: settings}, notes, nil
}

func normalize(w wireSettings) (Settings, []string) {
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
	}
	return s, notes
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
