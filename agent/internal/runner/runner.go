// Package runner is the long-running agent: it samples the system, buffers data points, sends
// them to YuktiOps and applies the settings it is told about.
//
// Two goroutines do the work. The sampler reads /proc on a fixed rhythm and never waits for the
// network, so a slow or unreachable backend cannot distort the measurements. The sender delivers
// what the sampler queued, retries with backoff, and keeps the backlog on disk while it cannot.
package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand/v2"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yuktiops/agent/internal/backoff"
	"github.com/yuktiops/agent/internal/buffer"
	"github.com/yuktiops/agent/internal/client"
	"github.com/yuktiops/agent/internal/collect"
	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/remote"
	"github.com/yuktiops/agent/internal/state"
)

const (
	// The backend accepts at most 120 points and 512 kB (after decompression) per request.
	// Back-fills are sent in chunks that stay well inside both limits.
	maxChunkPoints = 100
	maxChunkBytes  = 384 << 10
	// A clock that differs from the server's by more than this is reported (the backend uses
	// the same threshold before it corrects timestamps).
	clockSkewLimit = 120 * time.Second
	// After a failed settings download, wait this long before trying again.
	configRetryAfter = 5 * time.Minute
)

// Options configure a run.
type Options struct {
	Paths   config.Paths
	Version string
	Logger  *log.Logger
	Verbose bool
}

// Run runs the agent until ctx is cancelled. It returns config.ErrNotRegistered (wrapped) when
// the server has not been registered yet.
func Run(ctx context.Context, opts Options) error {
	r, err := newRunner(opts)
	if err != nil {
		return err
	}
	return r.run(ctx)
}

type runner struct {
	opts      Options
	log       *log.Logger
	cfg       config.File
	client    *client.Client
	collector *collect.Collector
	buf       *buffer.Buffer
	errs      *errorRegistry
	host      collect.HostInfo
	settings  atomic.Pointer[remote.Config]
	wake      chan struct{}
	watchWake chan struct{}
	snap      atomic.Pointer[snapshot]
	// dockerSocket overrides the default socket path (tests).
	dockerSocket string

	// Test hooks.
	now          func() time.Time
	seconds      func(n int) time.Duration // how long "n seconds" of a setting really is
	firstSample  time.Duration
	netBackoff   backoff.Policy
	authBackoff  backoff.Policy
	maxChunk     int
	configRetry  time.Duration
	onStateSaved func(state.State)

	// Owned by the sender goroutine.
	credential     string
	credentialStat credentialStamp
	st             state.State
	failures       int
	authFailures   int
	notBefore      time.Time
	chunkLimit     int
	rejectedConfig string
	nextConfigPull time.Time
	lastErrorKind  client.Kind
	warnedState    bool
	warnedBuffer   bool
	warnedClock    bool
}

type credentialStamp struct {
	modTime time.Time
	size    int64
}

func newRunner(opts Options) (*runner, error) {
	if opts.Logger == nil {
		opts.Logger = log.New(os.Stderr, "", 0)
	}
	cfg, err := config.LoadFile(opts.Paths.ConfigFile())
	if err != nil {
		return nil, fmt.Errorf("%s: %w", opts.Paths.ConfigFile(), err)
	}
	cred, err := config.LoadCredential(opts.Paths.CredentialFile())
	if err != nil {
		return nil, fmt.Errorf("%s: %w", opts.Paths.CredentialFile(), err)
	}
	cl, err := client.New(cfg.APIURL, cfg.Proxy, opts.Version)
	if err != nil {
		return nil, err
	}
	r := &runner{
		opts:        opts,
		log:         opts.Logger,
		cfg:         cfg,
		client:      cl,
		collector:   collect.New(),
		wake:        make(chan struct{}, 1),
		watchWake:   make(chan struct{}, 1),
		now:         time.Now,
		seconds:     func(n int) time.Duration { return time.Duration(n) * time.Second },
		firstSample: time.Second,
		netBackoff:  backoff.Network,
		authBackoff: backoff.Unauthorized,
		maxChunk:    maxChunkPoints,
		configRetry: configRetryAfter,
		credential:  cred,
	}
	r.credentialStat, _ = statCredential(opts.Paths.CredentialFile())
	return r, nil
}

func statCredential(path string) (credentialStamp, error) {
	info, err := os.Stat(path)
	if err != nil {
		return credentialStamp{}, err
	}
	return credentialStamp{modTime: info.ModTime(), size: info.Size()}, nil
}

func (r *runner) run(ctx context.Context) error {
	paths := r.opts.Paths
	if err := os.MkdirAll(paths.StateDir, 0o755); err != nil {
		r.log.Printf("Warning: cannot create %s (%v). The offline buffer and status will not be kept on disk.", paths.StateDir, err)
	}
	r.errs = newErrorRegistry(r.now)
	r.buf = buffer.Open(paths.BufferFile(), buffer.DefaultMaxAge, r.now)
	r.chunkLimit = r.maxChunk

	current := remote.Config{Settings: remote.DefaultSettings()}
	if cached, err := remote.LoadCache(paths.RemoteConfigFile()); err == nil {
		current = cached
	}
	r.settings.Store(&current)
	r.host = r.collector.Host()

	started := r.now()
	r.st = state.State{
		PID:        os.Getpid(),
		Version:    r.opts.Version,
		APIURL:     r.client.BaseURL(),
		Name:       r.cfg.Name,
		StartedAt:  started,
		Connection: state.Starting,
	}
	r.saveState()

	r.log.Printf("YuktiOps agent %s started: sending to %s every %ds (sampling every %ds). %s",
		r.opts.Version, r.client.BaseURL(), current.Settings.SendIntervalSeconds, current.Settings.SampleIntervalSeconds,
		"It only reads system statistics and makes outbound HTTPS requests.")
	if n := r.buf.Len(); n > 0 {
		r.log.Printf("Found %d unsent data points from before the restart; they will be sent now.", n)
		r.signal()
	}

	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); r.watchLoop(ctx) }()
	go func() { defer wg.Done(); r.sampleLoop(ctx) }()
	go func() { defer wg.Done(); r.sendLoop(ctx) }()
	wg.Wait()

	// Shutting down: whatever could not be sent stays on disk for the next start.
	if err := r.buf.Persist(); err != nil {
		r.log.Printf("Warning: could not save unsent data: %v", err)
	}
	r.st.Connection = state.Stopped
	r.st.NextRetryAt = nil
	r.saveState()
	r.log.Printf("YuktiOps agent stopped (%d unsent data points kept for the next start).", r.buf.Len())
	return nil
}

func (r *runner) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// ---- sampling -------------------------------------------------------------------------------

func enabled(c remote.Collectors) collect.Enabled {
	return collect.Enabled{
		CPU: c.CPU, Memory: c.Memory, Swap: c.Swap, Disk: c.Disk,
		DiskIO: c.DiskIO, Network: c.Network, Load: c.Load,
	}
}

func (r *runner) sampleLoop(ctx context.Context) {
	r.collector.Prime()
	window := make([]collect.Sample, 0, 8)
	first := true
	next := r.now().Add(r.firstSample)
	timer := time.NewTimer(r.firstSample)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			if len(window) > 0 {
				// Keep the samples taken since the last data point; skip the process scan to stop quickly.
				r.emit(window, r.settings.Load().Settings, false)
			}
			return
		case <-timer.C:
		}
		set := r.settings.Load().Settings
		window = append(window, r.collector.Sample(enabled(set.Collectors), r.errs.Report))
		perPoint := max(1, int(math.Round(float64(set.SendIntervalSeconds)/float64(set.SampleIntervalSeconds))))
		// The very first point goes out straight away so a new install shows up within seconds.
		if first || len(window) >= perPoint {
			r.emit(window, set, true)
			window = window[:0]
			first = false
		}
		// Keep a steady rhythm: schedule from the previous deadline, not from "now".
		interval := r.seconds(set.SampleIntervalSeconds)
		next = next.Add(interval)
		wait := next.Sub(r.now())
		if wait <= 0 || wait > interval {
			wait = interval
			next = r.now().Add(interval)
		}
		timer.Reset(wait)
	}
}

// emit turns the samples of one send interval into a data point and queues it.
func (r *runner) emit(window []collect.Sample, set remote.Settings, scanProcesses bool) {
	var processes []collect.Process
	if scanProcesses && set.Collectors.Processes {
		processes = r.collector.Processes(r.errs.Report)
	}
	point := collect.Aggregate(window, processes)
	data, err := json.Marshal(point)
	if err != nil {
		r.errs.Report("collector_failed_encode", "A data point could not be encoded: "+err.Error())
		return
	}
	r.buf.Add(window[len(window)-1].Time, data)
	r.signal()
}

// ---- sending --------------------------------------------------------------------------------

func (r *runner) sendLoop(ctx context.Context) {
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.wake:
		case <-timer.C:
		}
		if wait := r.trySend(ctx); wait > 0 {
			timer.Reset(wait)
		}
	}
}

// reloadCredential notices when `yuktiops-agent register` has written a new credential, so a
// re-registered server reconnects without a restart.
func (r *runner) reloadCredential() bool {
	stamp, err := statCredential(r.opts.Paths.CredentialFile())
	if err != nil || stamp == r.credentialStat {
		return false
	}
	cred, err := config.LoadCredential(r.opts.Paths.CredentialFile())
	if err != nil {
		return false
	}
	r.credentialStat = stamp
	if cred == r.credential {
		return false
	}
	r.credential = cred
	return true
}

// trySend delivers the backlog. It returns how long to wait before the next attempt when data
// is still waiting, or 0 when there is nothing left to do until the next data point.
func (r *runner) trySend(ctx context.Context) time.Duration {
	now := r.now()
	if r.reloadCredential() {
		r.log.Printf("A new credential was found (the server was registered again). Reconnecting.")
		r.failures, r.authFailures = 0, 0
		r.notBefore = time.Time{}
	}
	if now.Before(r.notBefore) {
		// Still backing off: make sure the growing backlog is safe on disk, then wait.
		r.persist()
		r.saveState()
		return r.notBefore.Sub(now)
	}

	for ctx.Err() == nil {
		chunk := r.buf.Peek(r.chunkLimit, maxChunkBytes)
		if len(chunk) == 0 {
			break
		}
		lastSeq := chunk[len(chunk)-1].Seq
		pending := r.errs.Pending()
		containers, svcs := r.currentSnapshot()
		samples := make([]json.RawMessage, len(chunk))
		for i, e := range chunk {
			samples[i] = e.Data
		}
		attempt := r.now()
		r.st.LastAttemptAt = &attempt
		res, err := r.client.Ingest(ctx, r.credential, &client.IngestRequest{
			SentAt: collect.FormatTime(attempt),
			Agent: client.AgentInfo{
				Version:  truncate(r.opts.Version, 40),
				OS:       r.host.OS,
				Arch:     runtime.GOARCH,
				Cores:    r.host.Cores,
				RAMBytes: r.host.RAMBytes,
			},
			Samples:    samples,
			Errors:     pending,
			Containers: containers,
			Services:   svcs,
		})
		if err != nil {
			if ctx.Err() != nil {
				break // shutting down: not a real failure
			}
			if r.onFailure(err, len(chunk), lastSeq, pending) {
				continue
			}
			break
		}
		r.buf.Ack(lastSeq)
		r.errs.MarkSent(pending)
		r.onSuccess(res, len(chunk))
		r.pullConfigIfChanged(ctx, res)
	}

	r.persist()
	r.saveState()
	if wait := r.notBefore.Sub(r.now()); wait > 0 && r.buf.Len() > 0 {
		return wait
	}
	return 0
}

// maxRetryAfter caps how long a server hint can silence the agent; the buffer holds 15 minutes.
const maxRetryAfter = 5 * time.Minute

// retryAfterDelay caps the hint at maxRetryAfter and adds 0-20% jitter.
func retryAfterDelay(hint time.Duration, rnd func() float64) time.Duration {
	hint = min(hint, maxRetryAfter)
	if rnd == nil {
		rnd = rand.Float64
	}
	return min(hint+time.Duration(float64(hint)*0.2*rnd()), maxRetryAfter)
}

func (r *runner) onSuccess(res *client.IngestResponse, sent int) {
	now := r.now()
	if r.st.Connection != state.Connected {
		if r.st.LastSuccessAt == nil {
			r.log.Printf("Connected: first data sent to %s.", r.client.Host())
		} else {
			r.log.Printf("Connected again: sending data to %s.", r.client.Host())
		}
	}
	if sent > 1 {
		r.log.Printf("Sent %d buffered data points (%d stored, %d too old or duplicated).", sent, res.Accepted, res.Dropped)
	} else if r.opts.Verbose {
		r.log.Printf("Sent 1 data point (accepted %d, dropped %d).", res.Accepted, res.Dropped)
	}
	r.failures, r.authFailures = 0, 0
	r.notBefore = time.Time{}
	r.lastErrorKind = client.KindNone
	r.st.Connection = state.Connected
	r.st.LastSuccessAt = &now
	r.st.LastError, r.st.LastErrorCode, r.st.LastErrorAt = "", "", nil
	r.st.ConsecutiveFailures = 0
	r.st.NextRetryAt = nil
	if r.buf.Len() == 0 {
		r.chunkLimit = r.maxChunk
	}

	r.st.ClockOffsetSeconds = 0
	if !res.ServerTime.IsZero() {
		if offset := res.ServerTime.Sub(now); offset > clockSkewLimit || offset < -clockSkewLimit {
			r.st.ClockOffsetSeconds = math.Round(offset.Seconds())
			if !r.warnedClock {
				r.warnedClock = true
				r.log.Printf("Warning: this server's clock is about %s. Data is still stored at the right time. Fix it with: sudo timedatectl set-ntp true",
					describeOffset(offset))
			}
		} else {
			r.warnedClock = false
		}
	}
}

func describeOffset(offset time.Duration) string {
	amount := offset
	direction := "behind"
	if offset < 0 {
		amount = -offset
		direction = "ahead"
	}
	return fmt.Sprintf("%s %s", amount.Round(time.Second), direction)
}

// onFailure records a failed send. It returns true when the same loop should try again at once
// (after shrinking the batch), false when the sender must wait.
func (r *runner) onFailure(err error, sent int, lastSeq uint64, pending []client.ErrorReport) bool {
	now := r.now()
	kind := client.Classify(err)
	explanation := r.client.Explain(err)
	r.st.LastError, r.st.LastErrorCode, r.st.LastErrorAt = explanation, kind.Code(), &now

	switch kind {
	case client.KindUnauthorized:
		// The credential was revoked or the server removed. Retrying cannot help until someone
		// registers the server again, so only probe occasionally (and watch the credential file).
		r.authFailures++
		wait := r.authBackoff.Delay(r.authFailures)
		r.notBefore = now.Add(wait)
		if r.st.Connection != state.Disconnected {
			r.log.Printf("Disconnected: %s", explanation)
			r.log.Printf("The agent keeps running but will only check back occasionally (next check in about %s). "+
				"To reconnect this server run: sudo yuktiops-agent register --key=<your API key>", wait.Round(time.Minute))
		}
		r.st.Connection = state.Disconnected
		r.client.CloseIdle()

	case client.KindRejected:
		var api *client.APIError
		errors.As(err, &api)
		if sent > 1 {
			// One bad point must not take the whole backlog with it: retry with half the batch
			// until the offending point is isolated.
			r.chunkLimit = max(1, sent/2)
			return true
		}
		r.buf.Ack(lastSeq)
		r.errs.MarkSent(pending)
		r.errs.Report("payload_rejected", "The server refused a data point and it was discarded: "+explanation)
		r.log.Printf("Warning: a data point was refused by the server and discarded. %s", explanation)
		r.failures++
		r.notBefore = now.Add(r.netBackoff.Delay(r.failures))
		r.st.Connection = state.Retrying

	default:
		r.failures++
		wait := r.netBackoff.Delay(r.failures)
		// 503/429 with Retry-After: the backend is shedding load. Keep buffering and wait at least
		// as long as it asks (capped, with jitter so agents do not return in lockstep).
		var api *client.APIError
		if errors.As(err, &api) && api.RetryAfter > 0 && (api.Status == 503 || api.Status == 429) {
			wait = max(wait, retryAfterDelay(api.RetryAfter, r.netBackoff.Rand))
		}
		r.notBefore = now.Add(wait)
		if r.st.Connection != state.Retrying || kind != r.lastErrorKind {
			r.log.Printf("Not connected: %s Data is being buffered (up to 15 minutes) and the agent keeps retrying.", explanation)
		} else if r.opts.Verbose {
			r.log.Printf("Still not connected (attempt %d, next in %s): %s", r.failures, wait.Round(time.Second), explanation)
		}
		r.st.Connection = state.Retrying
	}
	r.lastErrorKind = kind
	r.st.ConsecutiveFailures = r.failures + r.authFailures
	retry := r.notBefore
	r.st.NextRetryAt = &retry
	return false
}

// pullConfigIfChanged downloads the settings when the backend announces a different profile or
// version than the one in use, validates them and applies them without a restart.
func (r *runner) pullConfigIfChanged(ctx context.Context, res *client.IngestResponse) {
	announced := res.Config
	current := r.settings.Load()
	if announced.ID == "" && res.ConfigVersion > 0 {
		if res.ConfigVersion == current.Version {
			return
		}
		// 202 answers carry only a version number: pull when it differs from the one in use.
		announced.ID, announced.Version = current.ID, res.ConfigVersion
		if announced.ID == "" {
			announced.ID = "version"
		}
	}
	if announced.ID == "" || (announced.ID == current.ID && announced.Version == current.Version) {
		return
	}
	key := fmt.Sprintf("%s/%d", announced.ID, announced.Version)
	now := r.now()
	if key == r.rejectedConfig || now.Before(r.nextConfigPull) {
		return
	}
	doc, err := r.client.Config(ctx, r.credential)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		r.nextConfigPull = now.Add(r.configRetry)
		r.errs.Report("config_pull_failed", "New settings could not be downloaded: "+r.client.Explain(err))
		r.log.Printf("Warning: new settings could not be downloaded (%s). Keeping the current settings.", r.client.Explain(err))
		return
	}
	cfg, notes, err := remote.Parse(doc.Body)
	if err != nil {
		// Do not ask for the same broken document again; wait for a new version.
		r.rejectedConfig = key
		r.errs.Report("config_invalid", "The settings sent by the server were not valid and were ignored: "+err.Error())
		r.log.Printf("Warning: the settings sent by the server were not valid and were ignored (%v). Keeping the current settings.", err)
		return
	}
	r.settings.Store(&cfg)
	select {
	case r.watchWake <- struct{}{}:
	default:
	}
	if err := remote.SaveCache(r.opts.Paths.RemoteConfigFile(), cfg); err != nil && !r.warnedState {
		r.warnedState = true
		r.log.Printf("Warning: could not cache the settings in %s: %v", r.opts.Paths.StateDir, err)
	}
	if len(notes) > 0 {
		r.errs.Report("config_adjusted", "Some settings were out of range and were adjusted: "+strings.Join(notes, "; "))
	}
	r.log.Printf("Settings updated (profile %s, version %d): %s", cfg.ID, cfg.Version, describeSettings(cfg.Settings))
}

func describeSettings(s remote.Settings) string {
	var off []string
	for name, on := range map[string]bool{
		"cpu": s.Collectors.CPU, "memory": s.Collectors.Memory, "swap": s.Collectors.Swap, "disk": s.Collectors.Disk,
		"disk activity": s.Collectors.DiskIO, "network": s.Collectors.Network, "load": s.Collectors.Load, "processes": s.Collectors.Processes,
	} {
		if !on {
			off = append(off, name)
		}
	}
	text := fmt.Sprintf("send every %ds, sample every %ds", s.SendIntervalSeconds, s.SampleIntervalSeconds)
	if len(off) == 0 {
		return text + ", all collectors on."
	}
	sortStrings(off)
	return text + ", switched off: " + strings.Join(off, ", ") + "."
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func (r *runner) persist() {
	if err := r.buf.Persist(); err != nil {
		r.errs.Report("buffer_write_failed", "Unsent data could not be saved to disk: "+err.Error())
		if !r.warnedBuffer {
			r.warnedBuffer = true
			r.log.Printf("Warning: unsent data could not be saved to %s (%v). It is kept in memory only.", r.opts.Paths.BufferFile(), err)
		}
		return
	}
	r.warnedBuffer = false
}

func (r *runner) saveState() {
	now := r.now()
	current := r.settings.Load()
	r.st.UpdatedAt = now
	r.st.Buffered = r.buf.Len()
	r.st.OldestBufferedAt = nil
	if oldest, ok := r.buf.Oldest(); ok {
		r.st.OldestBufferedAt = &oldest
	}
	r.st.ConfigID, r.st.ConfigVersion = current.ID, current.Version
	r.st.SendIntervalSeconds = current.Settings.SendIntervalSeconds
	r.st.SampleIntervalSeconds = current.Settings.SampleIntervalSeconds
	if err := state.Save(r.opts.Paths.StateFile(), r.st); err != nil && !r.warnedState {
		r.warnedState = true
		r.log.Printf("Warning: could not write %s (%v). `yuktiops-agent status` will not be accurate.", r.opts.Paths.StateFile(), err)
	}
	if r.onStateSaved != nil {
		r.onStateSaved(r.st)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
