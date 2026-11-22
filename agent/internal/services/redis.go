package services

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxRedisInfo = 1 << 20

// redisQuery logs in with AUTH (raw RESP, no client library) and, for metrics, reads INFO.
func redisQuery(ctx context.Context, addr string, c Credentials, metrics bool) ([]Metric, error) {
	user, pass, useTLS, skipVerify := c.User, c.Password, false, false
	if c.URL != "" {
		u, err := url.Parse(c.URL)
		if err != nil || (u.Scheme != "redis" && u.Scheme != "rediss") || u.Host == "" {
			return nil, errors.New("invalid credentials URL")
		}
		addr = u.Host
		if u.Port() == "" {
			addr = net.JoinHostPort(u.Hostname(), "6379")
		}
		useTLS = u.Scheme == "rediss"
		if u.User != nil {
			user = u.User.Username()
			if p, ok := u.User.Password(); ok {
				pass = p
			} else if user != "" {
				// redis://:password@host or redis://password@host
				pass, user = user, ""
			}
		}
	}
	switch strings.ToLower(c.SSLMode) {
	case "require", "skip-verify":
		useTLS, skipVerify = true, true
	case "verify-full", "true":
		useTLS = true
	}
	d := net.Dialer{Timeout: checkTimeout}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	} else {
		conn.SetDeadline(time.Now().Add(dbTimeout))
	}
	if useTLS {
		host, _, _ := net.SplitHostPort(addr)
		tc := tls.Client(conn, &tls.Config{ServerName: host, InsecureSkipVerify: skipVerify, MinVersion: tls.VersionTLS12}) //nolint:gosec // opt-in via SSLMODE=require
		if err := tc.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		conn = tc
	}
	r := bufio.NewReader(conn)
	args := []string{"AUTH", pass}
	if user != "" {
		args = []string{"AUTH", user, pass}
	}
	if _, err := conn.Write(respCommand(args...)); err != nil {
		return nil, err
	}
	line, err := readLine(r)
	if err != nil {
		return nil, err
	}
	switch {
	case strings.HasPrefix(line, "+OK"):
	case strings.Contains(line, "no password is set"), strings.Contains(line, "without any password configured"):
		// The server has no password: the login is trivially fine.
	case strings.HasPrefix(line, "-WRONGPASS"), strings.HasPrefix(line, "-ERR invalid"), strings.HasPrefix(line, "-NOPERM"):
		return nil, ErrAuthFailed
	default:
		return nil, errors.New("unexpected reply")
	}
	if !metrics {
		return nil, nil
	}
	if _, err := conn.Write(respCommand("INFO")); err != nil {
		return nil, err
	}
	info, err := readBulk(r)
	if err != nil {
		return nil, err
	}
	return redisMetrics(info), nil
}

func respCommand(args ...string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	return []byte(b.String())
}

func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	if len(line) > 4096 {
		return "", errors.New("reply too long")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func readBulk(r *bufio.Reader) (string, error) {
	head, err := readLine(r)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(head, "-") {
		if strings.HasPrefix(head, "-NOPERM") {
			return "", errors.New("INFO is not allowed for this user")
		}
		return "", errors.New("INFO failed")
	}
	if !strings.HasPrefix(head, "$") && !strings.HasPrefix(head, "=") {
		return "", errors.New("unexpected reply")
	}
	n, err := strconv.Atoi(head[1:])
	if err != nil || n < 0 || n > maxRedisInfo {
		return "", errors.New("unexpected reply")
	}
	buf := make([]byte, n+2)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", err
	}
	return string(buf[:n]), nil
}

// redisInfoFields maps INFO fields to redis_exporter metric names.
var redisInfoFields = map[string]struct {
	name    string
	counter bool
}{
	"uptime_in_seconds":           {"redis_uptime_in_seconds", false},
	"connected_clients":           {"redis_connected_clients", false},
	"blocked_clients":             {"redis_blocked_clients", false},
	"used_memory":                 {"redis_memory_used_bytes", false},
	"used_memory_rss":             {"redis_memory_used_rss_bytes", false},
	"used_memory_peak":            {"redis_memory_used_peak_bytes", false},
	"maxmemory":                   {"redis_memory_max_bytes", false},
	"mem_fragmentation_ratio":     {"redis_mem_fragmentation_ratio", false},
	"total_connections_received":  {"redis_connections_received_total", true},
	"total_commands_processed":    {"redis_commands_processed_total", true},
	"instantaneous_ops_per_sec":   {"redis_instantaneous_ops_per_sec", false},
	"total_net_input_bytes":       {"redis_net_input_bytes_total", true},
	"total_net_output_bytes":      {"redis_net_output_bytes_total", true},
	"rejected_connections":        {"redis_rejected_connections_total", true},
	"expired_keys":                {"redis_expired_keys_total", true},
	"evicted_keys":                {"redis_evicted_keys_total", true},
	"keyspace_hits":               {"redis_keyspace_hits_total", true},
	"keyspace_misses":             {"redis_keyspace_misses_total", true},
	"connected_slaves":            {"redis_connected_slaves", false},
	"used_cpu_sys":                {"redis_cpu_sys_seconds_total", true},
	"used_cpu_user":               {"redis_cpu_user_seconds_total", true},
	"rdb_changes_since_last_save": {"redis_rdb_changes_since_last_save", false},
	"rdb_last_save_time":          {"redis_rdb_last_save_timestamp_seconds", false},
}

func redisMetrics(info string) []Metric {
	out := []Metric{gauge("redis_up", 1)}
	var version, role string
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		key, value, ok := strings.Cut(line, ":")
		if !ok || strings.HasPrefix(line, "#") {
			continue
		}
		switch {
		case key == "redis_version":
			version = value
		case key == "role":
			role = value
		case strings.HasPrefix(key, "db") && isNumber(key[2:]):
			// db0:keys=1,expires=0,avg_ttl=0
			for _, part := range strings.Split(value, ",") {
				k, v, _ := strings.Cut(part, "=")
				n, err := strconv.ParseFloat(v, 64)
				if err != nil {
					continue
				}
				switch k {
				case "keys":
					out = append(out, gauge("redis_db_keys", n, "db", key))
				case "expires":
					out = append(out, gauge("redis_db_keys_expiring", n, "db", key))
				}
			}
		default:
			if def, ok := redisInfoFields[key]; ok {
				if n, err := strconv.ParseFloat(value, 64); err == nil {
					out = append(out, Metric{Name: def.name, Value: n, Counter: def.counter})
				}
			}
		}
	}
	if version != "" || role != "" {
		out = append(out, gauge("redis_instance_info", 1, "redis_version", version, "role", role))
	}
	return out
}
