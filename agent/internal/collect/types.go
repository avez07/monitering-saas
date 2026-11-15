// Package collect reads system statistics from /proc and /sys. Every collector is read-only:
// it opens files and calls statfs, and nothing else.
package collect

import (
	"math"
	"time"
)

// Point is one data point exactly as POST /v1/ingest expects it (see backend/src/routes/v1.js).
// Optional fields are omitted when their collector is switched off or failed.
type Point struct {
	Time          string    `json:"time"`
	CPU           *float64  `json:"cpu,omitempty"`
	Memory        *float64  `json:"memory,omitempty"`
	Swap          *float64  `json:"swap,omitempty"`
	Disk          *float64  `json:"disk,omitempty"`
	Load          []float64 `json:"load,omitempty"`
	NetRxBps      *float64  `json:"netRxBps,omitempty"`
	NetTxBps      *float64  `json:"netTxBps,omitempty"`
	DiskReadBps   *float64  `json:"diskReadBps,omitempty"`
	DiskWriteBps  *float64  `json:"diskWriteBps,omitempty"`
	UptimeSeconds *float64  `json:"uptimeSeconds,omitempty"`
	Details       *Details  `json:"details,omitempty"`
}

// Details carries the per-mount, per-interface and per-process breakdown.
type Details struct {
	Mounts     []Mount     `json:"mounts,omitempty"`
	Interfaces []Interface `json:"interfaces,omitempty"`
	Processes  []Process   `json:"processes,omitempty"`
}

// Mount is the usage of one real filesystem.
type Mount struct {
	Path       string  `json:"path"`
	Percent    float64 `json:"percent"`
	TotalBytes float64 `json:"totalBytes"`
	UsedBytes  float64 `json:"usedBytes"`
}

// Interface is the traffic of one network interface in bytes per second.
type Interface struct {
	Name  string  `json:"name"`
	RxBps float64 `json:"rxBps"`
	TxBps float64 `json:"txBps"`
}

// Process is one entry of the top-processes list. CPU is a percentage of one core, like top.
type Process struct {
	Name     string  `json:"name"`
	PID      int     `json:"pid"`
	CPU      float64 `json:"cpu"`
	MemBytes float64 `json:"memBytes"`
}

// Limits of the ingest schema. Values are clamped to them so one odd reading can never make the
// backend reject a whole batch.
const (
	MaxMounts      = 32
	MaxInterfaces  = 32
	TopProcesses   = 10
	maxPathLen     = 200
	maxIfaceLen    = 64
	maxProcNameLen = 100
	maxRate        = 1e13
	maxBytes       = 1e16
	maxProcCPU     = 1e5
	maxLoad        = 1e6
	maxUptime      = 1e10
)

// Sample is one raw reading; several of them are averaged into a Point.
type Sample struct {
	Time       time.Time
	CPU        *float64
	Memory     *float64
	Swap       *float64
	Disk       *float64
	Load       []float64
	NetRx      *float64
	NetTx      *float64
	DiskRead   *float64
	DiskWrite  *float64
	Uptime     *float64
	Mounts     []Mount
	Interfaces []Interface
}

// Enabled says which collectors run for a sample.
type Enabled struct {
	CPU, Memory, Swap, Disk, DiskIO, Network, Load bool
}

// Reporter receives collector problems as (code, message). Codes match ^[a-z0-9_]{1,60}$.
type Reporter func(code, message string)

func ptr(v float64) *float64 { return &v }

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func clamp(v, lo, hi float64) float64 {
	if math.IsNaN(v) || v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func percent(v float64) float64 { return round2(clamp(v, 0, 100)) }

// FormatTime renders a timestamp the way the ingest schema wants it (RFC 3339, UTC, milliseconds).
func FormatTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
