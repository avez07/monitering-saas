// Package docker lists containers through the local Docker socket.
//
// It is opt-in and strictly read-only: only GET requests are ever made (enforced by the transport,
// see readOnly), and only these endpoints are used: container list, inspect, one-shot stats, and
// (when container logs are switched on, see logs.go) container logs and events.
// The standard library is enough; no Docker SDK is linked in.
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	DefaultSocket   = "/var/run/docker.sock"
	MaxContainers   = 100 // the ingest limit
	concurrency     = 4
	requestTimeout  = 5 * time.Second
	collectTimeout  = 20 * time.Second
	maxResponseSize = 8 << 20
)

// Container is one entry of the ingest payload's "containers" array.
type Container struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Image            string   `json:"image"`
	State            string   `json:"state"`
	Status           string   `json:"status,omitempty"`
	RestartCount     int      `json:"restartCount"`
	CPUPercent       *float64 `json:"cpuPercent,omitempty"`
	MemoryBytes      *float64 `json:"memoryBytes,omitempty"`
	MemoryLimitBytes *float64 `json:"memoryLimitBytes,omitempty"`
	StartedAt        string   `json:"startedAt,omitempty"`
	OOMKilled        bool     `json:"oomKilled"`
}

// ErrDenied means the socket exists but this user may not use it (reported as docker_socket_denied).
var ErrDenied = errors.New("permission denied on the Docker socket")

// ErrUnavailable means there is no Docker daemon behind the socket.
var ErrUnavailable = errors.New("the Docker socket is not available")

type cpuSample struct {
	total, system uint64
}

// Collector keeps the previous CPU counters per container. Use it from one goroutine.
type Collector struct {
	Socket string
	client *http.Client
	prev   map[string]cpuSample

	mu       sync.Mutex
	requests []string
}

// readOnly refuses everything except GET, whatever the caller asks for.
type readOnly struct {
	next http.RoundTripper
	c    *Collector
}

func (r readOnly) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != http.MethodGet {
		return nil, fmt.Errorf("docker: refusing %s request (the agent is read-only)", req.Method)
	}
	r.c.mu.Lock()
	r.c.requests = append(r.c.requests, req.Method+" "+req.URL.RequestURI())
	r.c.mu.Unlock()
	return r.next.RoundTrip(req)
}

// New returns a collector for the socket path (DefaultSocket when empty).
func New(socket string) *Collector {
	if socket == "" {
		socket = DefaultSocket
	}
	c := &Collector{Socket: socket, prev: map[string]cpuSample{}}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives:     true,
		DisableCompression:    true,
		ResponseHeaderTimeout: requestTimeout,
		MaxConnsPerHost:       concurrency + 1,
	}
	c.client = &http.Client{Transport: readOnly{next: tr, c: c}, Timeout: requestTimeout}
	return c
}

func (c *Collector) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	res, err := c.client.Do(req)
	if err != nil {
		return classify(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		if res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusUnauthorized {
			return ErrDenied
		}
		return fmt.Errorf("docker answered %d for %s", res.StatusCode, strings.SplitN(path, "?", 2)[0])
	}
	return json.NewDecoder(io.LimitReader(res.Body, maxResponseSize)).Decode(out)
}

func classify(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	switch {
	case errors.Is(err, os.ErrPermission), errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return ErrDenied
	case errors.Is(err, os.ErrNotExist), errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ENOENT):
		return ErrUnavailable
	}
	return err
}

type listEntry struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

type inspectDoc struct {
	RestartCount int `json:"RestartCount"`
	Config       struct {
		Tty bool `json:"Tty"`
	} `json:"Config"`
	State struct {
		StartedAt string `json:"StartedAt"`
		OOMKilled bool   `json:"OOMKilled"`
	} `json:"State"`
	HostConfig struct {
		Memory int64 `json:"Memory"`
	} `json:"HostConfig"`
}

type statsDoc struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

// MemoryUsed is the usage `docker stats` shows: usage minus the page cache.
func MemoryUsed(usage uint64, stats map[string]uint64) uint64 {
	for _, key := range []string{"inactive_file", "total_inactive_file", "cache"} {
		if v, ok := stats[key]; ok {
			if v > usage {
				return 0
			}
			return usage - v
		}
	}
	return usage
}

// CPUPercent computes percent of one core from the change in counters since prev.
// ok is false when there is nothing to compare with or the counters went backwards.
func CPUPercent(prevTotal, prevSystem, total, system uint64, cpus int) (float64, bool) {
	if system <= prevSystem || total < prevTotal || cpus <= 0 {
		return 0, false
	}
	p := float64(total-prevTotal) / float64(system-prevSystem) * float64(cpus) * 100
	return float64(int64(p*100+0.5)) / 100, true
}

func f(v float64) *float64 { return &v }

// Collect returns the complete list of containers (at most MaxContainers, running ones first).
// On an error it returns nil and the caller should omit the field, so stored data is left alone.
func (c *Collector) Collect(ctx context.Context) ([]Container, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()
	var list []listEntry
	if err := c.get(ctx, "/containers/json?all=1", &list); err != nil {
		return nil, err
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].State == "running" && list[j].State != "running" })
	if len(list) > MaxContainers {
		list = list[:MaxContainers]
	}
	out := make([]Container, len(list))
	newPrev := make(map[string]cpuSample, len(list))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)
	for i, e := range list {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, e listEntry) {
			defer wg.Done()
			defer func() { <-sem }()
			ct := Container{ID: shortID(e.ID), Image: e.Image, State: e.State, Status: e.Status}
			if len(e.Names) > 0 {
				ct.Name = strings.TrimPrefix(e.Names[0], "/")
			}
			if ct.Name == "" {
				ct.Name = ct.ID
			}
			var in inspectDoc
			if err := c.get(ctx, "/containers/"+e.ID+"/json", &in); err == nil {
				ct.RestartCount = in.RestartCount
				ct.OOMKilled = in.State.OOMKilled
				if t, err := time.Parse(time.RFC3339Nano, in.State.StartedAt); err == nil && t.Year() > 1 {
					ct.StartedAt = t.UTC().Format("2006-01-02T15:04:05.000Z")
				}
				if in.HostConfig.Memory > 0 {
					ct.MemoryLimitBytes = f(float64(in.HostConfig.Memory))
				}
			}
			if e.State == "running" {
				var st statsDoc
				if err := c.get(ctx, "/containers/"+e.ID+"/stats?stream=false&one-shot=true", &st); err == nil {
					ct.MemoryBytes = f(float64(MemoryUsed(st.MemoryStats.Usage, st.MemoryStats.Stats)))
					cpus := st.CPUStats.OnlineCPUs
					if cpus == 0 {
						cpus = len(st.CPUStats.CPUUsage.PercpuUsage)
					}
					cur := cpuSample{st.CPUStats.CPUUsage.TotalUsage, st.CPUStats.SystemUsage}
					mu.Lock()
					prev, have := c.prev[e.ID]
					newPrev[e.ID] = cur
					mu.Unlock()
					if !have && st.PreCPUStats.SystemUsage > 0 {
						prev, have = cpuSample{st.PreCPUStats.CPUUsage.TotalUsage, st.PreCPUStats.SystemUsage}, true
					}
					if have {
						if p, ok := CPUPercent(prev.total, prev.system, cur.total, cur.system, cpus); ok {
							ct.CPUPercent = f(p)
						}
					}
				}
			}
			out[i] = ct
		}(i, e)
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.prev = newPrev
	return out, nil
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// Requests lists the requests made so far ("GET /path"), for tests.
func (c *Collector) Requests() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.requests...)
}
