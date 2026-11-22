package prom

import (
	"sort"

	"github.com/yuktiops/agent/internal/docker"
)

// containerSeries turns Docker stats into the cAdvisor metric names the dashboard queries.
func containerSeries(stats []docker.Stats, extra []Label, ms int64) []Series {
	var out []Series
	now := float64(ms) / 1000
	for _, s := range stats {
		own := []Label{{"name", s.Name}, {"id", "/docker/" + s.ID}, {"image", s.Image}}
		add := func(name string, v float64, more ...Label) {
			out = append(out, newSeries(name, append(append([]Label(nil), own...), more...), extra, v, ms))
		}
		add("container_cpu_usage_seconds_total", s.CPUTotal, Label{"cpu", "total"})
		add("container_memory_working_set_bytes", s.WorkingSet)
		add("container_spec_memory_limit_bytes", s.MemoryLimit)
		add("container_last_seen", now)
		if !s.Started.IsZero() {
			add("container_start_time_seconds", float64(s.Started.UnixMilli())/1000)
		}
		ifaces := make([]string, 0, len(s.Networks))
		for name := range s.Networks {
			ifaces = append(ifaces, name)
		}
		sort.Strings(ifaces)
		for _, name := range ifaces {
			n := s.Networks[name]
			add("container_network_receive_bytes_total", n.RxBytes, Label{"interface", name})
			add("container_network_transmit_bytes_total", n.TxBytes, Label{"interface", name})
		}
	}
	return out
}
