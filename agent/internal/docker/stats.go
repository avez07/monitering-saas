package docker

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

// Stats are the raw, cumulative counters of one running container, for the cAdvisor-named
// Prometheus metrics.
type Stats struct {
	ID       string // full container id
	Name     string
	Image    string
	Started  time.Time
	CPUTotal float64 // seconds of CPU used since the container started
	// WorkingSet is usage minus inactive page cache (what cAdvisor calls the working set).
	WorkingSet  float64
	MemoryLimit float64 // 0 when the container has no limit
	Networks    map[string]NetStats
}

// NetStats are the byte counters of one container interface.
type NetStats struct {
	RxBytes, TxBytes float64
}

type rawStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"` // nanoseconds
		} `json:"cpu_usage"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

// Stats returns the counters of every running container (at most MaxContainers).
func (c *Collector) Stats(ctx context.Context) ([]Stats, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()
	var list []listEntry
	if err := c.get(ctx, "/containers/json", &list); err != nil { // running only
		return nil, err
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	if len(list) > MaxContainers {
		list = list[:MaxContainers]
	}
	out := make([]Stats, len(list))
	ok := make([]bool, len(list))
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)
	for i, e := range list {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, e listEntry) {
			defer wg.Done()
			defer func() { <-sem }()
			s := Stats{ID: e.ID, Image: e.Image}
			if len(e.Names) > 0 {
				s.Name = strings.TrimPrefix(e.Names[0], "/")
			}
			if s.Name == "" {
				s.Name = shortID(e.ID)
			}
			var in inspectDoc
			if err := c.get(ctx, "/containers/"+e.ID+"/json", &in); err == nil {
				if t, err := time.Parse(time.RFC3339Nano, in.State.StartedAt); err == nil && t.Year() > 1 {
					s.Started = t
				}
				if in.HostConfig.Memory > 0 {
					s.MemoryLimit = float64(in.HostConfig.Memory)
				}
			}
			var st rawStats
			if err := c.get(ctx, "/containers/"+e.ID+"/stats?stream=false&one-shot=true", &st); err != nil {
				return
			}
			s.CPUTotal = float64(st.CPUStats.CPUUsage.TotalUsage) / 1e9
			s.WorkingSet = float64(MemoryUsed(st.MemoryStats.Usage, st.MemoryStats.Stats))
			if len(st.Networks) > 0 {
				s.Networks = make(map[string]NetStats, len(st.Networks))
				for name, n := range st.Networks {
					s.Networks[name] = NetStats{RxBytes: float64(n.RxBytes), TxBytes: float64(n.TxBytes)}
				}
			}
			out[i], ok[i] = s, true
		}(i, e)
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	res := out[:0]
	for i := range out {
		if ok[i] {
			res = append(res, out[i])
		}
	}
	return res, nil
}
