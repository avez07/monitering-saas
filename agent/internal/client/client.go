// Package client speaks the YuktiOps agent protocol (/v1/register, /v1/ingest, /v1/config).
//
// All traffic is outbound HTTPS. Plain HTTP is only possible to a server on this machine
// (see config.NormalizeAPIURL). Redirects are never followed, so a credential can never be
// sent to a host other than the configured one.
package client

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/yuktiops/agent/internal/config"
)

const (
	requestTimeout  = 20 * time.Second
	maxResponseSize = 256 << 10
)

// Client is safe for one sender at a time (it reuses its compression buffers).
type Client struct {
	base      string
	host      string
	proxy     func(*http.Request) (*url.URL, error)
	http      *http.Client
	userAgent string

	body bytes.Buffer
	gz   *gzip.Writer
}

// New builds a client for the given API URL. proxy is the optional setting from agent.yaml; when
// it is empty the standard HTTPS_PROXY / NO_PROXY environment variables decide.
func New(apiURL, proxy, version string) (*Client, error) {
	base, err := config.NormalizeAPIURL(apiURL)
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(base)
	proxyFunc := http.ProxyFromEnvironment
	if proxy != "" {
		normalized, err := config.NormalizeProxyURL(proxy)
		if err != nil {
			return nil, err
		}
		pu, _ := url.Parse(normalized)
		proxyFunc = http.ProxyURL(pu)
	}
	transport := &http.Transport{
		Proxy: proxyFunc,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		// One connection is kept open between sends so each send does not pay for a new TLS
		// handshake. HTTP/2 is switched off: one small request every 30 seconds gains nothing
		// from it and its buffers would cost memory.
		MaxIdleConns:        1,
		MaxIdleConnsPerHost: 1,
		MaxConnsPerHost:     2,
		IdleConnTimeout:     90 * time.Second,
		TLSNextProto:        map[string]func(string, *tls.Conn) http.RoundTripper{},
		DisableCompression:  true,
		WriteBufferSize:     4 << 10,
		ReadBufferSize:      4 << 10,
	}
	return &Client{
		base:      base,
		host:      u.Hostname(),
		proxy:     proxyFunc,
		userAgent: "yuktiops-agent/" + version,
		http: &http.Client{
			Transport: transport,
			Timeout:   requestTimeout,
			// Never follow redirects: the credential belongs to the configured host only.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

// BaseURL returns the normalized API URL.
func (c *Client) BaseURL() string { return c.base }

// Host returns the API host name.
func (c *Client) Host() string { return c.host }

// ProxyFor returns the proxy that requests to the API will use, or nil for a direct connection.
func (c *Client) ProxyFor() (*url.URL, error) {
	req, err := http.NewRequest(http.MethodGet, c.base+"/api/health", nil)
	if err != nil {
		return nil, err
	}
	return c.proxy(req)
}

// CloseIdle drops the kept-alive connection (used before a long pause).
func (c *Client) CloseIdle() { c.http.CloseIdleConnections() }

// APIError is an HTTP error answer from the backend.
type APIError struct {
	Status  int
	Message string
	// RetryAfter is the server's Retry-After hint (zero when absent or unparsable).
	RetryAfter time.Duration
}

// parseRetryAfter reads a Retry-After header: delta-seconds or an HTTP date.
func parseRetryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil {
		if n < 0 {
			return 0
		}
		return time.Duration(n) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := t.Sub(now); d > 0 {
			return d
		}
	}
	return 0
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status)
	}
	return fmt.Sprintf("the server answered with HTTP %d", e.Status)
}

// Response carries what every answer has in common.
type Response struct {
	Status int
	Date   time.Time // the server's clock, from the Date header (zero when absent)
	Body   []byte
}

func (c *Client) do(ctx context.Context, method, path, bearer string, payload any, compress bool) (*Response, error) {
	var body io.Reader
	if payload != nil {
		c.body.Reset()
		if compress {
			if c.gz == nil {
				c.gz, _ = gzip.NewWriterLevel(&c.body, gzip.BestSpeed)
			} else {
				c.gz.Reset(&c.body)
			}
			if err := json.NewEncoder(c.gz).Encode(payload); err != nil {
				return nil, err
			}
			if err := c.gz.Close(); err != nil {
				return nil, err
			}
		} else if err := json.NewEncoder(&c.body).Encode(payload); err != nil {
			return nil, err
		}
		body = bytes.NewReader(c.body.Bytes())
	}
	headers := map[string]string{}
	if payload != nil {
		headers["Content-Type"] = "application/json"
		if compress {
			headers["Content-Encoding"] = "gzip"
		}
	}
	return c.send(ctx, method, path, bearer, body, headers)
}

// Post sends a ready-made body (for example a snappy-compressed remote_write request) with the
// agent credential. Unlike the JSON calls it uses no shared buffers, so it is safe to call from
// several goroutines at once. path must be a path on the API host ("/v1/...").
func (c *Client) Post(ctx context.Context, path, bearer string, body []byte, headers map[string]string) (*Response, error) {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return nil, fmt.Errorf("invalid API path %q", path)
	}
	return c.send(ctx, http.MethodPost, path, bearer, bytes.NewReader(body), headers)
}

func (c *Client) send(ctx context.Context, method, path, bearer string, body io.Reader, headers map[string]string) (*Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseSize))
	if err != nil {
		return nil, err
	}
	out := &Response{Status: res.StatusCode, Body: data}
	if d, err := http.ParseTime(res.Header.Get("Date")); err == nil {
		out.Date = d
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		apiErr := &APIError{Status: res.StatusCode, RetryAfter: parseRetryAfter(res.Header.Get("Retry-After"), time.Now())}
		var parsed struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &parsed) == nil {
			apiErr.Message = truncate(strings.TrimSpace(parsed.Error), 300)
		}
		return out, apiErr
	}
	return out, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// RegisterRequest is the body of POST /v1/register.
type RegisterRequest struct {
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
	Platform    string `json:"platform"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	Version     string `json:"version"`
	SetupID     string `json:"setupId,omitempty"`
}

// RegisterResponse is what the backend answers. Config is kept raw: it goes through the same
// validation as any later settings download.
type RegisterResponse struct {
	AgentID     string          `json:"agentId"`
	Credential  string          `json:"credential"`
	Endpoint    string          `json:"endpoint"`
	Reconnected bool            `json:"reconnected"`
	Config      json.RawMessage `json:"config"`
}

// Register exchanges the account API key for this server's own credential.
func (c *Client) Register(ctx context.Context, apiKey string, req RegisterRequest) (*RegisterResponse, error) {
	res, err := c.do(ctx, http.MethodPost, "/v1/register", apiKey, req, false)
	if err != nil {
		return nil, err
	}
	var out RegisterResponse
	if err := json.Unmarshal(res.Body, &out); err != nil || out.Credential == "" || out.AgentID == "" {
		return nil, errors.New("the server's answer to the registration was not understood")
	}
	if strings.ContainsAny(out.Credential, " \t\r\n") || len(out.Credential) > 512 {
		return nil, errors.New("the server sent a credential in an unexpected format")
	}
	return &out, nil
}

// AgentInfo is the "agent" part of an ingest payload.
type AgentInfo struct {
	Version  string  `json:"version"`
	OS       string  `json:"os"`
	Arch     string  `json:"arch"`
	Cores    int     `json:"cores,omitempty"`
	RAMBytes float64 `json:"ramBytes,omitempty"`
}

// ErrorReport is one problem the agent tells the backend about.
type ErrorReport struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// IngestRequest is the body of POST /v1/ingest. Samples are pre-encoded data points.
type IngestRequest struct {
	SentAt  string            `json:"sentAt"`
	Agent   AgentInfo         `json:"agent"`
	Samples []json.RawMessage `json:"samples"`
	Errors  []ErrorReport     `json:"errors"`
	// Pre-encoded snapshots from the opt-in Docker and service collectors; absent when off.
	Containers json.RawMessage `json:"containers,omitempty"`
	Services   json.RawMessage `json:"services,omitempty"`
}

// IngestResponse is the backend's answer to a batch.
type IngestResponse struct {
	Accepted int `json:"accepted"`
	Dropped  int `json:"dropped"`
	Config   struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
	} `json:"config"`
	// ConfigVersion is the settings version announced by the 202 Accepted answer (no profile id).
	ConfigVersion int       `json:"configVersion"`
	ServerTime    time.Time `json:"serverTime"`
}

// Ingest sends one batch of data points (gzip-compressed JSON).
func (c *Client) Ingest(ctx context.Context, credential string, req *IngestRequest) (*IngestResponse, error) {
	if req.Errors == nil {
		req.Errors = []ErrorReport{}
	}
	res, err := c.do(ctx, http.MethodPost, "/v1/ingest", credential, req, true)
	if err != nil {
		return nil, err
	}
	var out IngestResponse
	if res.Status == http.StatusAccepted && len(bytes.TrimSpace(res.Body)) == 0 {
		return &out, nil // 202 with no body: accepted, nothing announced
	}
	if err := json.Unmarshal(res.Body, &out); err != nil {
		return nil, errors.New("the server's answer was not understood")
	}
	return &out, nil
}

// Config downloads this server's settings. The raw document is returned for remote.Parse.
func (c *Client) Config(ctx context.Context, credential string) (*Response, error) {
	return c.do(ctx, http.MethodGet, "/v1/config", credential, nil, false)
}

// Health calls the unauthenticated health endpoint; doctor uses it to test reachability and to
// read the server's clock.
func (c *Client) Health(ctx context.Context) (*Response, error) {
	return c.do(ctx, http.MethodGet, "/api/health", "", nil, false)
}
