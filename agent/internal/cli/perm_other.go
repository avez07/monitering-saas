//go:build !linux

package cli

// checkFiles has nothing to verify off Linux (the agent only runs as a Linux service).
func (d *Doctor) checkFiles() []Result {
	return []Result{skip("File permissions", "only checked on Linux")}
}
