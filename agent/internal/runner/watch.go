package runner

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/yuktiops/agent/internal/docker"
	"github.com/yuktiops/agent/internal/services"
)

// snapshot is the latest container and service state, pre-encoded for the ingest payload. A nil
// field means "that collector is off or failed": the field is omitted so stored data is kept.
type snapshot struct {
	at         time.Time
	containers json.RawMessage
	services   json.RawMessage
}

// watchLoop runs the opt-in Docker and service collectors on the send interval. It is a separate
// goroutine, so a slow Docker daemon or a hanging port never delays sampling or sending.
func (r *runner) watchLoop(ctx context.Context) {
	var dk *docker.Collector
	svc := services.New()
	svc.Creds = r.creds
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-r.watchWake:
		}
		set := r.settings.Load().Settings
		snap := &snapshot{at: r.now()}
		if set.Collectors.Docker {
			if dk == nil {
				dk = docker.New(r.dockerSocket)
			}
			list, err := dk.Collect(ctx)
			switch {
			case err == nil:
				snap.containers, _ = json.Marshal(list)
			case errors.Is(err, docker.ErrDenied):
				r.errs.Report("docker_socket_denied", "The agent is not allowed to use the Docker socket. Add the yuktiops user to the docker group and restart the agent.")
			case errors.Is(err, docker.ErrUnavailable):
				r.errs.Report("collector_failed_docker", "Docker is turned on in the settings but the Docker socket is not available on this server.")
			case ctx.Err() == nil:
				r.errs.Report("collector_failed_docker", "Could not read container information: "+err.Error())
			}
		} else {
			dk = nil
		}
		if n := len(set.Collectors.Services); n > 0 {
			snap.services, _ = json.Marshal(svc.Check(ctx, set.Collectors.Services))
		}
		if snap.containers != nil || snap.services != nil {
			r.snap.Store(snap)
		} else {
			r.snap.Store(nil)
		}
		wait := r.seconds(set.SendIntervalSeconds)
		timer.Reset(wait)
	}
}

// currentSnapshot returns the fields to attach to an ingest request, or nils when the latest
// snapshot is stale (older than three send intervals) or the collector has been switched off.
func (r *runner) currentSnapshot() (containers, svcs json.RawMessage) {
	s := r.snap.Load()
	if s == nil {
		return nil, nil
	}
	set := r.settings.Load().Settings
	if r.now().Sub(s.at) > 3*r.seconds(set.SendIntervalSeconds) {
		return nil, nil
	}
	if set.Collectors.Docker {
		containers = s.containers
	}
	if len(set.Collectors.Services) > 0 {
		svcs = s.services
	}
	return containers, svcs
}
