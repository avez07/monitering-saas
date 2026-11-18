package client

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
)

// Kind groups failures by what the user has to do about them.
type Kind string

const (
	KindNone         Kind = ""
	KindDNS          Kind = "dns"          // the API host name does not resolve
	KindBlocked      Kind = "blocked"      // connecting to the API (port 443) fails or times out
	KindProxy        Kind = "proxy"        // the configured proxy is unreachable or refuses
	KindTLS          Kind = "tls"          // the connection is intercepted or the certificate is wrong
	KindClock        Kind = "clock"        // certificate "not yet valid / expired": usually a wrong clock
	KindUnauthorized Kind = "unauthorized" // 401/403: credential revoked or server removed
	KindRejected     Kind = "rejected"     // 400/413/422: the backend will never accept this batch
	KindThrottled    Kind = "throttled"    // 429
	KindServer       Kind = "server"       // 5xx or any other unexpected answer
	KindOther        Kind = "other"
)

// Classify works out what kind of failure err is.
func Classify(err error) Kind {
	if err == nil {
		return KindNone
	}
	var api *APIError
	if errors.As(err, &api) {
		switch {
		case api.Status == http.StatusUnauthorized || api.Status == http.StatusForbidden:
			return KindUnauthorized
		case api.Status == http.StatusBadRequest || api.Status == http.StatusRequestEntityTooLarge || api.Status == http.StatusUnprocessableEntity:
			return KindRejected
		case api.Status == http.StatusTooManyRequests:
			return KindThrottled
		case api.Status == http.StatusProxyAuthRequired:
			return KindProxy
		}
		return KindServer
	}
	var certInvalid x509.CertificateInvalidError
	if errors.As(err, &certInvalid) && certInvalid.Reason == x509.Expired {
		return KindClock
	}
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var recordHeader tls.RecordHeaderError
	var certVerify *tls.CertificateVerificationError
	if errors.As(err, &certInvalid) || errors.As(err, &unknownAuthority) || errors.As(err, &hostname) ||
		errors.As(err, &recordHeader) || errors.As(err, &certVerify) {
		return KindTLS
	}
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "proxyconnect" {
		return KindProxy
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return KindDNS
	}
	text := err.Error()
	if strings.Contains(text, "proxyconnect") || strings.Contains(text, "Proxy Authentication Required") {
		return KindProxy
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENETUNREACH) ||
		errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.ETIMEDOUT) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
		return KindBlocked
	}
	if errors.As(err, &op) {
		return KindBlocked
	}
	if strings.Contains(text, "tls:") || strings.Contains(text, "x509:") {
		return KindTLS
	}
	if strings.Contains(text, "EOF") || strings.Contains(text, "connection reset") || strings.Contains(text, "broken pipe") {
		return KindBlocked
	}
	return KindOther
}

// Code returns the short error code for a failure kind (same alphabet as the error catalog).
func (k Kind) Code() string {
	switch k {
	case KindDNS:
		return "dns_failed"
	case KindBlocked:
		return "https_unreachable"
	case KindProxy:
		return "proxy_error"
	case KindTLS:
		return "tls_failed"
	case KindClock:
		return "clock_skew"
	case KindUnauthorized:
		return "credential_revoked"
	case KindRejected:
		return "payload_rejected"
	case KindThrottled:
		return "rate_limited"
	case KindServer:
		return "server_error"
	}
	return "send_failed"
}

// Reason names the underlying cause of a transport failure in a few words (no secrets: it only
// contains addresses and error classes). It returns "" for an HTTP answer from the server.
func Reason(err error) string {
	var api *APIError
	if err == nil || errors.As(err, &api) {
		return ""
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		if dns.IsNotFound {
			return "DNS failure: no such host"
		}
		if dns.IsTimeout {
			return "DNS failure: lookup timed out"
		}
		return "DNS failure: " + dns.Err
	}
	var certInvalid x509.CertificateInvalidError
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	if errors.As(err, &certInvalid) && certInvalid.Reason == x509.Expired {
		return "certificate error: expired or not yet valid"
	}
	if errors.As(err, &unknownAuthority) {
		return "certificate error: signed by an unknown authority"
	}
	if errors.As(err, &hostname) {
		return "certificate error: the certificate is for a different host name"
	}
	if errors.As(err, &certInvalid) {
		return "certificate error: invalid certificate"
	}
	text := err.Error()
	switch {
	case errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(text, "connection refused"):
		return "connection refused (nothing is listening at that address and port)"
	case errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) || errors.Is(err, syscall.ETIMEDOUT) || strings.Contains(text, "i/o timeout"):
		return "timed out"
	case strings.Contains(text, "tls:") || strings.Contains(text, "x509:"):
		return "TLS handshake error: " + trimNoise(text)
	case errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH):
		return "network or host unreachable"
	case errors.Is(err, syscall.ECONNRESET) || strings.Contains(text, "connection reset"):
		return "connection reset by the other side"
	}
	return trimNoise(text)
}

func trimNoise(s string) string {
	if len(s) > 160 {
		s = s[:160]
	}
	return s
}

// dialAddress returns the address that was actually dialed (the resolved IP and port), or "".
func dialAddress(err error) string {
	var op *net.OpError
	if errors.As(err, &op) && op.Addr != nil {
		return op.Addr.String()
	}
	return ""
}

// Target describes where the agent tried to connect: URL, scheme, host, port and resolved address.
func (c *Client) Target(err error) string {
	u, perr := url.Parse(c.base)
	if perr != nil {
		return c.base
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	out := fmt.Sprintf("%s (scheme %s, host %s, port %s", c.base, u.Scheme, u.Hostname(), port)
	if addr := dialAddress(err); addr != "" {
		out += ", resolved " + addr
	}
	return out + ")"
}

// inContainer is a cheap marker check (Docker and Podman create these files).
func inContainer() bool {
	for _, p := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}

// LocalhostHint explains the Docker Desktop trap when the API is "localhost" and we are in a container.
func (c *Client) LocalhostHint() string {
	switch strings.ToLower(c.host) {
	case "localhost", "127.0.0.1", "::1":
		if inContainer() {
			return " Note: inside a container, localhost is the container itself (on Docker Desktop for Windows or Mac, with --network host, " +
				"it is Docker's Linux VM), not your computer. If the API runs on your computer, use " +
				"-e YUKTIOPS_API_URL=http://host.docker.internal:4000 -e YUKTIOPS_ALLOW_INSECURE=true."
		}
	}
	return ""
}

// Explain turns a failure into one plain-language sentence for `status` and the logs.
func (c *Client) Explain(err error) string {
	var api *APIError
	errors.As(err, &api)
	switch Classify(err) {
	case KindDNS:
		return fmt.Sprintf("This server cannot find %s: %s. Tried %s.", c.host, Reason(err), c.Target(err))
	case KindBlocked:
		return fmt.Sprintf("This server cannot reach %s: %s.%s", c.Target(err), Reason(err), c.LocalhostHint())
	case KindProxy:
		return "The configured proxy could not be reached or refused the connection."
	case KindTLS:
		return fmt.Sprintf("The secure connection to %s could not be verified: %s (a firewall or proxy may be intercepting HTTPS).", c.Target(err), Reason(err))
	case KindClock:
		return "The secure connection failed because this server's clock looks wrong."
	case KindUnauthorized:
		if api != nil && api.Message != "" {
			return "YuktiOps refused this server's credential: " + api.Message
		}
		return "YuktiOps refused this server's credential."
	case KindRejected:
		if api != nil && api.Message != "" {
			return "YuktiOps rejected the data: " + api.Message
		}
		return "YuktiOps rejected the data."
	case KindThrottled:
		return "YuktiOps asked the agent to slow down (too many requests)."
	case KindServer:
		if api != nil {
			return fmt.Sprintf("YuktiOps answered with an error (HTTP %d). The problem is on our side; the agent keeps retrying.", api.Status)
		}
	}
	return truncate("Sending failed: "+err.Error(), 300)
}
