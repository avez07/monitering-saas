// yuktiops-agent is the YuktiOps monitoring agent: a single static binary that reads system
// statistics and sends them to YuktiOps over outbound HTTPS. It opens no ports and never runs
// commands received from the network.
package main

import (
	"os"

	"github.com/yuktiops/agent/internal/cli"
)

// Set at build time: -ldflags "-X main.version=0.4.1 -X main.commit=abc123 -X main.date=2026-01-01".
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	os.Exit(cli.Main(os.Args[1:], os.Stdout, os.Stderr, cli.Build{Version: version, Commit: commit, Date: date}))
}
