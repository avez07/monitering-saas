//go:build linux

package cli

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"
)

// stopProcess asks an agent started outside systemd to stop. It only signals a process that
// really is the agent (checked through /proc), never an unrelated process that reused the pid.
func stopProcess(pid int) {
	if pid == os.Getpid() {
		return
	}
	comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(comm)), "yuktiops-agent") {
		return
	}
	_ = syscall.Kill(pid, syscall.SIGTERM)
	for i := 0; i < 50; i++ {
		if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); err != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
