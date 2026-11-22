package docker

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yuktiops/agent/internal/backoff"
	"github.com/yuktiops/agent/internal/client"
)

// Container log collection. Every selected running container's log is followed through the
// Docker socket (GET /containers/{id}/logs?follow=1, read-only), split into lines and sent in
// batches as OTLP/HTTP JSON logs to the agent API. The last delivered timestamp per container is
// kept in the state directory, so a restart neither loses nor repeats lines.

const (
	// LogsPath is the OTLP logs ingest on the agent API.
	LogsPath = "/v1/otlp/logs"
	// LogLabel set to "false" on a container opts it out of log collection.
	LogLabel = "yuktiops.logs"

	maxBatchBytes     = 1 << 20
	defaultFlushEvery = 2 * time.Second
	maxLinesPerSecond = 1000
	maxPendingBatches = 8
	quotaPause        = 5 * time.Minute
	resyncEvery       = 30 * time.Second
	failedRetryAfter  = 10 * time.Minute
	checkpointEvery   = 5 * time.Second
	recordOverhead    = 160 // rough JSON size of one record without its body
)

// Poster sends a request body to the agent API (client.Client.Post).
type Poster interface {
	Post(ctx context.Context, path, bearer string, body []byte, headers map[string]string) (*client.Response, error)
}

// TailOptions configure a Tailer.
type TailOptions struct {
	Socket         string
	Include        []string // container names; empty means every running container
	Exclude        []string
	CheckpointFile string
	AgentID        string
	HostName       string
	Version        string

	Poster     Poster
	Credential func() string
	Report     func(code, message string)
	Logf       func(format string, args ...any)

	// Test hooks.
	Now         func() time.Time
	NetBackoff  backoff.Policy
	FlushEvery  time.Duration
	ResyncEvery time.Duration
}

// Tailer follows container logs. Create it with NewTailer and call Run once.
type Tailer struct {
	o       TailOptions
	dk      *Collector
	stream  *http.Client
	cp      *Checkpoints
	records chan record
	started time.Time

	include map[string]bool
	exclude map[string]bool

	mu sync.Mutex
	// queued is the newest timestamp handed to the sender per container, so a follower that is
	// restarted (stream closed, container restarted) does not read the same lines again.
	queued        map[string]time.Time
	droppedRate   int // lines over the per-container rate limit
	droppedQuota  int // lines discarded while the quota pause lasts
	droppedFailed int // lines in batches dropped after failures
}

type containerMeta struct {
	id, name, image string
	tty             bool
	resource        []otlpKV
}

type record struct {
	c      *containerMeta
	ts     time.Time
	stream string
	sev    string
	body   string
}

// NewTailer prepares a tailer; nothing happens until Run.
func NewTailer(o TailOptions) *Tailer {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Report == nil {
		o.Report = func(string, string) {}
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	if o.NetBackoff.Base == 0 {
		o.NetBackoff = backoff.Network
	}
	if o.FlushEvery <= 0 {
		o.FlushEvery = defaultFlushEvery
	}
	if o.ResyncEvery <= 0 {
		o.ResyncEvery = resyncEvery
	}
	dk := New(o.Socket)
	t := &Tailer{
		o:       o,
		dk:      dk,
		records: make(chan record, 4096),
		queued:  map[string]time.Time{},
		include: set(o.Include),
		exclude: set(o.Exclude),
	}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", dk.Socket)
		},
		DisableCompression:    true,
		ResponseHeaderTimeout: 10 * time.Second,
		MaxIdleConns:          2,
		IdleConnTimeout:       30 * time.Second,
	}
	// No overall timeout: log and event streams stay open for as long as the container runs.
	t.stream = &http.Client{Transport: readOnly{next: tr, c: dk}}
	return t
}

func set(list []string) map[string]bool {
	m := make(map[string]bool, len(list))
	for _, s := range list {
		m[s] = true
	}
	return m
}

// wanted applies include/exclude and the opt-out label.
func (t *Tailer) wanted(name string, labels map[string]string) bool {
	if strings.EqualFold(strings.TrimSpace(labels[LogLabel]), "false") {
		return false
	}
	if t.exclude[name] {
		return false
	}
	return len(t.include) == 0 || t.include[name]
}

type follower struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Run follows logs until ctx ends. Checkpoints are saved on the way out.
func (t *Tailer) Run(ctx context.Context) error {
	t.started = t.o.Now()
	t.cp = LoadCheckpoints(t.o.CheckpointFile, t.started)

	sendCtx, stopSend := context.WithCancel(context.Background())
	sendDone := make(chan struct{})
	go func() { defer close(sendDone); t.sendLoop(sendCtx) }()

	followers := map[string]*follower{}
	failed := map[string]time.Time{}
	ended := make(chan string, 16)
	events := make(chan dockerEvent, 64)
	evCtx, stopEvents := context.WithCancel(ctx)
	go t.watchEvents(evCtx, events)

	resync := func() {
		running, err := t.running(ctx)
		if err != nil {
			if ctx.Err() == nil {
				t.reportDockerError(err)
			}
			return
		}
		seen := map[string]bool{}
		for _, e := range running {
			seen[e.ID] = true
			name := containerName(e)
			if !t.wanted(name, e.Labels) {
				if f := followers[e.ID]; f != nil {
					f.cancel()
				}
				continue
			}
			if followers[e.ID] != nil || t.o.Now().Before(failed[e.ID]) || len(followers) >= MaxContainers {
				continue
			}
			fctx, cancel := context.WithCancel(ctx)
			f := &follower{cancel: cancel, done: make(chan struct{})}
			followers[e.ID] = f
			go func(e listEntry) {
				defer close(f.done)
				err := t.follow(fctx, e)
				if err != nil && fctx.Err() == nil {
					select {
					case ended <- "!" + e.ID:
					case <-ctx.Done():
					}
					return
				}
				select {
				case ended <- e.ID:
				case <-ctx.Done():
				}
			}(e)
		}
		for id, f := range followers {
			if !seen[id] {
				f.cancel()
			}
		}
	}

	resync()
	ticker := time.NewTicker(t.o.ResyncEvery)
	defer ticker.Stop()
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-ticker.C:
			resync()
		case ev := <-events:
			switch ev.Action {
			case "start":
				delete(failed, ev.ID)
				resync()
			case "die", "destroy", "stop":
				if f := followers[ev.ID]; f != nil {
					f.cancel()
				}
			}
		case id := <-ended:
			if strings.HasPrefix(id, "!") {
				id = id[1:]
				failed[id] = t.o.Now().Add(failedRetryAfter)
			}
			if f := followers[id]; f != nil {
				f.cancel()
				delete(followers, id)
			}
		}
	}
	stopEvents()
	for _, f := range followers {
		f.cancel()
	}
	for _, f := range followers {
		<-f.done
	}
	// Let the sender deliver what is left (briefly), then save the checkpoints.
	stopSend()
	<-sendDone
	if err := t.cp.Save(); err != nil {
		t.o.Logf("Warning: could not save the container log checkpoints: %v", err)
	}
	return nil
}

func containerName(e listEntry) string {
	if len(e.Names) > 0 {
		if n := strings.TrimPrefix(e.Names[0], "/"); n != "" {
			return n
		}
	}
	return shortID(e.ID)
}

func (t *Tailer) running(ctx context.Context) ([]listEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	var list []listEntry
	err := t.dk.get(ctx, "/containers/json", &list)
	return list, err
}

func (t *Tailer) reportDockerError(err error) {
	switch {
	case errors.Is(err, ErrDenied):
		t.o.Report("docker_socket_denied", "Container logs are switched on but the agent is not allowed to use the Docker socket.")
	case errors.Is(err, ErrUnavailable):
		t.o.Report("logs_docker_unavailable", "Container logs are switched on but the Docker socket is not available on this server.")
	default:
		t.o.Report("logs_docker_failed", "Could not list containers for log collection: "+err.Error())
	}
}

// ---- following one container ------------------------------------------------------------------

func (t *Tailer) follow(ctx context.Context, e listEntry) error {
	meta := &containerMeta{id: e.ID, name: containerName(e), image: e.Image}
	var in inspectDoc
	ictx, cancel := context.WithTimeout(ctx, requestTimeout)
	started := time.Time{}
	if err := t.dk.get(ictx, "/containers/"+e.ID+"/json", &in); err == nil {
		meta.tty = in.Config.Tty
		if ts, err := time.Parse(time.RFC3339Nano, in.State.StartedAt); err == nil && ts.Year() > 1 {
			started = ts
		}
	}
	cancel()
	meta.resource = []otlpKV{
		kv("service.name", meta.name), kv("container.name", meta.name), kv("container.id", meta.id),
		kv("container.image", meta.image), kv("host.name", t.o.HostName), kv("yk.agent", t.o.AgentID),
		kv("yk.source", "docker"),
	}

	// Continue after the last delivered line. Without a checkpoint, start when collection was
	// switched on (or when the container started, if that is later): no history flood.
	skipUntil := t.cp.Get(e.ID)
	t.mu.Lock()
	if q := t.queued[e.ID]; q.After(skipUntil) {
		skipUntil = q
	}
	t.mu.Unlock()
	since := skipUntil
	if since.IsZero() {
		since = t.started
		if started.After(since) {
			since = started
		}
	}
	q := url.Values{
		"follow": {"1"}, "stdout": {"1"}, "stderr": {"1"}, "timestamps": {"1"},
		"since": {sinceParam(since)},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/"+e.ID+"/logs?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	res, err := t.stream.Do(req)
	if err != nil {
		return classify(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		t.o.Report("logs_container_failed", fmt.Sprintf("Logs of container %s cannot be read (Docker answered %d): %s",
			meta.name, res.StatusCode, strings.TrimSpace(string(msg))))
		return fmt.Errorf("docker answered %d", res.StatusCode)
	}
	var window int64
	var count int
	return Demux(res.Body, meta.tty, func(stream string, line []byte) {
		ts, body := ParseLine(line)
		if ts.IsZero() {
			ts = t.o.Now()
		} else if !skipUntil.IsZero() && !ts.After(skipUntil) {
			return // already delivered before the restart
		}
		now := t.o.Now().Unix()
		if now != window {
			window, count = now, 0
		}
		count++
		if count > maxLinesPerSecond {
			t.mu.Lock()
			t.droppedRate++
			t.mu.Unlock()
			return
		}
		rec := record{c: meta, ts: ts, stream: stream, sev: GuessSeverity(body), body: body}
		select {
		case t.records <- rec:
			t.mu.Lock()
			if ts.After(t.queued[meta.id]) {
				t.queued[meta.id] = ts
			}
			t.mu.Unlock()
		case <-ctx.Done():
		}
	})
}

// ---- Docker events ----------------------------------------------------------------------------

type dockerEvent struct {
	Type   string `json:"Type"`
	Action string `json:"Action"`
	ID     string `json:"id"`
	Actor  struct {
		ID string `json:"ID"`
	} `json:"Actor"`
}

// watchEvents streams container start/stop events so new containers are followed at once. The
// periodic resync covers any event missed while the stream reconnects.
func (t *Tailer) watchEvents(ctx context.Context, out chan<- dockerEvent) {
	filters := `{"type":["container"],"event":["start","die","stop","destroy"]}`
	for ctx.Err() == nil {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/events?filters="+url.QueryEscape(filters), nil)
		if err != nil {
			return
		}
		if res, err := t.stream.Do(req); err == nil {
			if res.StatusCode == http.StatusOK {
				dec := json.NewDecoder(io.LimitReader(res.Body, 1<<30))
				for {
					var ev dockerEvent
					if err := dec.Decode(&ev); err != nil {
						break
					}
					if ev.ID == "" {
						ev.ID = ev.Actor.ID
					}
					if ev.Type != "" && ev.Type != "container" {
						continue
					}
					select {
					case out <- ev:
					case <-ctx.Done():
					}
				}
			}
			res.Body.Close()
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

// ---- batching and sending ---------------------------------------------------------------------

type batch struct {
	order []string // container ids in arrival order
	byID  map[string][]record
	bytes int
	first time.Time
}

func newBatch() *batch { return &batch{byID: map[string][]record{}} }

func (b *batch) add(r record, now time.Time) {
	if len(b.byID) == 0 && b.bytes == 0 {
		b.first = now
	}
	if _, ok := b.byID[r.c.id]; !ok {
		b.order = append(b.order, r.c.id)
	}
	b.byID[r.c.id] = append(b.byID[r.c.id], r)
	b.bytes += len(r.body) + recordOverhead
}

func (b *batch) empty() bool { return b.bytes == 0 }

type pendingBatch struct {
	body  []byte               // gzip-compressed OTLP JSON
	marks map[string]time.Time // checkpoint per container once delivered
	lines int
}

// encode builds the OTLP/HTTP JSON request of a batch.
func (t *Tailer) encode(b *batch) pendingBatch {
	observed := strconv.FormatInt(t.o.Now().UnixNano(), 10)
	doc := otlpLogs{ResourceLogs: make([]otlpResourceLogs, 0, len(b.order))}
	marks := map[string]time.Time{}
	lines := 0
	for _, id := range b.order {
		recs := b.byID[id]
		var rl otlpResourceLogs
		rl.Resource.Attributes = recs[0].c.resource
		var sl otlpScopeLogs
		sl.Scope.Name = "yuktiops-agent"
		sl.Scope.Version = t.o.Version
		sl.LogRecords = make([]otlpRecord, 0, len(recs))
		for _, r := range recs {
			sl.LogRecords = append(sl.LogRecords, otlpRecord{
				TimeUnixNano:         strconv.FormatInt(r.ts.UnixNano(), 10),
				ObservedTimeUnixNano: observed,
				SeverityNumber:       SeverityNumber(r.sev),
				SeverityText:         r.sev,
				Body:                 otlpValue{StringValue: strings.ToValidUTF8(r.body, "�")},
				Attributes:           []otlpKV{kv("log.iostream", r.stream)},
			})
			if r.ts.After(marks[id]) {
				marks[id] = r.ts
			}
			lines++
		}
		rl.ScopeLogs = []otlpScopeLogs{sl}
		doc.ResourceLogs = append(doc.ResourceLogs, rl)
	}
	raw, _ := json.Marshal(doc)
	var buf bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	gz.Write(raw)
	gz.Close()
	return pendingBatch{body: buf.Bytes(), marks: marks, lines: lines}
}

var logHeaders = map[string]string{"Content-Type": "application/json", "Content-Encoding": "gzip"}

// sendLoop batches records (1 MB or FlushEvery, whichever comes first) and delivers them in order.
func (t *Tailer) sendLoop(ctx context.Context) {
	cur := newBatch()
	var pending []pendingBatch
	var failures int
	var notBefore, pausedUntil time.Time
	var lastErr string
	lastSave := t.o.Now()
	lastDropReport := t.o.Now()
	flush := time.NewTimer(time.Hour)
	flush.Stop()
	retry := time.NewTimer(time.Hour)
	retry.Stop()
	defer flush.Stop()
	defer retry.Stop()

	seal := func() {
		if cur.empty() {
			return
		}
		pending = append(pending, t.encode(cur))
		cur = newBatch()
		flush.Stop()
		for len(pending) > maxPendingBatches {
			t.mu.Lock()
			t.droppedFailed += pending[0].lines
			t.mu.Unlock()
			pending = pending[1:]
		}
	}
	commit := func(p pendingBatch) {
		for id, ts := range p.marks {
			t.cp.Advance(id, ts)
		}
	}
	send := func(sctx context.Context) {
		for len(pending) > 0 && sctx.Err() == nil {
			now := t.o.Now()
			if now.Before(notBefore) {
				retry.Reset(notBefore.Sub(now))
				return
			}
			p := pending[0]
			cred := ""
			if t.o.Credential != nil {
				cred = t.o.Credential()
			}
			_, err := t.o.Poster.Post(sctx, LogsPath, cred, p.body, logHeaders)
			if err == nil {
				commit(p)
				pending = pending[1:]
				failures, notBefore = 0, time.Time{}
				if lastErr != "" {
					t.o.Logf("Container logs: sending again.")
				}
				lastErr = ""
				continue
			}
			if sctx.Err() != nil {
				return
			}
			var api *client.APIError
			status := 0
			var retryAfter time.Duration
			if errors.As(err, &api) {
				status, retryAfter = api.Status, api.RetryAfter
			}
			switch status {
			case 429:
				// The telemetry quota is used up: pause logs only (metrics are unaffected).
				commit(p)
				pending = pending[1:]
				t.mu.Lock()
				t.droppedQuota += p.lines
				for _, q := range pending {
					t.droppedQuota += q.lines
					commit(q)
				}
				t.mu.Unlock()
				pending = nil
				pausedUntil = now.Add(quotaPause)
				t.o.Report("logs_quota", "The log quota of your plan is used up. Container logs are paused for 5 minutes; metrics are not affected.")
				if lastErr != "logs_quota" {
					t.o.Logf("Container logs paused for 5 minutes: the log quota of your plan is used up (metrics are not affected).")
				}
				lastErr = "logs_quota"
				return
			case 400, 413:
				commit(p)
				pending = pending[1:]
				t.mu.Lock()
				t.droppedFailed += p.lines
				t.mu.Unlock()
				t.o.Report("logs_rejected", "The server refused a batch of container logs: "+err.Error())
				continue
			case 401, 402, 403:
				failures++
				notBefore = now.Add(backoff.Unauthorized.Delay(failures))
			default:
				failures++
				wait := t.o.NetBackoff.Delay(failures)
				if retryAfter > 0 {
					wait = max(wait, min(retryAfter, quotaPause))
				}
				notBefore = now.Add(wait)
			}
			code := "logs_send_failed"
			t.o.Report(code, "Container logs could not be sent (they are kept for a while and retried): "+err.Error())
			if lastErr != code {
				t.o.Logf("Warning: container logs could not be sent: %v", err)
			}
			lastErr = code
			retry.Reset(notBefore.Sub(now))
			return
		}
	}

	for {
		select {
		case <-ctx.Done():
			// Final, short delivery attempt of what is buffered.
		drain:
			for {
				select {
				case r := <-t.records:
					cur.add(r, t.o.Now())
				default:
					break drain
				}
			}
			seal()
			fctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			if t.o.Now().After(pausedUntil) {
				notBefore = time.Time{}
				send(fctx)
			}
			cancel()
			return
		case r := <-t.records:
			now := t.o.Now()
			if now.Before(pausedUntil) {
				t.mu.Lock()
				t.droppedQuota++
				t.mu.Unlock()
				t.cp.Advance(r.c.id, r.ts)
				continue
			}
			wasEmpty := cur.empty()
			cur.add(r, now)
			if cur.bytes >= maxBatchBytes {
				seal()
				send(ctx)
			} else if wasEmpty {
				flush.Reset(t.o.FlushEvery)
			}
		case <-flush.C:
			seal()
			send(ctx)
		case <-retry.C:
			send(ctx)
		}
		now := t.o.Now()
		if now.Sub(lastSave) >= checkpointEvery {
			lastSave = now
			if err := t.cp.Save(); err != nil {
				t.o.Report("logs_checkpoint_failed", "Container log checkpoints could not be saved: "+err.Error())
			}
		}
		if now.Sub(lastDropReport) >= time.Minute {
			lastDropReport = now
			t.mu.Lock()
			rate := t.droppedRate
			t.droppedRate = 0
			t.mu.Unlock()
			if rate > 0 {
				t.o.Report("logs_dropped", fmt.Sprintf("%d log lines were dropped because a container wrote more than %d lines per second.", rate, maxLinesPerSecond))
			}
		}
	}
}

// Dropped reports the dropped line counters (rate limit, quota pause, failed batches).
func (t *Tailer) Dropped() (rate, quota, failed int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.droppedRate, t.droppedQuota, t.droppedFailed
}
