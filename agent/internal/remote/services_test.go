package remote

import "testing"

func TestParseDockerAndServices(t *testing.T) {
	doc := `{"id":"` + id + `","version":2,"settings":{"collectors":{"docker":true,"services":[
		{"kind":"systemd","name":"nginx"},{"kind":"redis","name":"redis"},
		{"kind":"port","name":"ssh","port":22,"host":"127.0.0.1"},
		{"kind":"nginx","name":"web","url":"http://127.0.0.1/nginx_status"}]}}}`
	cfg, _, err := Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	c := cfg.Settings.Collectors
	if !c.Docker || len(c.Services) != 4 || c.Services[1].Port != 6379 {
		t.Errorf("got %+v", c)
	}
	// Default: docker off, no services.
	cfg, _, _ = Parse([]byte(`{"id":"` + id + `","version":1,"settings":{}}`))
	if cfg.Settings.Collectors.Docker || len(cfg.Settings.Collectors.Services) != 0 {
		t.Error("docker must be opt-in")
	}
}

func TestParseRejectsMalformedServices(t *testing.T) {
	bad := []string{
		`[{"kind":"shell","name":"x"}]`,
		`[{"kind":"systemd","name":"nginx; rm -rf /"}]`,
		`[{"kind":"systemd","name":"a"},{"kind":"systemd","name":"A"}]`,
		`[{"kind":"port","name":"ssh"}]`,
		`[{"kind":"port","name":"ssh","port":70000}]`,
		`[{"kind":"nginx","name":"n"}]`,
		`[{"kind":"nginx","name":"n","url":"file:///etc/passwd"}]`,
		`[{"kind":"redis","name":"r","host":"a b"}]`,
		`"nginx"`,
		`[1]`,
	}
	for _, s := range bad {
		doc := `{"id":"` + id + `","version":1,"settings":{"collectors":{"services":` + s + `}}}`
		if _, _, err := Parse([]byte(doc)); err == nil {
			t.Errorf("accepted %s", s)
		}
	}
	doc := `{"id":"` + id + `","version":1,"settings":{"collectors":{"docker":"yes"}}}`
	if _, _, err := Parse([]byte(doc)); err == nil {
		t.Error("accepted non-boolean docker")
	}
}
