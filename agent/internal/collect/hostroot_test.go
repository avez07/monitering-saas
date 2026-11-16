package collect

import (
	"path/filepath"
	"testing"
)

func TestNewAtResolvesPaths(t *testing.T) {
	c := newAt("")
	if c.ProcRoot != "/proc" || c.SysRoot != "/sys" || c.EtcRoot != "/etc" || c.HostRoot != "" {
		t.Errorf("without HOST_ROOT the paths must be the defaults: %+v", c)
	}
	c = newAt("/host")
	if c.ProcRoot != filepath.Join("/host", "proc") || c.SysRoot != filepath.Join("/host", "sys") ||
		c.EtcRoot != filepath.Join("/host", "etc") || c.HostRoot != "/host" {
		t.Errorf("host paths wrong: %+v", c)
	}
}

func TestHostMounts(t *testing.T) {
	in := []mountEntry{
		{Device: "0:1", Path: "/", FSType: "overlay"},
		{Device: "8:1", Path: "/host", FSType: "ext4"},
		{Device: "8:2", Path: "/host/boot", FSType: "ext4"},
		{Device: "8:3", Path: "/hostile", FSType: "ext4"},
	}
	if got := hostMounts(in, ""); len(got) != 4 {
		t.Errorf("without a host root the list must be unchanged, got %v", got)
	}
	got := hostMounts(append([]mountEntry{}, in...), "/host")
	if len(got) != 2 || got[0].Path != "/" || got[0].Device != "8:1" || got[1].Path != "/boot" {
		t.Errorf("host mounts = %v", got)
	}
	// Nothing mounted under the root: keep what there is rather than report no disks.
	if got := hostMounts([]mountEntry{{Path: "/data"}}, "/host"); len(got) != 1 || got[0].Path != "/data" {
		t.Errorf("fallback = %v", got)
	}
}
