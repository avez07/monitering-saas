package config

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

// machineIDSources are tried in order; the first non-empty one identifies the machine.
var machineIDSources = []string{"/etc/machine-id", "/var/lib/dbus/machine-id"}

// Fingerprint returns the SHA-256 (hex) of this machine's id, so registering the same machine
// again reconnects the same server instead of creating a second one.
//
// Machines without /etc/machine-id (some containers and minimal images) get a random id that is
// generated once and kept in fallbackFile, next to the credential.
//
// With HOST_ROOT set (a container that mounts the host's / there) the host's machine-id is used,
// so the container is the same server as the host.
func Fingerprint(fallbackFile string) (string, error) {
	return fingerprintFrom(machineIDSourcesUnder(HostRoot()), fallbackFile)
}

func machineIDSourcesUnder(root string) []string {
	out := make([]string, len(machineIDSources))
	for i, s := range machineIDSources {
		out[i] = HostPath(root, s)
	}
	return out
}

func fingerprintFrom(sources []string, fallbackFile string) (string, error) {
	for _, path := range append(append([]string{}, sources...), fallbackFile) {
		if id := readID(path); id != "" {
			return hashID(id), nil
		}
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("could not generate a machine id: %v", err)
	}
	id := hex.EncodeToString(raw)
	if err := WriteSecure(fallbackFile, []byte(id+"\n"), 0o640); err != nil {
		return "", fmt.Errorf("could not save a machine id to %s: %v", fallbackFile, err)
	}
	return hashID(id), nil
}

func readID(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func hashID(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}
