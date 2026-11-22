//go:build !linux

package prom

import "github.com/prometheus/client_golang/prometheus"

// NodeSupported reports whether node metrics can be collected on this OS. node_exporter is
// Linux-first; on Windows and macOS advanced metrics stay off.
const NodeSupported = false

func newNodeCollector(string) (prometheus.Collector, error) { return nil, ErrUnsupported }
