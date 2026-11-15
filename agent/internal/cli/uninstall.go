package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/state"
)

// Where the installer and the packages put things. Uninstall removes exactly these.
var (
	binaryPaths = []string{"/usr/local/bin/yuktiops-agent", "/usr/bin/yuktiops-agent"}
	unitPaths   = []string{
		"/etc/systemd/system/yuktiops-agent.service",
		"/lib/systemd/system/yuktiops-agent.service",
		"/usr/lib/systemd/system/yuktiops-agent.service",
	}
)

// Uninstaller removes the agent from this machine. Its outside dependencies are fields so the
// logic can be tested without root.
type Uninstaller struct {
	Paths      config.Paths
	KeepConfig bool
	Out        io.Writer

	Geteuid     func() int
	Executable  func() (string, error)
	Run         func(name string, args ...string) error // runs a command, nil error when it exits 0
	Systemd     func() bool
	BinaryPaths []string
	UnitPaths   []string
}

// NewUninstaller returns an Uninstaller wired to the real system.
func NewUninstaller(paths config.Paths, keepConfig bool, out io.Writer) *Uninstaller {
	return &Uninstaller{
		Paths:      paths,
		KeepConfig: keepConfig,
		Out:        out,
		Geteuid:    os.Geteuid,
		Executable: os.Executable,
		Run: func(name string, args ...string) error {
			return exec.Command(name, args...).Run()
		},
		Systemd:     func() bool { return systemdState(config.ServiceName).Systemd },
		BinaryPaths: binaryPaths,
		UnitPaths:   unitPaths,
	}
}

func (u *Uninstaller) say(format string, args ...any) { fmt.Fprintf(u.Out, format+"\n", args...) }

// Execute removes the service, the data, the user and the binary. It returns false when something
// could not be removed (everything else is still attempted).
func (u *Uninstaller) Execute() bool {
	system := u.Paths.IsDefault() // a custom --config-dir means a development setup: files only
	if system && u.Geteuid() != 0 {
		u.say("Removing the agent needs administrator rights. Run: sudo yuktiops-agent uninstall")
		return false
	}
	clean := true
	fail := func(what string, err error) {
		clean = false
		u.say("  could not remove %s: %v", what, err)
	}

	if system {
		u.say("Stopping the service...")
		if u.Systemd() {
			_ = u.Run("systemctl", "disable", "--now", config.ServiceName)
		}
		if st, err := state.Load(u.Paths.StateFile()); err == nil && st.PID > 0 && st.Connection != state.Stopped {
			stopProcess(st.PID) // an agent started by hand or inside a container
		}
		for _, p := range u.UnitPaths {
			if err := removeFile(p); err != nil {
				fail(p, err)
			}
		}
		if u.Systemd() {
			_ = u.Run("systemctl", "daemon-reload")
			_ = u.Run("systemctl", "reset-failed", config.ServiceName)
		}
	}

	// Remove a package-manager installation through the package manager, so its records stay right.
	if system {
		exe, _ := u.Executable()
		for _, p := range append([]string{exe}, u.BinaryPaths...) {
			if p == "" {
				continue
			}
			if u.Run("dpkg", "-S", p) == nil {
				u.say("Removing the .deb package...")
				_ = u.Run("dpkg", "--purge", "yuktiops-agent")
				break
			}
			if u.Run("rpm", "-qf", p) == nil {
				u.say("Removing the .rpm package...")
				_ = u.Run("rpm", "-e", "yuktiops-agent")
				break
			}
		}
	}

	u.say("Removing the agent's data (offline buffer and status)...")
	if system {
		if err := os.RemoveAll(u.Paths.StateDir); err != nil {
			fail(u.Paths.StateDir, err)
		}
	} else {
		for _, p := range u.Paths.StateFiles() {
			if err := removeFile(p); err != nil {
				fail(p, err)
			}
		}
		removeTemps(u.Paths.StateDir)
		_ = os.Remove(u.Paths.StateDir)
	}

	if u.KeepConfig {
		u.say("Keeping the settings in %s (--keep-config).", u.Paths.ConfigDir)
	} else {
		u.say("Removing the settings and credential in %s...", u.Paths.ConfigDir)
		for _, p := range u.Paths.ConfigFiles() {
			if err := removeFile(p); err != nil {
				fail(p, err)
			}
		}
		removeTemps(u.Paths.ConfigDir)
		if err := os.Remove(u.Paths.ConfigDir); err != nil && !errors.Is(err, os.ErrNotExist) {
			u.say("  %s was left in place because it contains other files.", u.Paths.ConfigDir)
		}
	}

	if system {
		if _, err := user.Lookup(config.ServiceUser); err == nil {
			u.say("Removing the %q user...", config.ServiceUser)
			if err := u.Run("userdel", config.ServiceUser); err != nil {
				fail("user "+config.ServiceUser, err)
			}
		}
		if _, err := user.LookupGroup(config.ServiceUser); err == nil {
			_ = u.Run("groupdel", config.ServiceUser)
		}
		u.say("Removing the program...")
		if exe, err := u.Executable(); err == nil {
			// Removing the running program is fine on Linux: it keeps running until it exits.
			if err := removeFile(exe); err != nil {
				fail(exe, err)
			}
		}
		for _, p := range u.BinaryPaths {
			if err := removeFile(p); err != nil {
				fail(p, err)
			}
		}
	}

	if clean {
		u.say("")
		u.say("The YuktiOps agent was removed from this server.")
		u.say("It is still listed in your dashboard: open Servers, choose this server and remove it there.")
	} else {
		u.say("")
		u.say("Some files could not be removed (see above). Remove them by hand, then check with: ls /etc/yuktiops /var/lib/yuktiops")
	}
	return clean
}

func removeFile(path string) error {
	err := os.Remove(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// removeTemps deletes the half-written files that atomic writes can leave behind.
func removeTemps(dir string) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, ".") && (strings.Contains(n, ".yaml.") || strings.Contains(n, "credential.") || strings.Contains(n, "machine-id.")) ||
			strings.HasSuffix(n, ".tmp") {
			_ = os.Remove(filepath.Join(dir, n))
		}
	}
}

func cmdUninstall(args []string, stdout, stderr io.Writer) int {
	fs, common := newFlagSet("uninstall", stderr)
	keep := fs.Bool("keep-config", false, "")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if NewUninstaller(common.paths(), *keep, stdout).Execute() {
		return 0
	}
	return 1
}
