package remote

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseAdvancedDefaults(t *testing.T) {
	cfg, _, err := Parse([]byte(`{"id":"` + id + `","version":1,"settings":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	s := cfg.Settings
	if s.Collectors.Prometheus || s.Collectors.ContainerLogs.Enabled || s.Collectors.ContainerLogs.Include != nil {
		t.Errorf("advanced collectors must default to off: %+v", s.Collectors)
	}
	if s.Prometheus.Path != "/v1/prom/write" || s.Prometheus.ScrapeIntervalSeconds != 15 {
		t.Errorf("prometheus defaults: %+v", s.Prometheus)
	}
}

func TestParseAdvancedFields(t *testing.T) {
	doc := `{"id":"` + id + `","version":4,"plan":{"id":"pro","name":"Pro"},"settings":{
		"collectors":{"prometheus":true,"containerLogs":{"enabled":true,"include":["web","/api","web"],"exclude":[]},
		"services":[{"kind":"mssql","name":"sql"},{"kind":"redis","name":"cache","credentialsRef":"redis-main"}]},
		"prometheus":{"path":"/v1/prom/write","scrapeIntervalSeconds":30}}}`
	cfg, notes, err := Parse([]byte(doc))
	if err != nil || len(notes) != 0 {
		t.Fatalf("Parse: %v %v", err, notes)
	}
	c := cfg.Settings.Collectors
	if !c.Prometheus || !c.ContainerLogs.Enabled || !reflect.DeepEqual(c.ContainerLogs.Include, []string{"web", "api"}) || c.ContainerLogs.Exclude != nil {
		t.Errorf("collectors: %+v", c)
	}
	if c.Services[0].Port != 1433 || c.Services[1].CredentialsRef != "redis-main" {
		t.Errorf("services: %+v", c.Services)
	}
	if cfg.Settings.Prometheus.ScrapeIntervalSeconds != 30 || cfg.Plan != "Pro" {
		t.Errorf("prometheus %+v plan %q", cfg.Settings.Prometheus, cfg.Plan)
	}

	// Out-of-range scrape intervals are clamped, like the other intervals.
	for in, want := range map[string]int{"5": 15, "600": 60} {
		cfg, notes, err := Parse([]byte(`{"id":"` + id + `","version":1,"settings":{"prometheus":{"scrapeIntervalSeconds":` + in + `}}}`))
		if err != nil || cfg.Settings.Prometheus.ScrapeIntervalSeconds != want || len(notes) != 1 {
			t.Errorf("scrape %s: %+v %v %v", in, cfg.Settings.Prometheus, notes, err)
		}
	}

	// A plan name that is not a short plain word is ignored.
	cfg, _, _ = Parse([]byte(`{"id":"` + id + `","version":1,"plan":"Pro\nEvil log line","settings":{}}`))
	if cfg.Plan != "" {
		t.Errorf("plan %q", cfg.Plan)
	}
}

func TestParseRejectsBadAdvancedFields(t *testing.T) {
	bad := map[string]string{
		"prom string":       `{"collectors":{"prometheus":"yes"}}`,
		"logs not object":   `{"collectors":{"containerLogs":true}}`,
		"logs enabled str":  `{"collectors":{"containerLogs":{"enabled":"1"}}}`,
		"include not list":  `{"collectors":{"containerLogs":{"include":"web"}}}`,
		"include bad name":  `{"collectors":{"containerLogs":{"include":["web; rm -rf /"]}}}`,
		"exclude number":    `{"collectors":{"containerLogs":{"exclude":[1]}}}`,
		"path absolute url": `{"prometheus":{"path":"https://evil.example/write"}}`,
		"path other host":   `{"prometheus":{"path":"//evil.example/write"}}`,
		"path traversal":    `{"prometheus":{"path":"/v1/../../x"}}`,
		"path query":        `{"prometheus":{"path":"/v1/prom/write?x=1"}}`,
		"scrape string":     `{"prometheus":{"scrapeIntervalSeconds":"15"}}`,
		"bad cred ref":      `{"collectors":{"services":[{"kind":"redis","name":"r","credentialsRef":"../etc/shadow"}]}}`,
		"upper cred ref":    `{"collectors":{"services":[{"kind":"redis","name":"r","credentialsRef":"Redis"}]}}`,
		"long cred ref":     `{"collectors":{"services":[{"kind":"redis","name":"r","credentialsRef":"a12345678901234567890123456789012345678901"}]}}`,
	}
	for name, settings := range bad {
		if cfg, _, err := Parse([]byte(`{"id":"` + id + `","version":1,"settings":` + settings + `}`)); err == nil {
			t.Errorf("%s: accepted %+v", name, cfg.Settings)
		}
	}
	many := `[`
	for i := 0; i <= MaxLogContainers; i++ {
		if i > 0 {
			many += ","
		}
		many += `"c` + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `"`
	}
	many += `]`
	if _, _, err := Parse([]byte(`{"id":"` + id + `","version":1,"settings":{"collectors":{"containerLogs":{"include":` + many + `}}}}`)); err == nil {
		t.Error("accepted too many include entries")
	}
}

func TestAdvancedCacheRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remote-config.json")
	in := Config{ID: id, Version: 9, Plan: "Business", Settings: DefaultSettings()}
	in.Settings.Collectors.Prometheus = true
	in.Settings.Collectors.ContainerLogs = ContainerLogs{Enabled: true, Exclude: []string{"noisy"}}
	in.Settings.Collectors.Services = []Service{{Kind: "postgres", Name: "pg", Port: 5432, CredentialsRef: "pg-main"}}
	in.Settings.Prometheus.ScrapeIntervalSeconds = 20
	if err := SaveCache(path, in); err != nil {
		t.Fatal(err)
	}
	out, err := LoadCache(path)
	if err != nil || !reflect.DeepEqual(out, in) {
		t.Fatalf("round trip:\n got %+v\nwant %+v\n%v", out, in, err)
	}
}
