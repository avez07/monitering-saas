// Package cli implements the yuktiops-agent commands: run, register, status, doctor, uninstall
// and version.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"syscall"

	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/runner"
)

// Build identifies this binary.
type Build struct {
	Version string
	Commit  string
	Date    string
}

// Main runs the command named in args and returns the process exit code.
func Main(args []string, stdout, stderr io.Writer, build Build) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "run":
		return cmdRun(rest, stderr, build)
	case "register":
		return cmdRegister(rest, stdout, stderr, build)
	case "status":
		return cmdStatus(rest, stdout, stderr, build)
	case "doctor":
		return cmdDoctor(rest, stdout, stderr, build)
	case "uninstall":
		return cmdUninstall(rest, stdout, stderr)
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "yuktiops-agent %s (commit %s, built %s, %s, %s/%s)\n",
			build.Version, build.Commit, build.Date, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return 0
	case "help", "--help", "-h":
		usage(stdout)
		return 0
	}
	fmt.Fprintf(stderr, "Unknown command %q.\n\n", cmd)
	usage(stderr)
	return 2
}

func usage(w io.Writer) {
	fmt.Fprint(w, `YuktiOps agent: monitors this server and sends the statistics to YuktiOps.

Usage: yuktiops-agent <command> [options]

Commands:
  register --key=yk_live_...   Register this server (uses your account API key once)
  status                       Show whether the agent is running and sending data
  doctor                       Test the connection and print fixes in plain English
  uninstall                    Remove the agent from this server (--keep-config keeps agent.yaml)
  version                      Show the version
  run                          The background process (started by systemd; you never type this)

Register options:
  --key=KEY      Your account API key (or set YUKTIOPS_API_KEY)
  --setup=st_..  A setup profile created in the dashboard
  --api=URL      API address (default https://api.yuktiops.com)
  --name=NAME    Name shown in the dashboard (default: this server's host name)

Run "sudo yuktiops-agent doctor" if data does not arrive.
`)
}

// commonFlags are accepted by every command. They exist for development and tests; a normal
// install always uses the default locations.
type commonFlags struct {
	configDir string
	stateDir  string
}

func newFlagSet(name string, stderr io.Writer) (*flag.FlagSet, *commonFlags) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	c := &commonFlags{}
	fs.StringVar(&c.configDir, "config-dir", "", "")
	fs.StringVar(&c.stateDir, "state-dir", "", "")
	return fs, c
}

func (c *commonFlags) paths() config.Paths { return config.ResolvePaths(c.configDir, c.stateDir) }

func cmdRun(args []string, stderr io.Writer, build Build) int {
	fs, common := newFlagSet("run", stderr)
	verbose := fs.Bool("verbose", false, "log every send")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	paths := common.paths()
	config.LoadEnvironmentFile(paths.EnvironmentFile())

	// A monitoring agent must be small. A tight soft memory limit and a lower GC target keep the
	// resident size low at the cost of a little extra GC work on a very quiet process.
	debug.SetGCPercent(50)
	debug.SetMemoryLimit(40 << 20)

	// journald adds its own timestamps, so log lines carry none.
	logger := log.New(stderr, "", 0)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// In a container there is no installer: with YUKTIOPS_API_KEY set, an unregistered agent
	// registers itself on first start (the key is used once and never stored).
	if _, err := os.Stat(paths.CredentialFile()); errors.Is(err, os.ErrNotExist) && os.Getenv(config.EnvAPIKey) != "" {
		if code := cmdRegister(nil, stderr, stderr, build); code != 0 {
			return code
		}
	}
	err := runner.Run(ctx, runner.Options{Paths: paths, Version: build.Version, Logger: logger, Verbose: *verbose})
	if err != nil {
		fmt.Fprintf(stderr, "yuktiops-agent cannot start: %v\n", err)
		if isNotRegistered(err) {
			fmt.Fprintln(stderr, "Register this server first: sudo yuktiops-agent register --key=<your API key>")
		}
		return 1
	}
	return 0
}
