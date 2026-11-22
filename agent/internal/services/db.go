package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver
	mssql "github.com/microsoft/go-mssqldb"

	"github.com/yuktiops/agent/internal/remote"
)

// Metric is one exporter-compatible sample (redis_*, mysql_*, pg_*, mssql_*).
type Metric struct {
	Name    string
	Labels  map[string]string
	Value   float64
	Counter bool
}

// ErrAuthFailed means the database refused the user name or password.
var ErrAuthFailed = errors.New("auth failed: wrong user or password")

// dbTimeout bounds one authenticated check or one metrics scrape of one database.
const dbTimeout = 5 * time.Second

// AuthDetail turns the result of an authenticated check into the status detail. It never
// contains the secret, the user name or the server's own error text.
func AuthDetail(err error) string {
	switch {
	case err == nil:
		return "authenticated"
	case errors.Is(err, ErrAuthFailed):
		return ErrAuthFailed.Error()
	case errors.Is(err, ErrCredentialsNotFound), errors.Is(err, ErrCredentialsMode):
		return err.Error()
	case errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err):
		return "auth check failed: timed out"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "auth check failed: connection refused"
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return "auth check failed: connection failed"
	}
	return "auth check failed"
}

// QueryDB logs in to the database of s with creds. With metrics it also reads the exporter
// metrics; without, it only checks the login. Errors are classified (ErrAuthFailed) and never
// carry the secret.
func QueryDB(ctx context.Context, s remote.Service, creds Credentials, metrics bool) ([]Metric, error) {
	ctx, cancel := context.WithTimeout(ctx, dbTimeout)
	defer cancel()
	host := s.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := s.Port
	if port == 0 {
		port = remote.DefaultPorts[s.Kind]
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	switch s.Kind {
	case "redis":
		return redisQuery(ctx, addr, creds, metrics)
	case "mysql", "postgres", "mssql":
		return sqlQuery(ctx, s.Kind, addr, creds, metrics)
	}
	return nil, fmt.Errorf("%s has no authenticated check", s.Kind)
}

func sqlQuery(ctx context.Context, kind, addr string, creds Credentials, metrics bool) ([]Metric, error) {
	driver, dsn, err := dsnFor(kind, addr, creds)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, errors.New("invalid credentials URL") // the driver's message may echo the DSN
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(dbTimeout)
	if err := db.PingContext(ctx); err != nil {
		return nil, classifySQL(err)
	}
	if !metrics {
		return nil, nil
	}
	switch kind {
	case "mysql":
		return mysqlMetrics(ctx, db), nil
	case "postgres":
		return postgresMetrics(ctx, db), nil
	default:
		return mssqlMetrics(ctx, db), nil
	}
}

func classifySQL(err error) error {
	var me *mysql.MySQLError
	if errors.As(err, &me) && (me.Number == 1045 || me.Number == 1044 || me.Number == 1698) {
		return ErrAuthFailed
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) && (pe.Code == "28P01" || pe.Code == "28000") {
		return ErrAuthFailed
	}
	var se mssql.Error
	if errors.As(err, &se) && se.Number == 18456 {
		return ErrAuthFailed
	}
	var sp *mssql.Error
	if errors.As(err, &sp) && sp.Number == 18456 {
		return ErrAuthFailed
	}
	// Keep only the classification; the driver's text may name the user or the DSN.
	switch {
	case errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err):
		return context.DeadlineExceeded
	case errors.Is(err, syscall.ECONNREFUSED):
		return syscall.ECONNREFUSED
	}
	return errors.New("login failed")
}

// dsnFor builds the driver name and connection string. A URL from the credentials is used as
// it is; otherwise the service's host and port are combined with USER, PASSWORD, DATABASE and
// SSLMODE.
func dsnFor(kind, addr string, c Credentials) (string, string, error) {
	switch kind {
	case "mysql":
		var cfg *mysql.Config
		if c.URL != "" {
			raw := c.URL
			if u, err := url.Parse(raw); err == nil && u.Scheme == "mysql" {
				pass, _ := u.User.Password()
				cfg = mysql.NewConfig()
				cfg.User, cfg.Passwd, cfg.Net, cfg.Addr = u.User.Username(), pass, "tcp", u.Host
				cfg.DBName = strings.TrimPrefix(u.Path, "/")
			} else if parsed, err := mysql.ParseDSN(raw); err == nil {
				cfg = parsed
			} else {
				return "", "", errors.New("invalid credentials URL")
			}
		} else {
			cfg = mysql.NewConfig()
			cfg.User, cfg.Passwd, cfg.Net, cfg.Addr, cfg.DBName = c.User, c.Password, "tcp", addr, c.Database
		}
		cfg.Timeout, cfg.ReadTimeout, cfg.WriteTimeout = 3*time.Second, dbTimeout, dbTimeout
		cfg.AllowNativePasswords = true
		switch strings.ToLower(c.SSLMode) {
		case "disable", "false", "off":
			cfg.TLSConfig = "false"
		case "require", "skip-verify":
			cfg.TLSConfig = "skip-verify"
		case "verify-full", "verify-ca", "true":
			cfg.TLSConfig = "true"
		case "", "prefer", "preferred":
			if cfg.TLSConfig == "" {
				cfg.TLSConfig = "preferred"
			}
		}
		return "mysql", cfg.FormatDSN(), nil

	case "postgres":
		if c.URL != "" {
			return "pgx", c.URL, nil
		}
		db := c.Database
		if db == "" {
			db = "postgres"
		}
		mode := c.SSLMode
		if mode == "" {
			mode = "prefer"
		}
		q := url.Values{"sslmode": {mode}, "connect_timeout": {"3"}, "application_name": {"yuktiops-agent"}}
		u := url.URL{Scheme: "postgres", User: url.UserPassword(c.User, c.Password), Host: addr, Path: "/" + db, RawQuery: q.Encode()}
		return "pgx", u.String(), nil

	case "mssql":
		if c.URL != "" {
			return "sqlserver", c.URL, nil
		}
		q := url.Values{"dial timeout": {"3"}, "app name": {"yuktiops-agent"}}
		if c.Database != "" {
			q.Set("database", c.Database)
		}
		switch strings.ToLower(c.SSLMode) {
		case "disable", "false", "off":
			q.Set("encrypt", "disable")
		case "require", "skip-verify":
			q.Set("encrypt", "true")
			q.Set("TrustServerCertificate", "true")
		case "verify-full", "verify-ca", "true":
			q.Set("encrypt", "true")
		default:
			q.Set("TrustServerCertificate", "true")
		}
		u := url.URL{Scheme: "sqlserver", User: url.UserPassword(c.User, c.Password), Host: addr, RawQuery: q.Encode()}
		return "sqlserver", u.String(), nil
	}
	return "", "", fmt.Errorf("unsupported kind %s", kind)
}

// ---- metrics ----------------------------------------------------------------------------------

func gauge(name string, v float64, labels ...string) Metric {
	return Metric{Name: name, Value: v, Labels: pairs(labels)}
}

func counter(name string, v float64, labels ...string) Metric {
	return Metric{Name: name, Value: v, Labels: pairs(labels), Counter: true}
}

func pairs(kv []string) map[string]string {
	if len(kv) == 0 {
		return nil
	}
	m := make(map[string]string, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return m
}

// sanitizeName lower-cases a server variable name into a metric name fragment.
func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// parseStatusValue reads a numeric status value; ON/YES count as 1 and OFF/NO as 0, as in
// mysqld_exporter.
func parseStatusValue(v string) (float64, bool) {
	switch strings.ToUpper(v) {
	case "ON", "YES":
		return 1, true
	case "OFF", "NO":
		return 0, true
	}
	f, err := strconv.ParseFloat(v, 64)
	return f, err == nil
}

// mysqlVariables are the global variables exported as mysql_global_variables_*.
var mysqlVariables = map[string]bool{
	"max_connections": true, "innodb_buffer_pool_size": true, "table_open_cache": true,
	"thread_cache_size": true, "open_files_limit": true, "key_buffer_size": true,
	"max_allowed_packet": true, "innodb_log_file_size": true, "query_cache_size": true,
	"max_user_connections": true, "innodb_log_buffer_size": true, "long_query_time": true,
}

func mysqlMetrics(ctx context.Context, db *sql.DB) []Metric {
	out := []Metric{gauge("mysql_up", 1)}
	if rows, err := db.QueryContext(ctx, "SHOW GLOBAL STATUS"); err == nil {
		for rows.Next() {
			var name, value string
			if rows.Scan(&name, &value) != nil {
				continue
			}
			v, ok := parseStatusValue(value)
			if !ok {
				continue
			}
			key := sanitizeName(name)
			switch {
			case strings.HasPrefix(key, "com_"):
				out = append(out, counter("mysql_global_status_commands_total", v, "command", strings.TrimPrefix(key, "com_")))
			case strings.HasPrefix(key, "handler_"):
				out = append(out, counter("mysql_global_status_handlers_total", v, "handler", strings.TrimPrefix(key, "handler_")))
			case strings.HasPrefix(key, "connection_errors_"):
				out = append(out, counter("mysql_global_status_connection_errors_total", v, "error", strings.TrimPrefix(key, "connection_errors_")))
			case strings.HasPrefix(key, "innodb_buffer_pool_pages_") && key != "innodb_buffer_pool_pages_flushed":
				out = append(out, gauge("mysql_global_status_buffer_pool_pages", v, "state", strings.TrimPrefix(key, "innodb_buffer_pool_pages_")))
			default:
				out = append(out, gauge("mysql_global_status_"+key, v))
			}
		}
		rows.Close()
	}
	if rows, err := db.QueryContext(ctx, "SHOW GLOBAL VARIABLES"); err == nil {
		for rows.Next() {
			var name, value string
			if rows.Scan(&name, &value) != nil {
				continue
			}
			key := sanitizeName(name)
			if key == "version" {
				out = append(out, gauge("mysql_version_info", 1, "version", value))
				continue
			}
			if !mysqlVariables[key] {
				continue
			}
			if v, ok := parseStatusValue(value); ok {
				out = append(out, gauge("mysql_global_variables_"+key, v))
			}
		}
		rows.Close()
	}
	return out
}

var pgDatabaseColumns = []struct {
	column  string
	counter bool
}{
	{"numbackends", false}, {"xact_commit", true}, {"xact_rollback", true}, {"blks_read", true},
	{"blks_hit", true}, {"tup_returned", true}, {"tup_fetched", true}, {"tup_inserted", true},
	{"tup_updated", true}, {"tup_deleted", true}, {"conflicts", true}, {"temp_files", true},
	{"temp_bytes", true}, {"deadlocks", true},
}

func postgresMetrics(ctx context.Context, db *sql.DB) []Metric {
	out := []Metric{gauge("pg_up", 1)}
	cols := make([]string, len(pgDatabaseColumns))
	for i, c := range pgDatabaseColumns {
		cols[i] = "coalesce(" + c.column + ",0)::float8"
	}
	q := "SELECT datname, " + strings.Join(cols, ", ") + " FROM pg_stat_database WHERE datname IS NOT NULL"
	if rows, err := db.QueryContext(ctx, q); err == nil {
		for rows.Next() {
			var name string
			vals := make([]float64, len(pgDatabaseColumns))
			dest := []any{&name}
			for i := range vals {
				dest = append(dest, &vals[i])
			}
			if rows.Scan(dest...) != nil {
				continue
			}
			for i, c := range pgDatabaseColumns {
				m := gauge("pg_stat_database_"+c.column, vals[i], "datname", name)
				m.Counter = c.counter
				out = append(out, m)
			}
		}
		rows.Close()
	}
	if rows, err := db.QueryContext(ctx, "SELECT datname, pg_database_size(datname)::float8 FROM pg_database WHERE datallowconn AND has_database_privilege(datname, 'CONNECT')"); err == nil {
		for rows.Next() {
			var name string
			var size float64
			if rows.Scan(&name, &size) == nil {
				out = append(out, gauge("pg_database_size_bytes", size, "datname", name))
			}
		}
		rows.Close()
	}
	if rows, err := db.QueryContext(ctx, "SELECT coalesce(datname,''), coalesce(state,'unknown'), count(*)::float8 FROM pg_stat_activity GROUP BY 1, 2"); err == nil {
		for rows.Next() {
			var name, state string
			var n float64
			if rows.Scan(&name, &state, &n) == nil {
				out = append(out, gauge("pg_stat_activity_count", n, "datname", name, "state", state))
			}
		}
		rows.Close()
	}
	var maxConn string
	if db.QueryRowContext(ctx, "SHOW max_connections").Scan(&maxConn) == nil {
		if v, err := strconv.ParseFloat(maxConn, 64); err == nil {
			out = append(out, gauge("pg_settings_max_connections", v))
		}
	}
	var version string
	if db.QueryRowContext(ctx, "SHOW server_version").Scan(&version) == nil {
		out = append(out, gauge("pg_static", 1, "short_version", strings.Fields(version + " ")[0], "version", version))
	}
	return out
}

// mssqlCounters maps sys.dm_os_performance_counters rows to metric names. scale converts KB.
var mssqlCounters = map[string]struct {
	name    string
	counter bool
	scale   float64
}{
	"User Connections":          {"mssql_user_connections", false, 1},
	"Batch Requests/sec":        {"mssql_batch_requests_total", true, 1},
	"SQL Compilations/sec":      {"mssql_sql_compilations_total", true, 1},
	"SQL Re-Compilations/sec":   {"mssql_sql_recompilations_total", true, 1},
	"Page life expectancy":      {"mssql_page_life_expectancy_seconds", false, 1},
	"Processes blocked":         {"mssql_processes_blocked", false, 1},
	"Transactions/sec":          {"mssql_transactions_total", true, 1},
	"Number of Deadlocks/sec":   {"mssql_deadlocks_total", true, 1},
	"Lock Waits/sec":            {"mssql_lock_waits_total", true, 1},
	"Logins/sec":                {"mssql_logins_total", true, 1},
	"Logouts/sec":               {"mssql_logouts_total", true, 1},
	"Errors/sec":                {"mssql_errors_total", true, 1},
	"Target Server Memory (KB)": {"mssql_server_target_memory_bytes", false, 1024},
	"Total Server Memory (KB)":  {"mssql_server_total_memory_bytes", false, 1024},
}

func mssqlMetrics(ctx context.Context, db *sql.DB) []Metric {
	out := []Metric{gauge("mssql_up", 1)}
	names := make([]string, 0, len(mssqlCounters)+2)
	for n := range mssqlCounters {
		names = append(names, "'"+n+"'")
	}
	names = append(names, "'Buffer cache hit ratio'", "'Buffer cache hit ratio base'")
	q := "SELECT RTRIM(counter_name), RTRIM(instance_name), CAST(cntr_value AS float) FROM sys.dm_os_performance_counters WHERE counter_name IN (" + strings.Join(names, ",") + ")"
	var ratio, base float64
	if rows, err := db.QueryContext(ctx, q); err == nil {
		seen := map[string]bool{}
		for rows.Next() {
			var name, instance string
			var v float64
			if rows.Scan(&name, &instance, &v) != nil {
				continue
			}
			switch name {
			case "Buffer cache hit ratio":
				ratio = v
				continue
			case "Buffer cache hit ratio base":
				base = v
				continue
			}
			def, ok := mssqlCounters[name]
			if !ok || (instance != "" && instance != "_Total") || seen[def.name] {
				continue
			}
			seen[def.name] = true
			out = append(out, Metric{Name: def.name, Value: v * def.scale, Counter: def.counter})
		}
		rows.Close()
	}
	if base > 0 {
		out = append(out, gauge("mssql_buffer_cache_hit_ratio", ratio/base))
	}
	var uptime float64
	if db.QueryRowContext(ctx, "SELECT CAST(DATEDIFF(SECOND, sqlserver_start_time, SYSDATETIME()) AS float) FROM sys.dm_os_sys_info").Scan(&uptime) == nil {
		out = append(out, gauge("mssql_uptime_seconds", uptime))
	}
	return out
}
