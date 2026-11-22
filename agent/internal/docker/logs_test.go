package docker

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yuktiops/agent/internal/backoff"
	"github.com/yuktiops/agent/internal/client"
)

func frame(stream byte, payload string) []byte {
	h := make([]byte, 8)
	h[0] = stream
	binary.BigEndian.PutUint32(h[4:], uint32(len(payload)))
	return append(h, payload...)
}

type line struct{ stream, text string }

func collect(t *testing.T, r io.Reader, tty bool) []line {
	t.Helper()
	var out []line
	if err := Demux(r, tty, func(s string, l []byte) { out = append(out, line{s, string(l)}) }); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDemuxMultiplexed(t *testing.T) {
	var b bytes.Buffer
	b.Write(frame(1, "first line\nsecond "))
	b.Write(frame(2, "oops\n"))
	b.Write(frame(1, "half\r\n"))
	b.Write(frame(1, "tail without newline"))
	got := collect(t, &b, false)
	want := []line{{"stdout", "first line"}, {"stderr", "oops"}, {"stdout", "second half"}, {"stdout", "tail without newline"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %v\nwant %v", got, want)
	}
	// A header that is not a Docker frame is an error, not garbage lines.
	if err := Demux(strings.NewReader("plain text that is not framed\n"), false, func(string, []byte) {}); err == nil {
		t.Error("accepted an unframed stream")
	}
}

func TestDemuxTTYAndLongLines(t *testing.T) {
	got := collect(t, strings.NewReader("a\r\nb\n"), true)
	if fmt.Sprint(got) != fmt.Sprint([]line{{"stdout", "a"}, {"stdout", "b"}}) {
		t.Errorf("tty: %v", got)
	}
	long := strings.Repeat("x", MaxLineBytes+500)
	var b bytes.Buffer
	b.Write(frame(1, long[:9000]))
	b.Write(frame(1, long[9000:]+"\nnext\n"))
	got = collect(t, &b, false)
	if len(got) != 2 || len(got[0].text) != MaxLineBytes || got[1].text != "next" {
		t.Errorf("long line: %d lines, first %d bytes", len(got), len(got[0].text))
	}
}

func TestParseLineAndSeverity(t *testing.T) {
	ts, msg := ParseLine([]byte("2026-11-22T10:00:00.123456789Z hello world"))
	if ts.Nanosecond() != 123456789 || msg != "hello world" {
		t.Errorf("%v %q", ts, msg)
	}
	if ts, msg := ParseLine([]byte("no timestamp here")); !ts.IsZero() || msg != "no timestamp here" {
		t.Errorf("%v %q", ts, msg)
	}
	cases := map[string]string{
		`{"level":"error","msg":"x"}`:                        "ERROR",
		`{"level":40,"msg":"pino"}`:                          "WARN",
		`{"severity":"INFO"}`:                                "INFO",
		`time=1 level=debug msg="starting"`:                  "DEBUG",
		`2026/11/22 10:00:00 [error] 12#12: open() failed`:   "ERROR",
		`WARN  [main] disk almost full`:                      "WARN",
		`INFO Server started on :8080`:                       "INFO",
		`Traceback (most recent call last):`:                 "ERROR",
		`127.0.0.1 - - "GET / HTTP/1.1" 200 612`:             "",
		`the information desk`:                               "",
		`E1122 10:00:00.000 1 main.go:1] lvl=warn something`: "WARN",
	}
	for in, want := range cases {
		if got := GuessSeverity(in); got != want {
			t.Errorf("GuessSeverity(%q) = %q, want %q", in, got, want)
		}
	}
	if SeverityNumber("ERROR") != 17 || SeverityNumber("") != 0 {
		t.Error("severity numbers")
	}
}

func TestCheckpointsPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log-checkpoints.json")
	now := time.Now()
	cp := LoadCheckpoints(path, now)
	id := strings.Repeat("a", 64)
	t1 := now.Add(-time.Minute).Truncate(time.Nanosecond)
	cp.Advance(id, t1)
	cp.Advance(id, t1.Add(-time.Second)) // never backwards
	cp.Advance("not-an-id", t1)
	if err := cp.Save(); err != nil {
		t.Fatal(err)
	}
	again := LoadCheckpoints(path, now)
	if !again.Get(id).Equal(t1) {
		t.Errorf("checkpoint %v, want %v", again.Get(id), t1)
	}
	if !again.Get("not-an-id").IsZero() {
		t.Error("invalid ids must not be loaded")
	}
	// Week-old checkpoints are forgotten.
	if !LoadCheckpoints(path, now.Add(8*24*time.Hour)).Get(id).IsZero() {
		t.Error("stale checkpoint kept")
	}
	if got := sinceParam(time.Unix(1700000000, 5)); got != "1700000000.000000005" {
		t.Errorf("since %s", got)
	}
}

// ---- end-to-end against a fake Docker daemon and a fake API ------------------------------------

const webID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const optOutID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const ttyID = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

type fakeDaemon struct {
	mu     sync.Mutex
	since  map[string][]string
	served map[string]int
}

func (f *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.URL.Path {
	case "/containers/json":
		fmt.Fprintf(w, `[{"Id":%q,"Names":["/web"],"Image":"nginx","State":"running"},
			{"Id":%q,"Names":["/secret"],"Image":"vault","State":"running","Labels":{"yuktiops.logs":"false"}},
			{"Id":%q,"Names":["/shell"],"Image":"busybox","State":"running"}]`, webID, optOutID, ttyID)
	case "/containers/" + webID + "/json":
		w.Write([]byte(`{"Config":{"Tty":false},"State":{"StartedAt":"2026-11-22T09:00:00Z"}}`))
	case "/containers/" + ttyID + "/json":
		w.Write([]byte(`{"Config":{"Tty":true},"State":{"StartedAt":"2026-11-22T09:00:00Z"}}`))
	case "/containers/" + webID + "/logs":
		f.since[webID] = append(f.since[webID], r.URL.Query().Get("since"))
		if r.URL.Query().Get("follow") != "1" || r.URL.Query().Get("timestamps") != "1" {
			http.Error(w, "bad query", 400)
			return
		}
		f.served[webID]++
		if f.served[webID] > 1 {
			return // the restart: no new lines
		}
		w.Write(frame(1, "2026-11-22T10:00:00.000000001Z GET / 200\n"))
		w.Write(frame(2, "2026-11-22T10:00:01.000000002Z level=error msg=boom\n"))
	case "/containers/" + ttyID + "/logs":
		f.served[ttyID]++
		if f.served[ttyID] == 1 {
			w.Write([]byte("2026-11-22T10:00:02Z $ ls\r\n"))
		}
	case "/containers/" + optOutID + "/logs":
		f.served[optOutID]++
		w.Write([]byte("must never be read"))
	case "/events":
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		f.mu.Unlock()
		<-r.Context().Done()
		f.mu.Lock()
	default:
		http.NotFound(w, r)
	}
}

type apiPoster struct {
	mu     sync.Mutex
	status []int
	docs   []otlpLogs
	paths  []string
}

func (a *apiPoster) Post(_ context.Context, path, bearer string, body []byte, h map[string]string) (*client.Response, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.paths = append(a.paths, path)
	if h["Content-Encoding"] != "gzip" || h["Content-Type"] != "application/json" || bearer != "agent_x" {
		return nil, fmt.Errorf("bad request headers %v %q", h, bearer)
	}
	if len(a.status) > 0 && a.status[0] != 0 {
		st := a.status[0]
		a.status = a.status[1:]
		return &client.Response{Status: st}, &client.APIError{Status: st}
	}
	if len(a.status) > 0 {
		a.status = a.status[1:]
	}
	gz, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	var doc otlpLogs
	if err := json.NewDecoder(gz).Decode(&doc); err != nil {
		return nil, err
	}
	a.docs = append(a.docs, doc)
	return &client.Response{Status: 200}, nil
}

func (a *apiPoster) records() map[string][]otlpRecord {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := map[string][]otlpRecord{}
	for _, d := range a.docs {
		for _, rl := range d.ResourceLogs {
			name := ""
			for _, kv := range rl.Resource.Attributes {
				if kv.Key == "container.name" {
					name = kv.Value.StringValue
				}
			}
			for _, sl := range rl.ScopeLogs {
				out[name] = append(out[name], sl.LogRecords...)
			}
		}
	}
	return out
}

func runTailer(t *testing.T, sock, cpFile string, api *apiPoster, until func() bool) {
	t.Helper()
	tl := NewTailer(TailOptions{
		Socket: sock, CheckpointFile: cpFile, AgentID: "agt_1", HostName: "host-1",
		Poster: api, Credential: func() string { return "agent_x" },
		FlushEvery: 20 * time.Millisecond, ResyncEvery: 50 * time.Millisecond,
		NetBackoff: backoff.Policy{Base: 10 * time.Millisecond, Max: 20 * time.Millisecond},
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); tl.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for !until() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
}

func TestTailerEndToEnd(t *testing.T) {
	d := &fakeDaemon{since: map[string][]string{}, served: map[string]int{}}
	sock := serve(t, d)
	cpFile := filepath.Join(t.TempDir(), "log-checkpoints.json")
	api := &apiPoster{}
	runTailer(t, sock, cpFile, api, func() bool {
		r := api.records()
		return len(r["web"]) >= 2 && len(r["shell"]) >= 1
	})

	recs := api.records()
	web := recs["web"]
	if len(web) != 2 {
		t.Fatalf("web records %+v", recs)
	}
	if web[0].Body.StringValue != "GET / 200" || web[0].Attributes[0].Value.StringValue != "stdout" || web[0].TimeUnixNano != "1795341600000000001" {
		t.Errorf("first record %+v", web[0])
	}
	if web[1].SeverityText != "ERROR" || web[1].SeverityNumber != 17 || web[1].Attributes[0].Value.StringValue != "stderr" {
		t.Errorf("second record %+v", web[1])
	}
	if len(recs["shell"]) != 1 || recs["shell"][0].Body.StringValue != "$ ls" {
		t.Errorf("tty records %+v", recs["shell"])
	}
	if _, ok := recs["secret"]; ok || d.served[optOutID] != 0 {
		t.Error("the yuktiops.logs=false container was read")
	}
	attrs := map[string]string{}
	api.mu.Lock()
	for _, kv := range api.docs[0].ResourceLogs[0].Resource.Attributes {
		attrs[kv.Key] = kv.Value.StringValue
	}
	path := api.paths[0]
	api.mu.Unlock()
	if path != "/v1/otlp/logs" || attrs["service.name"] == "" || attrs["host.name"] != "host-1" || attrs["yk.agent"] != "agt_1" || attrs["yk.source"] != "docker" {
		t.Errorf("path %s attrs %v", path, attrs)
	}

	// After a restart the follower continues after the checkpoint (since = last delivered line).
	cp := LoadCheckpoints(cpFile, time.Now())
	if got := cp.Get(webID); got.Format(time.RFC3339Nano) != "2026-11-22T10:00:01.000000002Z" {
		t.Fatalf("checkpoint %v", got)
	}
	api2 := &apiPoster{}
	d.mu.Lock()
	d.since[webID] = nil
	d.mu.Unlock()
	runTailer(t, sock, cpFile, api2, func() bool {
		d.mu.Lock()
		defer d.mu.Unlock()
		return len(d.since[webID]) > 0
	})
	d.mu.Lock()
	since := d.since[webID][0]
	d.mu.Unlock()
	if since != "1795341601.000000002" {
		t.Errorf("since after restart = %s", since)
	}
}

func TestTailerQuotaPause(t *testing.T) {
	d := &fakeDaemon{since: map[string][]string{}, served: map[string]int{}}
	sock := serve(t, d)
	api := &apiPoster{status: []int{429}}
	var reports []string
	var mu sync.Mutex
	tl := NewTailer(TailOptions{
		Socket: sock, CheckpointFile: filepath.Join(t.TempDir(), "cp.json"), Include: []string{"web"},
		Poster: api, Credential: func() string { return "agent_x" }, FlushEvery: 20 * time.Millisecond,
		Report: func(code, _ string) { mu.Lock(); reports = append(reports, code); mu.Unlock() },
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); tl.Run(ctx) }()
	for {
		mu.Lock()
		n := len(reports)
		mu.Unlock()
		if n > 0 || ctx.Err() != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(reports) == 0 || reports[0] != "logs_quota" {
		t.Errorf("reports %v", reports)
	}
	if len(api.records()) != 0 {
		t.Error("logs were delivered despite the 429")
	}
	if _, quota, _ := tl.Dropped(); quota == 0 {
		t.Error("dropped lines were not counted")
	}
}

func TestBatchEncodingSplitsByContainer(t *testing.T) {
	tl := NewTailer(TailOptions{Version: "1.2.3"})
	a := &containerMeta{id: webID, name: "web", resource: []otlpKV{kv("container.name", "web")}}
	b := &containerMeta{id: ttyID, name: "shell", resource: []otlpKV{kv("container.name", "shell")}}
	bt := newBatch()
	t0 := time.Unix(1700000000, 0)
	bt.add(record{c: a, ts: t0, stream: "stdout", body: "one"}, t0)
	bt.add(record{c: b, ts: t0.Add(time.Second), stream: "stderr", body: "two", sev: "WARN"}, t0)
	bt.add(record{c: a, ts: t0.Add(2 * time.Second), stream: "stdout", body: "three"}, t0)
	p := tl.encode(bt)
	if p.lines != 3 || !p.marks[webID].Equal(t0.Add(2*time.Second)) || !p.marks[ttyID].Equal(t0.Add(time.Second)) {
		t.Errorf("marks %v lines %d", p.marks, p.lines)
	}
	gz, _ := gzip.NewReader(bytes.NewReader(p.body))
	var doc otlpLogs
	if err := json.NewDecoder(gz).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.ResourceLogs) != 2 || len(doc.ResourceLogs[0].ScopeLogs[0].LogRecords) != 2 || doc.ResourceLogs[0].ScopeLogs[0].Scope.Name != "yuktiops-agent" {
		t.Errorf("doc %+v", doc)
	}
	if doc.ResourceLogs[1].ScopeLogs[0].LogRecords[0].SeverityText != "WARN" {
		t.Errorf("severity lost")
	}
	// Batches are sealed at about 1 MB.
	big := newBatch()
	for i := 0; big.bytes < maxBatchBytes; i++ {
		big.add(record{c: a, ts: t0, body: strings.Repeat("y", 1000)}, t0)
	}
	if big.bytes < maxBatchBytes || big.bytes > maxBatchBytes+2000 {
		t.Errorf("batch size %d", big.bytes)
	}
}
