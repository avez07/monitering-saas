package prom

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/yuktiops/agent/internal/backoff"
	"github.com/yuktiops/agent/internal/client"
	"github.com/yuktiops/agent/internal/docker"
	"github.com/yuktiops/agent/internal/remote"
	"github.com/yuktiops/agent/internal/services"
)

// ErrUnsupported means node metrics cannot be collected on this OS (only Linux is supported).
var ErrUnsupported = errors.New("advanced metrics need a Linux host")

// ErrNotEntitled is returned by Run when the API answers 402: the plan does not include
// advanced metrics. The caller keeps the collector off until the settings change.
var ErrNotEntitled = errors.New("the plan does not include advanced metrics (HTTP 402)")

const (
	// maxSeriesPerRequest keeps every request far below the API's 4 MB limit.
	maxSeriesPerRequest = 5000
	// The unsent queue is bounded: the oldest requests are dropped first.
	maxQueued      = 20
	maxQueuedBytes = 16 << 20
	maxRetryAfter  = 5 * time.Minute
	dbConcurrency  = 4
)

// Poster sends a request body to the API (client.Client.Post).
type Poster interface {
	Post(ctx context.Context, path, bearer string, body []byte, headers map[string]string) (*client.Response, error)
}

// Options configure a Collector.
type Options struct {
	Poster     Poster
	Credential func() string
	Path       string        // remote_write path on the API host
	Interval   time.Duration // scrape interval

	AgentID  string // instance label
	NodeName string // nodename label
	HostRoot string // where the host's / is mounted ("" on the host itself)

	// Docker adds cAdvisor-named container metrics from the Docker socket.
	Docker       bool
	DockerSocket string
	// Services with a credentialsRef get database metrics.
	Services []remote.Service
	Creds    *services.CredentialStore
	Query    func(ctx context.Context, s remote.Service, creds services.Credentials, metrics bool) ([]services.Metric, error)

	Report func(code, message string)
	Logf   func(format string, args ...any)

	// Test hooks.
	Now        func() time.Time
	NetBackoff backoff.Policy
	// Node replaces the embedded node_exporter (tests); NoNode switches node metrics off.
	Node   prometheus.Collector
	NoNode bool
}

// Collector gathers and sends metrics. Run it from one goroutine.
type Collector struct {
	o   Options
	reg *prometheus.Registry
	dk  *docker.Collector

	queue      [][]byte
	queueBytes int
	failures   int
	notBefore  time.Time
	lastErr    string
	sentOnce   bool
	dropped    int
}

// New prepares a collector. It returns ErrUnsupported on hosts without node metrics.
func New(o Options) (*Collector, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Report == nil {
		o.Report = func(string, string) {}
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	if o.Query == nil {
		o.Query = services.QueryDB
	}
	if o.NetBackoff.Base == 0 {
		o.NetBackoff = backoff.Network
	}
	if o.Interval <= 0 {
		o.Interval = remote.DefaultScrapeSeconds * time.Second
	}
	if o.Path == "" {
		o.Path = remote.DefaultPromPath
	}
	c := &Collector{o: o, reg: prometheus.NewRegistry()}
	if !o.NoNode {
		node := o.Node
		if node == nil {
			var err error
			if node, err = newNodeCollector(o.HostRoot); err != nil {
				return nil, err
			}
		}
		if err := c.reg.Register(node); err != nil {
			return nil, fmt.Errorf("node metrics: %v", err)
		}
	}
	if o.Docker {
		c.dk = docker.New(o.DockerSocket)
	}
	return c, nil
}

// Run gathers every interval and sends until ctx ends or the API says the plan does not include
// advanced metrics (ErrNotEntitled).
func (c *Collector) Run(ctx context.Context) error {
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	next := c.o.Now().Add(2 * time.Second)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
		c.enqueue(c.Gather(ctx))
		if err := c.flush(ctx); errors.Is(err, ErrNotEntitled) {
			return err
		}
		next = next.Add(c.o.Interval)
		wait := next.Sub(c.o.Now())
		if wait <= 0 || wait > c.o.Interval {
			wait = c.o.Interval
			next = c.o.Now().Add(wait)
		}
		timer.Reset(wait)
	}
}

func (c *Collector) labels(job string, more ...Label) []Label {
	return append([]Label{{"job", job}, {"instance", c.o.AgentID}, {"nodename", c.o.NodeName}}, more...)
}

// Gather collects one round of series from every source.
func (c *Collector) Gather(ctx context.Context) []Series {
	ctx, cancel := context.WithTimeout(ctx, max(c.o.Interval-time.Second, 5*time.Second))
	defer cancel()
	ms := c.o.Now().UnixMilli()
	var out []Series
	if families, _ := c.reg.Gather(); len(families) > 0 {
		// Gather returns what it could collect even when one collector failed.
		out = append(out, FamiliesToSeries(families, c.labels("node"), ms)...)
	}
	if c.dk != nil {
		if stats, err := c.dk.Stats(ctx); err == nil {
			out = append(out, containerSeries(stats, c.labels("cadvisor"), ms)...)
		}
	}
	out = append(out, c.databaseSeries(ctx, ms)...)
	return out
}

func (c *Collector) databaseSeries(ctx context.Context, ms int64) []Series {
	var list []remote.Service
	for _, s := range c.o.Services {
		if s.CredentialsRef != "" && (s.Kind == "redis" || s.Kind == "mysql" || s.Kind == "postgres" || s.Kind == "mssql") {
			list = append(list, s)
		}
	}
	if len(list) == 0 || c.o.Creds == nil {
		return nil
	}
	results := make([][]Series, len(list))
	var wg sync.WaitGroup
	sem := make(chan struct{}, dbConcurrency)
	for i, s := range list {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, s remote.Service) {
			defer wg.Done()
			defer func() { <-sem }()
			creds, err := c.o.Creds.Load(s.CredentialsRef)
			if err != nil {
				return // the service check reports the problem in its detail
			}
			metrics, err := c.o.Query(ctx, s, creds, true)
			extra := c.labels(s.Kind, Label{"service", s.Name})
			if err != nil {
				up := map[string]string{"redis": "redis_up", "mysql": "mysql_up", "postgres": "pg_up", "mssql": "mssql_up"}[s.Kind]
				results[i] = []Series{newSeries(up, nil, extra, 0, ms)}
				return
			}
			series := make([]Series, 0, len(metrics))
			for _, m := range metrics {
				own := make([]Label, 0, len(m.Labels))
				for k, v := range m.Labels {
					own = append(own, Label{k, v})
				}
				series = append(series, newSeries(m.Name, own, extra, m.Value, ms))
			}
			results[i] = series
		}(i, s)
	}
	wg.Wait()
	var out []Series
	for _, r := range results {
		out = append(out, r...)
	}
	return out
}

// enqueue encodes the series into one or more compressed requests and queues them.
func (c *Collector) enqueue(series []Series) {
	for start := 0; start < len(series); start += maxSeriesPerRequest {
		end := min(start+maxSeriesPerRequest, len(series))
		body := Compress(EncodeWriteRequest(series[start:end]))
		c.queue = append(c.queue, body)
		c.queueBytes += len(body)
	}
	for len(c.queue) > 1 && (len(c.queue) > maxQueued || c.queueBytes > maxQueuedBytes) {
		c.queueBytes -= len(c.queue[0])
		c.queue = c.queue[1:]
		c.dropped++
	}
}

// Queued reports how many requests are waiting (tests).
func (c *Collector) Queued() int { return len(c.queue) }

var writeHeaders = map[string]string{
	"Content-Type":                      "application/x-protobuf",
	"Content-Encoding":                  "snappy",
	"X-Prometheus-Remote-Write-Version": "0.1.0",
}

// flush sends the queue in order until it is empty or a send fails.
func (c *Collector) flush(ctx context.Context) error {
	now := c.o.Now()
	if now.Before(c.notBefore) {
		return nil
	}
	for len(c.queue) > 0 && ctx.Err() == nil {
		body := c.queue[0]
		cred := ""
		if c.o.Credential != nil {
			cred = c.o.Credential()
		}
		_, err := c.o.Poster.Post(ctx, c.o.Path, cred, body, writeHeaders)
		if err == nil {
			c.pop()
			c.failures = 0
			c.notBefore = time.Time{}
			if !c.sentOnce || c.lastErr != "" {
				c.o.Logf("Advanced metrics: sending to %s.", c.o.Path)
			}
			c.sentOnce, c.lastErr = true, ""
			continue
		}
		if ctx.Err() != nil {
			return nil
		}
		var api *client.APIError
		status := 0
		var retryAfter time.Duration
		if errors.As(err, &api) {
			status, retryAfter = api.Status, api.RetryAfter
		}
		switch status {
		case 402:
			c.queue, c.queueBytes = nil, 0
			return ErrNotEntitled
		case 400:
			c.pop()
			c.o.Report("prom_rejected", "The server refused a batch of advanced metrics: "+err.Error())
			continue
		case 413:
			c.pop()
			c.o.Report("prom_too_large", "A batch of advanced metrics was larger than the server accepts and was dropped.")
			continue
		case 401, 403:
			c.failures++
			c.notBefore = now.Add(backoff.Unauthorized.Delay(c.failures))
			c.fail("prom_unauthorized", "The server refused the agent credential for advanced metrics: "+err.Error())
		default:
			c.failures++
			wait := c.o.NetBackoff.Delay(c.failures)
			if retryAfter > 0 {
				wait = max(wait, min(retryAfter, maxRetryAfter))
			}
			c.notBefore = now.Add(wait)
			code := "prom_send_failed"
			if status == 429 {
				code = "prom_backpressure"
			}
			c.fail(code, "Advanced metrics could not be sent (they are queued and retried): "+err.Error())
		}
		return err
	}
	return nil
}

func (c *Collector) pop() {
	c.queueBytes -= len(c.queue[0])
	c.queue = c.queue[1:]
}

func (c *Collector) fail(code, message string) {
	c.o.Report(code, message)
	if c.lastErr != code {
		c.o.Logf("Warning: %s", message)
	}
	c.lastErr = code
}
