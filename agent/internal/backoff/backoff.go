// Package backoff computes retry delays: exponential, capped, with random jitter so that many
// agents recovering from the same outage do not all hit the backend in the same second.
package backoff

import (
	"math/rand/v2"
	"time"
)

// Policy describes one retry schedule.
type Policy struct {
	Base   time.Duration // delay after the first failure, before jitter
	Max    time.Duration // cap on the delay, before jitter
	Jitter float64       // 0.5 means the delay is multiplied by a random factor in [0.5, 1.5)
	// Rand returns a number in [0, 1). Nil uses math/rand. Tests inject a fixed value.
	Rand func() float64
}

// Network is used when the backend cannot be reached or answers with an error: 5s, 10s, 20s …
// capped at 2 minutes. The cap is deliberately short: with the 15-minute offline buffer, a
// 10-minute outage plus the longest possible wait (3 minutes) still back-fills completely.
var Network = Policy{Base: 5 * time.Second, Max: 2 * time.Minute, Jitter: 0.5}

// Unauthorized is used after a 401/403 (credential revoked or server removed). Retrying cannot
// help until someone re-registers the server, so the agent only probes occasionally:
// 5, 10, 20, 40 minutes, then hourly.
var Unauthorized = Policy{Base: 5 * time.Minute, Max: time.Hour, Jitter: 0.25}

// Delay returns how long to wait after the given number of consecutive failures (1 = first).
func (p Policy) Delay(failures int) time.Duration {
	if failures < 1 {
		return 0
	}
	d := p.Base
	for i := 1; i < failures && d < p.Max; i++ {
		d *= 2
	}
	if d > p.Max || d <= 0 {
		d = p.Max
	}
	r := rand.Float64
	if p.Rand != nil {
		r = p.Rand
	}
	factor := 1 - p.Jitter + 2*p.Jitter*r()
	return time.Duration(float64(d) * factor)
}
