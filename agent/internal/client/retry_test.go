package client

import (
	"net/http"
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	cases := map[string]time.Duration{
		"": 0, "30": 30 * time.Second, "-5": 0, "junk": 0,
		now.Add(90 * time.Second).UTC().Format(http.TimeFormat): 90 * time.Second,
		now.Add(-time.Minute).UTC().Format(http.TimeFormat):     0,
	}
	for in, want := range cases {
		if got := parseRetryAfter(in, now); got != want {
			t.Errorf("%q: got %s want %s", in, got, want)
		}
	}
}
