package cli

import (
	"os"
	"strings"
)

// inContainer reports whether this process runs inside a container (Docker, Podman, Kubernetes,
// LXC), using the marker file Docker creates and the control group names of process 1.
func inContainer() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	if _, err := os.Stat("/run/.containerenv"); err == nil {
		return true
	}
	data, err := os.ReadFile("/proc/1/cgroup")
	if err != nil {
		return false
	}
	return cgroupLooksLikeContainer(string(data))
}

func cgroupLooksLikeContainer(cgroup string) bool {
	for _, marker := range []string{"/docker", "/kubepods", "/containerd", "/lxc", "/libpod", "/crio-", "cri-containerd"} {
		if strings.Contains(cgroup, marker) {
			return true
		}
	}
	return false
}
