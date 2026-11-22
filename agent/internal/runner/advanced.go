package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/yuktiops/agent/internal/client"
	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/docker"
	"github.com/yuktiops/agent/internal/prom"
	"github.com/yuktiops/agent/internal/remote"
)

// The advanced collectors (Prometheus remote_write and container logs) are started and stopped
// whenever the settings change, without restarting the agent. A plan upgrade or downgrade reaches
// the agent as a new settings version within one send interval.

type background struct {
	key    string
	cancel context.CancelFunc
	done   chan error
}

func (r *runner) start(ctx context.Context, key string, fn func(context.Context) error) *background {
	bctx, cancel := context.WithCancel(ctx)
	b := &background{key: key, cancel: cancel, done: make(chan error, 1)}
	go func() { b.done <- fn(bctx) }()
	return b
}

func (b *background) stop() {
	if b == nil {
		return
	}
	b.cancel()
	<-b.done
}

func (b *background) doneChan() <-chan error {
	if b == nil {
		return nil
	}
	return b.done
}

func configKey(c *remote.Config) string { return fmt.Sprintf("%s/%d", c.ID, c.Version) }

// promKey changes whenever something the running Prometheus collector depends on changes.
func promKey(s remote.Settings) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s|%d|%t", s.Prometheus.Path, s.Prometheus.ScrapeIntervalSeconds, s.Collectors.Docker)
	for _, svc := range s.Collectors.Services {
		if svc.CredentialsRef != "" {
			fmt.Fprintf(&b, "|%s:%s:%s:%d:%s", svc.Kind, svc.Name, svc.Host, svc.Port, svc.CredentialsRef)
		}
	}
	return b.String()
}

func logsKey(l remote.ContainerLogs) string {
	return strings.Join(l.Include, ",") + "|" + strings.Join(l.Exclude, ",")
}

func planLabel(c *remote.Config) string {
	if c.Plan != "" {
		return c.Plan
	}
	return "premium"
}

// advancedLoop keeps the advanced collectors in line with the current settings.
func (r *runner) advancedLoop(ctx context.Context) {
	var metrics, logs *background
	blocked := ""   // settings version for which the API answered 402
	failedKey := "" // settings for which the collector could not start
	warnedOS := ""
	defer func() {
		metrics.stop()
		logs.stop()
	}()
	for {
		cfg := r.settings.Load()
		set := cfg.Settings

		// Prometheus remote_write.
		wantMetrics := set.Collectors.Prometheus && blocked != configKey(cfg)
		if wantMetrics && !r.promSupported {
			if warnedOS != configKey(cfg) {
				warnedOS = configKey(cfg)
				r.log.Printf("Advanced metrics are included in the plan but need a Linux host; they stay off on %s.", runtime.GOOS)
				r.errs.Report("prom_unsupported_os", "Advanced metrics need a Linux host; they are off on "+runtime.GOOS+".")
			}
			wantMetrics = false
		}
		key := promKey(set)
		if wantMetrics && failedKey == key {
			wantMetrics = false
		}
		switch {
		case wantMetrics && metrics == nil:
			r.log.Printf("Advanced metrics on (plan %s): sending node, container and database metrics every %ds.",
				planLabel(cfg), set.Prometheus.ScrapeIntervalSeconds)
			snapshot := *cfg
			metrics = r.start(ctx, key, func(c context.Context) error { return r.runProm(c, &snapshot) })
		case wantMetrics && metrics.key != key:
			metrics.stop() // new interval, path or services: restart quietly
			snapshot := *cfg
			metrics = r.start(ctx, key, func(c context.Context) error { return r.runProm(c, &snapshot) })
		case !wantMetrics && metrics != nil:
			metrics.stop()
			metrics = nil
			r.log.Printf("Advanced metrics off")
		}

		// Container logs.
		wantLogs := set.Collectors.ContainerLogs.Enabled
		lkey := logsKey(set.Collectors.ContainerLogs)
		switch {
		case wantLogs && logs == nil:
			r.log.Printf("Container logs on (%s).", describeLogs(set.Collectors.ContainerLogs))
			snapshot := *cfg
			logs = r.start(ctx, lkey, func(c context.Context) error { return r.runLogs(c, &snapshot) })
		case wantLogs && logs.key != lkey:
			logs.stop()
			r.log.Printf("Container logs: now collecting %s.", describeLogs(set.Collectors.ContainerLogs))
			snapshot := *cfg
			logs = r.start(ctx, lkey, func(c context.Context) error { return r.runLogs(c, &snapshot) })
		case !wantLogs && logs != nil:
			logs.stop()
			logs = nil
			r.log.Printf("Container logs off")
		}

		select {
		case <-ctx.Done():
			return
		case <-r.advWake:
		case err := <-metrics.doneChan():
			metrics = nil
			switch {
			case errors.Is(err, prom.ErrNotEntitled):
				blocked = configKey(r.settings.Load())
				r.log.Printf("Advanced metrics off (the server says the plan does not include them; waiting for new settings).")
			case err != nil:
				failedKey = key
				r.errs.Report("prom_failed", "Advanced metrics could not start: "+err.Error())
				r.log.Printf("Warning: advanced metrics could not start (%v). They stay off until the settings change.", err)
			}
		case err := <-logs.doneChan():
			logs = nil
			if err != nil && ctx.Err() == nil {
				r.errs.Report("logs_failed", "Container log collection stopped: "+err.Error())
			}
			// Started again on the next settings change or wake-up.
			select {
			case <-ctx.Done():
				return
			case <-r.advWake:
			case <-time.After(time.Minute):
			}
		}
		if failedKey != "" && failedKey != promKey(r.settings.Load().Settings) {
			failedKey = ""
		}
	}
}

func describeLogs(l remote.ContainerLogs) string {
	text := "all running containers"
	if len(l.Include) > 0 {
		text = "containers " + strings.Join(l.Include, ", ")
	}
	if len(l.Exclude) > 0 {
		text += " except " + strings.Join(l.Exclude, ", ")
	}
	return text
}

func (r *runner) wakeAdvanced() {
	select {
	case r.advWake <- struct{}{}:
	default:
	}
}

// currentCredential is safe to call from any goroutine.
func (r *runner) currentCredential() string {
	if p := r.credShared.Load(); p != nil {
		return *p
	}
	return ""
}

func (r *runner) agentID() string {
	if r.cfg.AgentID != "" {
		return r.cfg.AgentID
	}
	return r.cfg.Name
}

// hostName is the name of the monitored host: inside the Docker agent it is read from the host's
// /etc/hostname, since the container has its own.
func hostName(hostRoot, fallback string) string {
	if hostRoot != "" {
		if data, err := os.ReadFile(filepath.Join(hostRoot, "etc", "hostname")); err == nil {
			if name := strings.TrimSpace(string(data)); name != "" && len(name) <= 253 {
				return name
			}
		}
	}
	if name, err := os.Hostname(); err == nil && name != "" {
		return name
	}
	return fallback
}

// defaultRunProm is the real Prometheus collector.
func (r *runner) defaultRunProm(ctx context.Context, cfg *remote.Config) error {
	set := cfg.Settings
	pc, err := client.New(r.cfg.APIURL, r.cfg.Proxy, r.opts.Version)
	if err != nil {
		return err
	}
	c, err := prom.New(prom.Options{
		Poster:       pc,
		Credential:   r.currentCredential,
		Path:         set.Prometheus.Path,
		Interval:     r.seconds(set.Prometheus.ScrapeIntervalSeconds),
		AgentID:      r.agentID(),
		NodeName:     r.hostName,
		HostRoot:     config.HostRoot(),
		Docker:       set.Collectors.Docker,
		DockerSocket: r.dockerSocket,
		Services:     set.Collectors.Services,
		Creds:        r.creds,
		Report:       r.errs.Report,
		Logf:         r.verboseLogf,
	})
	if err != nil {
		return err
	}
	return c.Run(ctx)
}

// defaultRunLogs is the real container log tailer.
func (r *runner) defaultRunLogs(ctx context.Context, cfg *remote.Config) error {
	lc, err := client.New(r.cfg.APIURL, r.cfg.Proxy, r.opts.Version)
	if err != nil {
		return err
	}
	logs := cfg.Settings.Collectors.ContainerLogs
	t := docker.NewTailer(docker.TailOptions{
		Socket:         r.dockerSocket,
		Include:        logs.Include,
		Exclude:        logs.Exclude,
		CheckpointFile: r.opts.Paths.LogCheckpointFile(),
		AgentID:        r.agentID(),
		HostName:       r.hostName,
		Version:        r.opts.Version,
		Poster:         lc,
		Credential:     r.currentCredential,
		Report:         r.errs.Report,
		Logf:           r.log.Printf,
	})
	return t.Run(ctx)
}

func (r *runner) verboseLogf(format string, args ...any) {
	if r.opts.Verbose || strings.HasPrefix(format, "Warning") {
		r.log.Printf(format, args...)
	}
}
