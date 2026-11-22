package prom

import (
	"context"
	"errors"
	"math"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/golang/snappy"
	"github.com/prometheus/client_golang/prometheus"
	"google.golang.org/protobuf/encoding/protowire"

	"github.com/yuktiops/agent/internal/backoff"
	"github.com/yuktiops/agent/internal/client"
	"github.com/yuktiops/agent/internal/docker"
	"github.com/yuktiops/agent/internal/remote"
	"github.com/yuktiops/agent/internal/services"
)

// decodeWriteRequest is an independent protobuf decoder for prompb.WriteRequest.
func decodeWriteRequest(t *testing.T, b []byte) []Series {
	t.Helper()
	var out []Series
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 || num != 1 || typ != protowire.BytesType {
			t.Fatalf("bad WriteRequest tag %d/%d", num, typ)
		}
		b = b[n:]
		ts, n := protowire.ConsumeBytes(b)
		b = b[n:]
		var s Series
		for len(ts) > 0 {
			num, _, n := protowire.ConsumeTag(ts)
			ts = ts[n:]
			msg, n := protowire.ConsumeBytes(ts)
			ts = ts[n:]
			switch num {
			case 1:
				var l Label
				for len(msg) > 0 {
					f, _, n := protowire.ConsumeTag(msg)
					msg = msg[n:]
					v, n := protowire.ConsumeString(msg)
					msg = msg[n:]
					if f == 1 {
						l.Name = v
					} else {
						l.Value = v
					}
				}
				s.Labels = append(s.Labels, l)
			case 2:
				for len(msg) > 0 {
					f, typ, n := protowire.ConsumeTag(msg)
					msg = msg[n:]
					if f == 1 && typ == protowire.Fixed64Type {
						v, n := protowire.ConsumeFixed64(msg)
						msg = msg[n:]
						s.Value = math.Float64frombits(v)
					} else {
						v, n := protowire.ConsumeVarint(msg)
						msg = msg[n:]
						s.TimeMs = int64(v)
					}
				}
			default:
				t.Fatalf("unexpected TimeSeries field %d", num)
			}
		}
		out = append(out, s)
	}
	return out
}

func label(s Series, name string) string {
	for _, l := range s.Labels {
		if l.Name == name {
			return l.Value
		}
	}
	return ""
}

func TestEncodeRoundTrip(t *testing.T) {
	extra := []Label{{"job", "node"}, {"instance", "agt_1"}, {"nodename", "web-1"}}
	in := []Series{
		newSeries("node_load1", nil, extra, 0.75, 1700000000123),
		newSeries("node_uname_info", []Label{{"nodename", "container-host"}, {"release", "6.1"}}, extra, 1, 1700000000123),
	}
	raw := EncodeWriteRequest(in)
	dec, err := snappy.Decode(nil, Compress(raw))
	if err != nil {
		t.Fatal(err)
	}
	out := decodeWriteRequest(t, dec)
	if len(out) != 2 || out[0].Value != 0.75 || out[0].TimeMs != 1700000000123 {
		t.Fatalf("got %+v", out)
	}
	if label(out[0], "__name__") != "node_load1" || label(out[0], "job") != "node" || label(out[0], "instance") != "agt_1" {
		t.Errorf("labels %+v", out[0].Labels)
	}
	// The agent's nodename wins over the metric's own label; labels are sorted.
	if label(out[1], "nodename") != "web-1" || label(out[1], "release") != "6.1" {
		t.Errorf("labels %+v", out[1].Labels)
	}
	for _, s := range out {
		for i := 1; i < len(s.Labels); i++ {
			if s.Labels[i-1].Name >= s.Labels[i].Name {
				t.Errorf("labels not sorted: %+v", s.Labels)
			}
		}
	}
}

func TestFamiliesToSeries(t *testing.T) {
	reg := prometheus.NewRegistry()
	c := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "node_cpu_seconds_total", Help: "x"}, []string{"cpu", "mode"})
	c.WithLabelValues("0", "idle").Add(12.5)
	h := prometheus.NewHistogram(prometheus.HistogramOpts{Name: "h", Help: "x", Buckets: []float64{1}})
	h.Observe(0.5)
	reg.MustRegister(c, h)
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	series := FamiliesToSeries(mfs, []Label{{"job", "node"}}, 1000)
	names := map[string]int{}
	for _, s := range series {
		names[label(s, "__name__")]++
	}
	if names["node_cpu_seconds_total"] != 1 || names["h_bucket"] != 2 || names["h_sum"] != 1 || names["h_count"] != 1 {
		t.Errorf("series %v", names)
	}
}

func TestContainerSeries(t *testing.T) {
	started := time.Unix(1700000000, 0)
	stats := []docker.Stats{{ID: "abc123abc123abc1", Name: "web", Image: "nginx", Started: started, CPUTotal: 3.5,
		WorkingSet: 100, MemoryLimit: 512, Networks: map[string]docker.NetStats{"eth0": {RxBytes: 10, TxBytes: 20}}}}
	series := containerSeries(stats, []Label{{"job", "cadvisor"}}, 1700000100000)
	got := map[string]float64{}
	for _, s := range series {
		if label(s, "name") != "web" || label(s, "job") != "cadvisor" {
			t.Errorf("labels %+v", s.Labels)
		}
		got[label(s, "__name__")] = s.Value
	}
	want := map[string]float64{
		"container_cpu_usage_seconds_total": 3.5, "container_memory_working_set_bytes": 100,
		"container_spec_memory_limit_bytes": 512, "container_network_receive_bytes_total": 10,
		"container_network_transmit_bytes_total": 20, "container_start_time_seconds": 1700000000,
		"container_last_seen": 1700000100,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
}

type fakePoster struct {
	mu      sync.Mutex
	status  []int // answers in order; 0 means 202
	bodies  [][]byte
	headers []map[string]string
	bearer  []string
	paths   []string
}

func (f *fakePoster) Post(_ context.Context, path, bearer string, body []byte, h map[string]string) (*client.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bodies = append(f.bodies, body)
	f.headers = append(f.headers, h)
	f.bearer = append(f.bearer, bearer)
	f.paths = append(f.paths, path)
	st := 0
	if len(f.status) > 0 {
		st, f.status = f.status[0], f.status[1:]
	}
	if st == 0 {
		return &client.Response{Status: 202}, nil
	}
	return &client.Response{Status: st}, &client.APIError{Status: st, RetryAfter: 30 * time.Second}
}

type constCollector struct{}

func (constCollector) Describe(ch chan<- *prometheus.Desc) {}
func (constCollector) Collect(ch chan<- prometheus.Metric) {
	ch <- prometheus.MustNewConstMetric(prometheus.NewDesc("node_load1", "x", nil, nil), prometheus.GaugeValue, 1.5)
}

func newTestCollector(t *testing.T, p *fakePoster, now *time.Time) *Collector {
	t.Helper()
	c, err := New(Options{
		Poster: p, Credential: func() string { return "agent_cred" }, Path: "/v1/prom/write",
		AgentID: "agt_1", NodeName: "web-1", Node: constCollector{},
		Now:        func() time.Time { return *now },
		NetBackoff: backoff.Policy{Base: time.Second, Max: 4 * time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSendHeadersAndStatuses(t *testing.T) {
	now := time.Unix(1700000000, 0)
	p := &fakePoster{}
	c := newTestCollector(t, p, &now)
	ctx := context.Background()

	c.enqueue(c.Gather(ctx))
	if err := c.flush(ctx); err != nil {
		t.Fatal(err)
	}
	if len(p.bodies) != 1 || p.bearer[0] != "agent_cred" || p.paths[0] != "/v1/prom/write" {
		t.Fatalf("posted %d, bearer %v, paths %v", len(p.bodies), p.bearer, p.paths)
	}
	h := p.headers[0]
	if h["Content-Encoding"] != "snappy" || h["Content-Type"] != "application/x-protobuf" || h["X-Prometheus-Remote-Write-Version"] != "0.1.0" {
		t.Errorf("headers %v", h)
	}
	raw, err := snappy.Decode(nil, p.bodies[0])
	if err != nil {
		t.Fatal(err)
	}
	series := decodeWriteRequest(t, raw)
	if len(series) != 1 || label(series[0], "job") != "node" || label(series[0], "instance") != "agt_1" || label(series[0], "nodename") != "web-1" {
		t.Errorf("series %+v", series)
	}

	// 429: kept in the queue and retried after the backoff (at least Retry-After).
	p.status = []int{429}
	c.enqueue(c.Gather(ctx))
	if err := c.flush(ctx); err == nil || c.Queued() != 1 {
		t.Fatalf("429: err %v, queued %d", err, c.Queued())
	}
	now = now.Add(10 * time.Second)
	c.flush(ctx) // still backing off: nothing sent
	if len(p.bodies) != 2 {
		t.Errorf("sent during backoff: %d", len(p.bodies))
	}
	now = now.Add(time.Minute)
	if err := c.flush(ctx); err != nil || c.Queued() != 0 || len(p.bodies) != 3 {
		t.Errorf("retry: err %v, queued %d, sent %d", err, c.Queued(), len(p.bodies))
	}

	// 413: dropped, not retried forever.
	p.status = []int{413}
	c.enqueue(c.Gather(ctx))
	if err := c.flush(ctx); err != nil || c.Queued() != 0 {
		t.Errorf("413: err %v queued %d", err, c.Queued())
	}

	// 402: the collector must stop.
	p.status = []int{402}
	c.enqueue(c.Gather(ctx))
	if err := c.flush(ctx); !errors.Is(err, ErrNotEntitled) {
		t.Errorf("402: %v", err)
	}
}

func TestQueueIsBounded(t *testing.T) {
	now := time.Unix(1700000000, 0)
	c := newTestCollector(t, &fakePoster{}, &now)
	for i := 0; i < maxQueued*3; i++ {
		c.enqueue(c.Gather(context.Background()))
	}
	if c.Queued() != maxQueued {
		t.Errorf("queued %d, want %d", c.Queued(), maxQueued)
	}
}

func TestRunStopsOn402(t *testing.T) {
	now := time.Now()
	p := &fakePoster{status: []int{402}}
	c := newTestCollector(t, p, &now)
	c.o.Now = time.Now
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.Run(ctx); !errors.Is(err, ErrNotEntitled) {
		t.Errorf("Run = %v", err)
	}
}

func TestDatabaseSeries(t *testing.T) {
	now := time.Unix(1700000000, 0)
	c := newTestCollector(t, &fakePoster{}, &now)
	store := &services.CredentialStore{Getenv: func(k string) string {
		return map[string]string{"YUKTIOPS_CRED_CACHE_PASSWORD": "s3cret"}[k]
	}}
	c.o.Creds = store
	c.o.Services = []remote.Service{
		{Kind: "redis", Name: "cache", Port: 6379, CredentialsRef: "cache"},
		{Kind: "redis", Name: "nocreds", Port: 6380}, // no credentialsRef: liveness only
		{Kind: "mysql", Name: "db", Port: 3306, CredentialsRef: "missing"},
	}
	c.o.Query = func(_ context.Context, s remote.Service, creds services.Credentials, metrics bool) ([]services.Metric, error) {
		if creds.Password != "s3cret" || !metrics {
			t.Errorf("query got %v metrics=%v", creds, metrics)
		}
		return []services.Metric{{Name: "redis_connected_clients", Value: 3}, {Name: "redis_db_keys", Value: 7, Labels: map[string]string{"db": "db0"}}}, nil
	}
	series := c.databaseSeries(context.Background(), now.UnixMilli())
	if len(series) != 2 {
		t.Fatalf("series %+v", series)
	}
	for _, s := range series {
		if label(s, "job") != "redis" || label(s, "service") != "cache" || label(s, "instance") != "agt_1" {
			t.Errorf("labels %+v", s.Labels)
		}
	}
}

func TestNodeCollectorAvailability(t *testing.T) {
	_, err := newNodeCollector("")
	if runtime.GOOS == "linux" {
		if err != nil {
			t.Fatalf("node collector on Linux: %v", err)
		}
		reg := prometheus.NewRegistry()
		n, _ := newNodeCollector("")
		reg.MustRegister(n)
		mfs, _ := reg.Gather()
		found := map[string]bool{}
		for _, mf := range mfs {
			found[mf.GetName()] = true
		}
		for _, name := range []string{"node_cpu_seconds_total", "node_memory_MemTotal_bytes", "node_load1", "node_boot_time_seconds", "node_uname_info"} {
			if !found[name] {
				t.Errorf("missing %s", name)
			}
		}
	} else if !errors.Is(err, ErrUnsupported) {
		t.Errorf("expected ErrUnsupported, got %v", err)
	}
}
