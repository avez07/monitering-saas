package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/yuktiops/agent/internal/client"
	"github.com/yuktiops/agent/internal/collect"
	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/remote"
)

func isNotRegistered(err error) bool { return errors.Is(err, config.ErrNotRegistered) }

func cmdRegister(args []string, stdout, stderr io.Writer, build Build) int {
	fs, common := newFlagSet("register", stderr)
	key := fs.String("key", "", "")
	setup := fs.String("setup", "", "")
	api := fs.String("api", "", "")
	name := fs.String("name", os.Getenv(config.EnvName), "")
	proxy := fs.String("proxy", "", "")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	paths := common.paths()
	config.LoadEnvironmentFile(paths.EnvironmentFile())

	apiKey := strings.TrimSpace(*key)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv(config.EnvAPIKey))
	}
	if !strings.HasPrefix(apiKey, "yk_live_") {
		fmt.Fprintln(stderr, "Provide your account API key with --key=yk_live_... (create it in the YuktiOps dashboard under Settings, API key).")
		return 2
	}
	if *setup != "" && !remote.ValidID(*setup) {
		fmt.Fprintf(stderr, "The setup id %q is not valid. It looks like st_ followed by 24 letters and digits; copy the command from the dashboard again.\n", *setup)
		return 2
	}

	// Which API: flag, environment, an earlier registration, then the default.
	prev, _ := config.LoadFile(paths.ConfigFile())
	file := config.File{
		APIURL:  firstNonEmpty(*api, os.Getenv(config.EnvAPIURL), prev.APIURL, config.DefaultAPIURL),
		Proxy:   firstNonEmpty(*proxy, prev.Proxy),
		SetupID: firstNonEmpty(*setup, prev.SetupID),
	}
	checked, err := config.ParseFile(file.Render())
	if err != nil {
		fmt.Fprintf(stderr, "%v\n", err)
		return 2
	}
	file = checked

	cl, err := client.New(file.APIURL, file.Proxy, build.Version)
	if err != nil {
		fmt.Fprintf(stderr, "%v\n", err)
		return 2
	}
	if err := config.EnsureConfigDir(paths.ConfigDir); err != nil {
		return permissionFailure(stderr, paths.ConfigDir, err)
	}
	fingerprint, err := config.Fingerprint(paths.MachineIDFile())
	if err != nil {
		fmt.Fprintf(stderr, "%v\n", err)
		return permissionFailure(stderr, paths.MachineIDFile(), err)
	}
	host, _ := os.Hostname()
	file.Name = firstNonEmpty(*name, prev.Name, host, "server")
	info := collect.New().Host()

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	res, err := cl.Register(ctx, apiKey, client.RegisterRequest{
		Name:        file.Name,
		Fingerprint: fingerprint,
		Platform:    "linux",
		OS:          info.OS,
		Arch:        runtime.GOARCH,
		Version:     build.Version,
		SetupID:     file.SetupID,
	})
	if err != nil {
		fmt.Fprintln(stderr, registerFailure(cl, err))
		return 1
	}
	file.AgentID = res.AgentID
	// The account API key is deliberately not written anywhere. Only this server's own
	// credential is stored, and only the service group can read it.
	if err := config.WriteSecure(paths.CredentialFile(), []byte(res.Credential+"\n"), 0o640); err != nil {
		return permissionFailure(stderr, paths.CredentialFile(), err)
	}
	if err := config.WriteSecure(paths.ConfigFile(), file.Render(), 0o640); err != nil {
		return permissionFailure(stderr, paths.ConfigFile(), err)
	}
	if res.Reconnected {
		fmt.Fprintf(stdout, "This server was already registered. It was reconnected as %q (no duplicate was created).\n", file.Name)
	} else {
		fmt.Fprintf(stdout, "Registered this server as %q.\n", file.Name)
	}
	fmt.Fprintf(stdout, "Saved its own credential to %s and settings to %s. The account API key was not saved.\n",
		paths.CredentialFile(), paths.ConfigFile())
	return 0
}

func registerFailure(cl *client.Client, err error) string {
	var api *client.APIError
	if errors.As(err, &api) {
		switch api.Status {
		case 401, 403:
			return "YuktiOps did not accept this API key (" + api.Message + ").\n" +
				"Check that you copied the whole key, or create a new one in the dashboard under Settings, API key.\n" +
				"Error code: credential_revoked"
		case 402, 409:
			return "YuktiOps refused the registration: " + api.Message + "\nError code: plan_limit"
		case 429:
			return "Too many registrations in a short time (" + api.Message + "). Wait a few minutes and try again.\nError code: rate_limited"
		}
	}
	kind := client.Classify(err)
	return cl.Explain(err) + "\nError code: " + kind.Code() + "\nRun \"yuktiops-agent doctor\" for help."
}

func permissionFailure(w io.Writer, path string, err error) int {
	if os.IsPermission(err) {
		fmt.Fprintf(w, "Cannot write %s: permission denied. Run the command with sudo.\nError code: disk_permission\n", path)
	} else {
		fmt.Fprintf(w, "Cannot write %s: %v\nError code: disk_permission\n", path, err)
	}
	return 1
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
