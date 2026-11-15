package config

import (
	"fmt"
	"net/url"
	"strings"
)

// NormalizeAPIURL validates the API base URL and returns it without a trailing slash.
//
// Credentials must never travel over plain HTTP. The only exception is a server on this very
// machine (localhost, 127.0.0.1, [::1]), which is what local development uses.
func NormalizeAPIURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("the API URL is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("the API URL %q is not a valid URL", raw)
	}
	host := u.Hostname()
	if host == "" || u.Opaque != "" {
		return "", fmt.Errorf("the API URL %q is not a valid URL (expected something like https://api.yuktiops.com)", raw)
	}
	if u.User != nil {
		return "", fmt.Errorf("the API URL must not contain a user name or password")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("the API URL must not contain a query string or fragment")
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
	case "http":
		if !isLoopbackName(host) {
			return "", fmt.Errorf("refusing to send credentials over http:// to %s. Use an https:// API URL", host)
		}
	default:
		return "", fmt.Errorf("the API URL must start with https:// (got %q)", raw)
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return u.String(), nil
}

// isLoopbackName mirrors the development agent: only these exact names count as "this machine".
// A hostname that merely resolves to a loopback address does not.
func isLoopbackName(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// NormalizeProxyURL validates an optional proxy setting. An empty value means "no explicit proxy".
func NormalizeProxyURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("the proxy setting %q is not a valid URL (expected something like http://proxy.example.com:3128)", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "socks5", "socks5h":
	default:
		return "", fmt.Errorf("the proxy URL must start with http://, https:// or socks5:// (got %q)", raw)
	}
	return u.String(), nil
}
