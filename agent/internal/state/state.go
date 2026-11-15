// Package state is the small status file the running agent keeps in its state directory. It is
// what `yuktiops-agent status` and `doctor` read; it contains no secrets and is world-readable.
package state

import (
	"encoding/json"
	"os"
	"time"
)

// Connection values.
const (
	Starting     = "starting"     // running, nothing sent yet
	Connected    = "connected"    // the last send succeeded
	Retrying     = "retrying"     // sends are failing (network or server trouble); data is buffered
	Disconnected = "disconnected" // the backend refused the credential (revoked or server removed)
	Stopped      = "stopped"      // the agent shut down cleanly
)

// State is written after every send attempt.
type State struct {
	PID       int       `json:"pid"`
	Version   string    `json:"version"`
	APIURL    string    `json:"apiUrl"`
	Name      string    `json:"name,omitempty"`
	StartedAt time.Time `json:"startedAt"`
	UpdatedAt time.Time `json:"updatedAt"`

	Connection          string     `json:"connection"`
	LastAttemptAt       *time.Time `json:"lastAttemptAt,omitempty"`
	LastSuccessAt       *time.Time `json:"lastSuccessAt,omitempty"`
	LastError           string     `json:"lastError,omitempty"`
	LastErrorCode       string     `json:"lastErrorCode,omitempty"`
	LastErrorAt         *time.Time `json:"lastErrorAt,omitempty"`
	ConsecutiveFailures int        `json:"consecutiveFailures"`
	NextRetryAt         *time.Time `json:"nextRetryAt,omitempty"`

	Buffered         int        `json:"buffered"`
	OldestBufferedAt *time.Time `json:"oldestBufferedAt,omitempty"`

	// ClockOffsetSeconds is the server's clock minus this machine's, measured on the last
	// successful send. Only set when it is large enough to matter.
	ClockOffsetSeconds float64 `json:"clockOffsetSeconds,omitempty"`

	ConfigID              string `json:"configId,omitempty"`
	ConfigVersion         int    `json:"configVersion,omitempty"`
	SendIntervalSeconds   int    `json:"sendIntervalSeconds"`
	SampleIntervalSeconds int    `json:"sampleIntervalSeconds"`
}

// Load reads the status file.
func Load(path string) (State, error) {
	var s State
	data, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}

// Save writes the status file atomically, readable by everyone.
func Save(path string, s State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
