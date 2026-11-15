package client

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
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

// Explain turns a failure into one plain-language sentence for `status` and the logs.
func (c *Client) Explain(err error) string {
	host := c.host
	var api *APIError
	errors.As(err, &api)
	switch Classify(err) {
	case KindDNS:
		return fmt.Sprintf("This server cannot find %s (DNS lookup failed).", host)
	case KindBlocked:
		return fmt.Sprintf("This server cannot reach %s over HTTPS (the connection was blocked, refused or timed out).", host)
	case KindProxy:
		return "The configured proxy could not be reached or refused the connection."
	case KindTLS:
		return fmt.Sprintf("The secure connection to %s could not be verified (a firewall or proxy may be intercepting HTTPS).", host)
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
