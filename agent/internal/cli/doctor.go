package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/yuktiops/agent/internal/client"
	"github.com/yuktiops/agent/internal/config"
	"github.com/yuktiops/agent/internal/remote"
	"github.com/yuktiops/agent/internal/state"
)

// Status of one doctor check.
type Status string

const (
	StatusOK   Status = "ok"
	StatusWarn Status = "warn"
	StatusFail Status = "fail"
	StatusSkip Status = "skip"
)

// The codes are the ones in the backend's error catalog (backend/src/services/agent-errors.js),
// so the dashboard and `doctor` show the same explanation for the same problem.
const (
	CodeHTTPSUnreachable  = "https_unreachable"
	CodeDNSFailed         = "dns_failed"
	CodeClockSkew         = "clock_skew"
	CodeCredentialRevoked = "credential_revoked"
	CodePlanLimit         = "plan_limit"
	CodePayloadTooLarge   = "payload_too_large"
	CodeDockerSocket      = "docker_socket_denied"
	CodeDiskPermission    = "disk_permission"
	CodeProxyError        = "proxy_error"
	CodeConfigInvalid     = "config_invalid"
	CodeTLSFailed         = "tls_failed"
)

// clockWarnAfter is when doctor starts to complain about the clock. The backend only corrects
// timestamps beyond two minutes, but a clock that is off by a minute is already worth fixing.
const (
	clockWarnAfter = 30 * time.Second
	clockFailAfter = 120 * time.Second
)

// Result is the outcome of one check.
type Result struct {
	Name   string
	Status Status
	Code   string
	Detail string
	Fix    string
}

// Doctor runs the diagnostic checks. Every outside dependency is a field so tests can replace it.
type Doctor struct {
	Paths   config.Paths
	Version string
	// APIOverride is the --api flag, used when no agent.yaml exists yet.
	APIOverride string

	Now        func() time.Time
	Service    func() ServiceState
	LookupHost func(ctx context.Context, host string) ([]string, error)
	DialTCP    func(ctx context.Context, address string) error
}

// NewDoctor returns a Doctor wired to the real system.
func NewDoctor(paths config.Paths, version string) *Doctor {
	return &Doctor{
		Paths:   paths,
		Version: version,
		Now:     time.Now,
		Service: func() ServiceState { return systemdState(config.ServiceName) },
		LookupHost: func(ctx context.Context, host string) ([]string, error) {
			return net.DefaultResolver.LookupHost(ctx, host)
		},
		DialTCP: func(ctx context.Context, address string) error {
			var d net.Dialer
			c, err := d.DialContext(ctx, "tcp", address)
			if err != nil {
				return err
			}
			return c.Close()
		},
	}
}

func ok(name, detail string) Result   { return Result{Name: name, Status: StatusOK, Detail: detail} }
func skip(name, detail string) Result { return Result{Name: name, Status: StatusSkip, Detail: detail} }

// Run executes every check and returns the results in display order.
func (d *Doctor) Run(ctx context.Context) []Result {
	var out []Result
	add := func(r ...Result) { out = append(out, r...) }

	cfg, settings := d.checkSettings()
	add(settings)
	add(d.checkFiles()...)

	cl, err := client.New(cfg.APIURL, cfg.Proxy, d.Version)
	if err != nil {
		add(Result{Name: "Connection settings", Status: StatusFail, Code: CodeConfigInvalid, Detail: err.Error(),
			Fix: "Correct api_url / proxy in " + d.Paths.ConfigFile() + ", or register again."})
		add(d.checkService()...)
		return out
	}

	proxy, _ := cl.ProxyFor()
	add(d.checkDNS(ctx, cl, proxy))
	add(d.checkProxy(ctx, proxy))
	https, clock := d.checkHTTPS(ctx, cl)
	add(https, clock)
	add(d.checkCredential(ctx, cl, https.Status == StatusFail))
	add(d.checkService()...)
	return out
}

// checkSettings loads agent.yaml. When there is none (not registered yet) the default API is
// still tested, so doctor is useful before registering.
func (d *Doctor) checkSettings() (config.File, Result) {
	const name = "Settings"
	cfg, loadErr := config.LoadFile(d.Paths.ConfigFile())
	fallback := config.File{APIURL: config.DefaultAPIURL}
	if api, err := config.NormalizeAPIURL(firstNonEmpty(d.APIOverride, os.Getenv(config.EnvAPIURL), config.DefaultAPIURL)); err == nil {
		fallback.APIURL = api
	}
	switch {
	case loadErr == nil:
		who := cfg.Name
		if who == "" {
			who = "this server"
		}
		return cfg, ok(name, fmt.Sprintf("registered as %q, sending to %s", who, cfg.APIURL))
	case errors.Is(loadErr, config.ErrNotRegistered):
		return fallback, Result{Name: name, Status: StatusWarn, Detail: "this server is not registered yet (testing the connection anyway)",
			Fix: "Register it with: sudo yuktiops-agent register --key=<your API key>"}
	case os.IsPermission(loadErr):
		return fallback, Result{Name: name, Status: StatusWarn, Code: CodeDiskPermission,
			Detail: "the settings file cannot be read by this user",
			Fix:    "Run doctor with sudo so it can check everything: sudo yuktiops-agent doctor"}
	}
	return fallback, Result{Name: name, Status: StatusFail, Code: CodeConfigInvalid, Detail: loadErr.Error(),
		Fix: "Correct " + d.Paths.ConfigFile() + " (or delete it) and register again: sudo yuktiops-agent register --key=<your API key>"}
}

func (d *Doctor) checkDNS(ctx context.Context, cl *client.Client, proxy *url.URL) Result {
	const name = "DNS lookup"
	host := cl.Host()
	if proxy != nil {
		return skip(name, "not needed, connections go through the proxy "+proxy.Host)
	}
	if net.ParseIP(host) != nil || strings.EqualFold(host, "localhost") {
		return skip(name, host+" is an address, no lookup needed")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	addrs, err := d.LookupHost(ctx, host)
	if err != nil || len(addrs) == 0 {
		return Result{Name: name, Status: StatusFail, Code: CodeDNSFailed,
			Detail: fmt.Sprintf("this server cannot find %s", host),
			Fix: "Check the DNS servers in /etc/resolv.conf (try 1.1.1.1 or 8.8.8.8) and that this server has internet access. " +
				"Test with: getent hosts " + host}
	}
	return ok(name, fmt.Sprintf("%s resolves to %s", host, addrs[0]))
}

func (d *Doctor) checkProxy(ctx context.Context, proxy *url.URL) Result {
	const name = "Proxy"
	if proxy == nil {
		return ok(name, "none, connecting directly")
	}
	address := proxy.Host
	if proxy.Port() == "" {
		port := "80"
		if proxy.Scheme == "https" {
			port = "443"
		} else if strings.HasPrefix(proxy.Scheme, "socks5") {
			port = "1080"
		}
		address = net.JoinHostPort(proxy.Hostname(), port)
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := d.DialTCP(ctx, address); err != nil {
		return Result{Name: name, Status: StatusFail, Code: CodeProxyError,
			Detail: fmt.Sprintf("the proxy %s cannot be reached", address),
			Fix: "Check the proxy address in HTTPS_PROXY (or proxy: in " + d.Paths.ConfigFile() + "), and that this server may connect to it. " +
				"Proxy settings for the service go in " + d.Paths.EnvironmentFile() + "."}
	}
	return ok(name, "using "+address+" (reachable)")
}

// checkHTTPS tests that the API answers, and reads the server's clock from the Date header.
func (d *Doctor) checkHTTPS(ctx context.Context, cl *client.Client) (Result, Result) {
	const name, clockName = "HTTPS connection", "Clock"
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	before := d.Now()
	res, err := cl.Health(ctx)
	after := d.Now()
	if err != nil {
		var api *client.APIError
		if errors.As(err, &api) && res != nil && api.Status >= 500 {
			// The server answered, so the network is fine; the problem is on our side.
			return Result{Name: name, Status: StatusWarn, Detail: fmt.Sprintf("%s answered but reported a problem (HTTP %d)", cl.Host(), api.Status),
					Fix: "This is a problem on the YuktiOps side. The agent keeps your data and retries. Check the status page, or try again in a few minutes."},
				d.clock(res, before, after, clockName)
		}
		kind := client.Classify(err)
		r := Result{Name: name, Status: StatusFail, Code: kind.Code(), Detail: cl.Explain(err)}
		switch kind {
		case client.KindDNS:
			r.Code = CodeDNSFailed
			r.Fix = "Fix DNS first (see above), then run doctor again."
		case client.KindBlocked:
			r.Code = CodeHTTPSUnreachable
			r.Fix = fmt.Sprintf("Allow outbound HTTPS (port 443) to %s in your firewall or security group. Test it with: curl -I %s/api/health", cl.Host(), cl.BaseURL())
		case client.KindProxy:
			r.Code = CodeProxyError
			r.Fix = "Check the proxy address and its login in HTTPS_PROXY. Test with: curl -I -x $HTTPS_PROXY " + cl.BaseURL() + "/api/health"
		case client.KindTLS:
			r.Code = CodeTLSFailed
			r.Fix = "A firewall or proxy may be inspecting HTTPS. Allow connections to " + cl.Host() + " without inspection, or install your company's CA certificate on this server."
		case client.KindClock:
			r.Code = CodeClockSkew
			r.Fix = "Fix this server's clock: sudo timedatectl set-ntp true"
		default:
			r.Fix = "Run: curl -I " + cl.BaseURL() + "/api/health   and send us the output if it keeps failing."
		}
		clock := skip(clockName, "could not be checked because the server could not be reached")
		if kind == client.KindClock {
			clock = Result{Name: clockName, Status: StatusFail, Code: CodeClockSkew,
				Detail: "this server's clock is wrong (the secure connection was refused because of it)",
				Fix:    "Fix it with: sudo timedatectl set-ntp true   (and check with: timedatectl)"}
		}
		return r, clock
	}
	return ok(name, fmt.Sprintf("%s is reachable", cl.Host())), d.clock(res, before, after, clockName)
}

func (d *Doctor) clock(res *client.Response, before, after time.Time, name string) Result {
	if res == nil || res.Date.IsZero() {
		return skip(name, "the server did not tell its time")
	}
	// The Date header has whole-second resolution; compare it with the middle of the request.
	local := before.Add(after.Sub(before) / 2)
	offset := res.Date.Add(500 * time.Millisecond).Sub(local)
	abs := offset
	if abs < 0 {
		abs = -abs
	}
	amount := abs.Round(time.Second)
	dir := "behind"
	if offset < 0 {
		dir = "ahead"
	}
	switch {
	case abs > clockFailAfter:
		return Result{Name: name, Status: StatusFail, Code: CodeClockSkew,
			Detail: fmt.Sprintf("this server's clock is about %s %s real time", amount, dir),
			Fix:    "Run: sudo timedatectl set-ntp true   (then check with: timedatectl). Until then your charts may show shifted times."}
	case abs > clockWarnAfter:
		return Result{Name: name, Status: StatusWarn, Code: CodeClockSkew,
			Detail: fmt.Sprintf("this server's clock is about %s %s real time", amount, dir),
			Fix:    "Run: sudo timedatectl set-ntp true"}
	}
	return ok(name, "in sync with YuktiOps")
}

func (d *Doctor) checkCredential(ctx context.Context, cl *client.Client, networkDown bool) Result {
	const name = "Credential"
	cred, err := config.LoadCredential(d.Paths.CredentialFile())
	switch {
	case errors.Is(err, config.ErrNotRegistered):
		return skip(name, "none yet, this server is not registered")
	case err != nil && os.IsPermission(err), err != nil && errors.Is(err, os.ErrPermission):
		return Result{Name: name, Status: StatusWarn, Code: CodeDiskPermission, Detail: "this user cannot read the credential file",
			Fix: "Run doctor with sudo: sudo yuktiops-agent doctor"}
	case err != nil:
		return Result{Name: name, Status: StatusFail, Code: CodeConfigInvalid, Detail: err.Error(),
			Fix: "Register this server again: sudo yuktiops-agent register --key=<your API key>"}
	}
	if networkDown {
		return skip(name, "could not be checked because the server could not be reached")
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	res, err := cl.Config(ctx, cred)
	if err != nil {
		switch client.Classify(err) {
		case client.KindUnauthorized:
			return Result{Name: name, Status: StatusFail, Code: CodeCredentialRevoked,
				Detail: "YuktiOps no longer accepts this server's credential (the server was removed or disconnected)",
				Fix:    "Register it again with your account API key: sudo yuktiops-agent register --key=<your API key>   (the agent reconnects by itself, no restart needed)"}
		case client.KindThrottled:
			return Result{Name: name, Status: StatusWarn, Code: "rate_limited", Detail: "YuktiOps is asking this server to slow down (too many requests)",
				Fix: "Wait a minute and run doctor again. If it persists, check that only one agent runs on this machine."}
		}
		return Result{Name: name, Status: StatusWarn, Detail: cl.Explain(err), Fix: "Try again in a few minutes."}
	}
	if _, _, err := remote.Parse(res.Body); err != nil {
		return Result{Name: name, Status: StatusWarn, Code: CodeConfigInvalid,
			Detail: "the credential works, but the settings YuktiOps sent are not valid: " + err.Error(),
			Fix:    "The agent ignores invalid settings and keeps the last good ones. Check the setup profile in the dashboard."}
	}
	return ok(name, "accepted by YuktiOps")
}

func (d *Doctor) checkService() []Result {
	var out []Result
	svc := d.Service()
	const name = "Service"
	switch {
	case !svc.Systemd:
		out = append(out, skip(name, "systemd is not running here (in a container, make sure the agent container is running: docker ps)"))
	case svc.Active == "active":
		r := ok(name, "yuktiops-agent is running")
		if svc.Enabled != "enabled" {
			r = Result{Name: name, Status: StatusWarn, Detail: "running, but it will not start after a reboot (" + orUnknown(svc.Enabled) + ")",
				Fix: "Run: sudo systemctl enable yuktiops-agent"}
		}
		out = append(out, r)
	default:
		out = append(out, Result{Name: name, Status: StatusFail, Detail: "yuktiops-agent is not running (" + orUnknown(svc.Active) + ")",
			Fix: "Start it with: sudo systemctl enable --now yuktiops-agent   then read the log: sudo journalctl -u yuktiops-agent -n 50"})
	}

	const sname = "Sending data"
	st, err := state.Load(d.Paths.StateFile())
	if err != nil {
		out = append(out, skip(sname, "the agent has not written a status file yet"))
		return out
	}
	now := d.Now()
	switch st.Connection {
	case state.Connected:
		last := "just now"
		if st.LastSuccessAt != nil {
			last = ago(now, *st.LastSuccessAt)
		}
		out = append(out, ok(sname, "connected, last data sent "+last))
	case state.Starting:
		out = append(out, skip(sname, "the agent just started"))
	case state.Stopped:
		out = append(out, Result{Name: sname, Status: StatusWarn, Detail: "the agent was stopped", Fix: "Start it: sudo systemctl start yuktiops-agent"})
	default:
		code := st.LastErrorCode
		status := StatusWarn
		if st.Connection == state.Disconnected {
			status = StatusFail
		}
		out = append(out, Result{Name: sname, Status: status, Code: code, Detail: st.LastError,
			Fix: "Fix the problems listed above; the agent retries by itself and sends the buffered data."})
	}
	return out
}

// Print writes the results as plain text.
func Print(w io.Writer, version string, results []Result) (problems int) {
	fmt.Fprintf(w, "YuktiOps doctor (agent %s)\n\n", version)
	for _, r := range results {
		label := map[Status]string{StatusOK: "  OK  ", StatusWarn: " WARN ", StatusFail: " FAIL ", StatusSkip: " skip "}[r.Status]
		line := fmt.Sprintf("[%s] %-18s %s", label, r.Name, r.Detail)
		if r.Code != "" && r.Status != StatusOK {
			line += " (" + r.Code + ")"
		}
		fmt.Fprintln(w, line)
		if r.Fix != "" && r.Status != StatusOK && r.Status != StatusSkip {
			fmt.Fprintf(w, "         How to fix: %s\n", r.Fix)
		}
		if r.Status == StatusFail {
			problems++
		}
	}
	fmt.Fprintln(w)
	switch {
	case problems == 0:
		fmt.Fprintln(w, "No problems found.")
	case problems == 1:
		fmt.Fprintln(w, "1 problem found. Fix it, then run: sudo yuktiops-agent doctor")
	default:
		fmt.Fprintf(w, "%d problems found. Start with the first one, then run: sudo yuktiops-agent doctor\n", problems)
	}
	return problems
}

func cmdDoctor(args []string, stdout, stderr io.Writer, build Build) int {
	fs, common := newFlagSet("doctor", stderr)
	api := fs.String("api", "", "")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	paths := common.paths()
	config.LoadEnvironmentFile(paths.EnvironmentFile())
	d := NewDoctor(paths, build.Version)
	d.APIOverride = *api
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if Print(stdout, build.Version, d.Run(ctx)) > 0 {
		return 1
	}
	return 0
}
