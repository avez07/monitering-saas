package cli

import (
	"strings"
	"testing"
)

func TestCgroupLooksLikeContainer(t *testing.T) {
	if !cgroupLooksLikeContainer("12:cpu:/docker/abcdef\n") || !cgroupLooksLikeContainer("0::/kubepods/burstable/pod1\n") {
		t.Error("container cgroups should be detected")
	}
	if cgroupLooksLikeContainer("0::/init.scope\n") || cgroupLooksLikeContainer("") {
		t.Error("a plain host must not look like a container")
	}
}

func TestDoctorContainerCheck(t *testing.T) {
	d := &Doctor{InContainer: func() bool { return false }}
	if _, show := d.checkContainer(); show {
		t.Error("nothing should be shown outside a container")
	}

	d = &Doctor{InContainer: func() bool { return true }}
	r, show := d.checkContainer()
	if !show || r.Status != StatusWarn || !strings.Contains(r.Detail, "running in a container without host mounts: you will only see the container") ||
		!strings.Contains(r.Fix, "HOST_ROOT=/host") || !strings.Contains(r.Fix, "-v /:/host:ro") {
		t.Errorf("no host mounts: %+v", r)
	}

	d = &Doctor{InContainer: func() bool { return true }, HostRoot: "/host", DirExists: func(string) bool { return false }}
	if r, _ := d.checkContainer(); r.Status != StatusWarn || !strings.Contains(r.Detail, "HOST_ROOT is /host") {
		t.Errorf("host root not mounted: %+v", r)
	}

	d.DirExists = func(p string) bool { return strings.HasSuffix(p, "proc") }
	if r, _ := d.checkContainer(); r.Status != StatusOK {
		t.Errorf("mounted host should be OK: %+v", r)
	}
}
