//go:build !linux

package collect

import "errors"

// The agent ships for Linux only. This stub keeps the module compiling on a developer's Windows
// or macOS machine (editor tooling, go vet); the disk collector simply reports that it cannot run.
func statfs(path string) (fsUsage, error) {
	return fsUsage{}, errors.New("disk usage is only available on Linux")
}
