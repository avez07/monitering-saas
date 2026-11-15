package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/state"
)

// ServiceState is what systemd says about the agent's service.
type ServiceState struct {
	Systemd bool   // systemd is the init system of this machine
	Active  string // "active", "inactive", "failed", "activating", ... ("" when unknown)
	Enabled string // "enabled", "disabled", ... ("" when unknown)
}

// systemdState asks systemd about the service. It never fails: on machines without systemd
// (containers, WSL1) it simply reports Systemd=false.
func systemdState(name string) ServiceState {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return ServiceState{}
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return ServiceState{}
	}
	out := func(arg string) string {
		b, _ := exec.Command("systemctl", arg, name).Output()
		return strings.TrimSpace(string(b))
	}
	return ServiceState{Systemd: true, Active: out("is-active"), Enabled: out("is-enabled")}
}

// ago says how long ago t was in plain words.
func ago(now, t time.Time) string {
	d := now.Sub(t)
	if d < 0 {
		d = 0
	}
	switch {
	case d < 2*time.Second:
		return "just now"
	case d < 90*time.Second:
		return fmt.Sprintf("%d seconds ago", int(d.Seconds()))
	case d < 90*time.Minute:
		return fmt.Sprintf("%d minutes ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d hours ago", int(d.Hours()))
	}
	return fmt.Sprintf("%d days ago", int(d.Hours()/24))
}

// statusReport builds the plain-language status text and says whether everything is fine.
func statusReport(paths config.Paths, svc ServiceState, now time.Time, version string) (text string, healthy bool) {
	var b strings.Builder
	fmt.Fprintf(&b, "YuktiOps agent %s\n", version)

	// /etc/yuktiops is private to root and the yuktiops group, so a normal user may not be able to
	// read it. Status then relies on the world-readable status file the agent keeps.
	file, err := config.LoadFile(paths.ConfigFile())
	switch {
	case errors.Is(err, config.ErrNotRegistered):
		b.WriteString("Status: not set up yet. This server is not registered.\n")
		b.WriteString("Fix:    sudo yuktiops-agent register --key=<your API key>\n")
		return b.String(), false
	case err != nil && !os.IsPermission(err):
		fmt.Fprintf(&b, "Status: the settings file cannot be used: %v\n", err)
		b.WriteString("Fix:    correct or delete it, then register again. Error code: config_invalid\n")
		return b.String(), false
	}
	if _, err := os.Stat(paths.CredentialFile()); err != nil && !os.IsPermission(err) {
		b.WriteString("Status: this server's credential is missing.\n")
		b.WriteString("Fix:    register again: sudo yuktiops-agent register --key=<your API key>\n")
		return b.String(), false
	}

	st, stErr := state.Load(paths.StateFile())
	if file.APIURL == "" && stErr == nil {
		file.APIURL, file.Name = st.APIURL, st.Name
	}
	staleAfter := 2*time.Minute + 2*time.Duration(st.SendIntervalSeconds)*time.Second
	fresh := stErr == nil && st.Connection != state.Stopped && now.Sub(st.UpdatedAt) < staleAfter
	running := svc.Active == "active" || svc.Active == "activating" || (!svc.Systemd && fresh)

	switch {
	case running:
		b.WriteString("Service:    running")
		if svc.Systemd && svc.Enabled == "enabled" {
			b.WriteString(" (starts automatically on boot)")
		}
		b.WriteString("\n")
	case svc.Systemd:
		fmt.Fprintf(&b, "Service:    NOT running (systemd says: %s)\n", orUnknown(svc.Active))
		b.WriteString("Fix:        sudo systemctl enable --now yuktiops-agent   then   sudo journalctl -u yuktiops-agent -n 50\n")
	default:
		b.WriteString("Service:    NOT running\n")
		b.WriteString("Fix:        start it with: sudo systemctl enable --now yuktiops-agent\n")
	}
	if svc.Systemd && svc.Enabled != "" && svc.Enabled != "enabled" && running {
		fmt.Fprintf(&b, "Warning:    the service will not start after a reboot (it is %s). Run: sudo systemctl enable yuktiops-agent\n", svc.Enabled)
	}
	name := file.Name
	if name == "" {
		name = "this server"
	}
	fmt.Fprintf(&b, "Server:     %s, sending to %s\n", name, file.APIURL)

	if stErr != nil {
		b.WriteString("Connection: no data sent yet (the agent has not written its status file).\n")
		if !running {
			return b.String(), false
		}
		return b.String(), false
	}
	healthy = running && st.Connection == state.Connected
	switch st.Connection {
	case state.Connected:
		last := "just now"
		if st.LastSuccessAt != nil {
			last = ago(now, *st.LastSuccessAt)
		}
		fmt.Fprintf(&b, "Connection: Connected, last data sent %s\n", last)
	case state.Starting:
		b.WriteString("Connection: starting, the first data point is on its way\n")
	case state.Retrying:
		fmt.Fprintf(&b, "Connection: NOT connected. %s\n", st.LastError)
		if st.NextRetryAt != nil {
			fmt.Fprintf(&b, "            Trying again in %s; data is kept for up to 15 minutes.\n", until(now, *st.NextRetryAt))
		}
		b.WriteString("Fix:        run  sudo yuktiops-agent doctor\n")
	case state.Disconnected:
		fmt.Fprintf(&b, "Connection: DISCONNECTED. %s\n", st.LastError)
		b.WriteString("Fix:        register this server again: sudo yuktiops-agent register --key=<your API key>\n")
	case state.Stopped:
		b.WriteString("Connection: the agent was stopped.\n")
	}
	if st.Buffered > 0 {
		fmt.Fprintf(&b, "Waiting:    %d data points not sent yet\n", st.Buffered)
	}
	if st.ClockOffsetSeconds != 0 {
		fmt.Fprintf(&b, "Warning:    this server's clock is about %d seconds off. Fix: sudo timedatectl set-ntp true\n", abs(int(st.ClockOffsetSeconds)))
	}
	return b.String(), healthy
}

func until(now, t time.Time) string {
	d := t.Sub(now)
	if d < time.Second {
		return "a moment"
	}
	if d < 90*time.Second {
		return fmt.Sprintf("%d seconds", int(d.Seconds()))
	}
	return fmt.Sprintf("%d minutes", int(d.Minutes()))
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func cmdStatus(args []string, stdout, stderr io.Writer, build Build) int {
	fs, common := newFlagSet("status", stderr)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	paths := common.paths()
	text, healthy := statusReport(paths, systemdState(config.ServiceName), time.Now(), build.Version)
	fmt.Fprint(stdout, text)
	if healthy {
		return 0
	}
	return 1
}
