//go:build linux

package prom

import (
	"fmt"
	"io"
	"log/slog"
	"sync"

	"github.com/alecthomas/kingpin/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/node_exporter/collector"

	"github.com/yuktiops/agent/internal/config"
)

// NodeSupported reports whether node metrics can be collected on this OS.
const NodeSupported = true

// nodeCollectors are the node_exporter collectors the Node Exporter Full dashboard uses. On Linux
// node_boot_time_seconds comes from "stat" (the "boottime" collector is BSD only).
var nodeCollectors = []string{
	"cpu", "meminfo", "diskstats", "filesystem", "netdev", "netclass", "netstat", "sockstat",
	"softnet", "arp", "conntrack", "filefd", "loadavg", "pressure", "schedstat", "stat",
	"processes", "time", "uname", "vmstat",
}

var (
	nodeOnce sync.Once
	nodeErr  error
	node     prometheus.Collector
)

// newNodeCollector returns the embedded node_exporter. Its settings are global kingpin flags, so
// they are parsed once, from a fixed argument list built here (never from the command line).
// The paths point at the host root, so the same code works in the Docker agent.
func newNodeCollector(hostRoot string) (prometheus.Collector, error) {
	nodeOnce.Do(func() {
		args := []string{
			"--path.procfs=" + config.HostPath(hostRoot, "/proc"),
			"--path.sysfs=" + config.HostPath(hostRoot, "/sys"),
			"--path.rootfs=" + config.HostPath(hostRoot, "/"),
			"--path.udev.data=" + config.HostPath(hostRoot, "/run/udev/data"),
			"--collector.processes", // off by default in node_exporter
		}
		app := kingpin.CommandLine
		app.Terminate(nil) // never os.Exit from inside the agent
		app.ErrorWriter(io.Discard)
		app.UsageWriter(io.Discard)
		if _, err := app.Parse(args); err != nil {
			nodeErr = fmt.Errorf("node metrics: %v", err)
			return
		}
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		nc, err := collector.NewNodeCollector(logger, nodeCollectors...)
		if err != nil {
			nodeErr = fmt.Errorf("node metrics: %v", err)
			return
		}
		node = nc
	})
	return node, nodeErr
}
