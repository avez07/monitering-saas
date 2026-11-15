package backoff

import (
	"testing"
	"time"
)

func fixed(v float64) func() float64 { return func() float64 { return v } }

func TestDelayGrowsExponentiallyAndIsCapped(t *testing.T) {
	p := Policy{Base: 5 * time.Second, Max: 2 * time.Minute, Jitter: 0.5, Rand: fixed(0.5)} // factor 1.0
	want := []time.Duration{
		5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second,
		80 * time.Second, 2 * time.Minute, 2 * time.Minute, 2 * time.Minute,
	}
	for i, w := range want {
		if got := p.Delay(i + 1); got != w {
			t.Errorf("Delay(%d) = %v, want %v", i+1, got, w)
		}
	}
	if got := p.Delay(0); got != 0 {
		t.Errorf("Delay(0) = %v, want 0", got)
	}
	// Absurd failure counts must not overflow into a negative or tiny delay.
	if got := p.Delay(10_000); got != 2*time.Minute {
		t.Errorf("Delay(10000) = %v, want the cap", got)
	}
}

func TestJitterBounds(t *testing.T) {
	low := Policy{Base: 10 * time.Second, Max: time.Minute, Jitter: 0.5, Rand: fixed(0)}
	high := Policy{Base: 10 * time.Second, Max: time.Minute, Jitter: 0.5, Rand: fixed(0.999999)}
	if got := low.Delay(1); got != 5*time.Second {
		t.Errorf("lowest jitter = %v, want 5s", got)
	}
	if got := high.Delay(1); got < 14*time.Second || got >= 15*time.Second {
		t.Errorf("highest jitter = %v, want just under 15s", got)
	}
}

func TestJitterIsRandomWithinRange(t *testing.T) {
	seen := map[time.Duration]bool{}
	for i := 0; i < 200; i++ {
		d := Network.Delay(3) // 20s ± 50%
		if d < 10*time.Second || d >= 30*time.Second {
			t.Fatalf("Delay(3) = %v, outside [10s, 30s)", d)
		}
		seen[d] = true
	}
	if len(seen) < 50 {
		t.Errorf("only %d distinct delays in 200 draws: jitter is not random", len(seen))
	}
}

func TestPoliciesMatchTheirPromises(t *testing.T) {
	// A 10-minute outage plus the longest network retry wait must fit in the 15-minute buffer.
	worst := time.Duration(float64(Network.Max) * (1 + Network.Jitter))
	if 10*time.Minute+worst >= 15*time.Minute {
		t.Errorf("worst-case retry wait %v is too long for the 15-minute buffer", worst)
	}
	// A revoked credential is retried slowly: never sooner than a few minutes, at most hourly-ish.
	for n := 1; n <= 20; n++ {
		d := Unauthorized.Delay(n)
		if d < 3*time.Minute || d > 80*time.Minute {
			t.Errorf("Unauthorized.Delay(%d) = %v, outside the slow-retry range", n, d)
		}
	}
}
