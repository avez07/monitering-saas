// "Test it locally" guides: copy-paste commands to check a service by hand before (or after)
// adding it to YuktiOps. Keyed by service type. Add a type here and it appears in the UI.

const web = (what) => ({
  intro: `Before adding it, confirm ${what} answers from a terminal on your own machine (or on the server it runs on).`,
  steps: [
    {
      title: 'Fetch the headers and status code',
      code: 'curl -I https://your-site.example.com',
      healthy: 'The first line says HTTP/2 200 (or HTTP/1.1 200 OK). 301/302 means a redirect, so use the final address.',
    },
    {
      title: 'Measure the response time',
      code: 'curl -o /dev/null -s -w "status=%{http_code} time=%{time_total}s\\n" https://your-site.example.com',
      healthy: 'status=200 and a time under about 1 second.',
    },
  ],
  windows: 'On Windows PowerShell use curl.exe instead of curl, and NUL instead of /dev/null.',
});

export const LOCAL_TEST_GUIDES = {
  website: {
    title: 'Website',
    ...web('your page'),
  },
  api: {
    title: 'API',
    intro: 'Call the API the way YuktiOps will, and check the answer is what you expect.',
    steps: [
      {
        title: 'Call the health endpoint',
        code: 'curl -i https://api.example.com/health',
        healthy: 'HTTP 200 and a short body such as {"status":"ok"}.',
      },
      {
        title: 'With a header or a body (POST)',
        code: `curl -i -X POST https://api.example.com/ping \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"ping":true}'`,
        healthy: 'The status code you plan to expect (usually 200). Paste this same command into "Paste cURL" when you add the check.',
      },
    ],
  },
  tcp: {
    title: 'TCP port',
    intro: 'A port check only opens a connection. Test that the connection opens.',
    steps: [
      {
        title: 'Linux or macOS',
        code: 'nc -zv your-host.example.com 5432',
        healthy: 'Connection to ... succeeded! (or "open"). "Connection refused" or a timeout means nothing is listening or a firewall blocks it.',
      },
      {
        title: 'Windows PowerShell',
        code: 'Test-NetConnection your-host.example.com -Port 5432',
        healthy: 'TcpTestSucceeded : True',
      },
    ],
  },
  nginx: {
    title: 'nginx',
    intro: 'Run these on the host where nginx runs.',
    steps: [
      {
        title: 'Is nginx running?',
        code: 'systemctl status nginx --no-pager',
        healthy: 'Active: active (running).',
      },
      {
        title: 'Is the status page on?',
        code: 'curl http://127.0.0.1/nginx_status',
        healthy: 'Output starting with "Active connections: N". If you get 404, add a location with stub_status on; (then nginx -t && systemctl reload nginx).',
      },
    ],
  },
  apache: {
    title: 'Apache',
    intro: 'Run these on the host where Apache runs.',
    steps: [
      {
        title: 'Is Apache running?',
        code: 'systemctl status apache2 --no-pager   # httpd on CentOS/RHEL',
        healthy: 'Active: active (running).',
      },
      {
        title: 'Is the status page on?',
        code: 'curl "http://127.0.0.1/server-status?auto"',
        healthy: 'Lines such as "BusyWorkers: 2" and "IdleWorkers: 8". 403/404 means mod_status is not enabled for localhost.',
      },
    ],
  },
  mysql: {
    title: 'MySQL',
    intro: 'Run these on the host (or from a machine that can reach it).',
    steps: [
      {
        title: 'Does it answer?',
        code: 'mysqladmin -h 127.0.0.1 -P 3306 -u root -p ping',
        healthy: 'mysqld is alive',
      },
      {
        title: 'Can you run a query?',
        code: 'mysql -h 127.0.0.1 -P 3306 -u root -p -e "SELECT 1"',
        healthy: 'A table showing 1.',
      },
    ],
  },
  postgres: {
    title: 'PostgreSQL',
    intro: 'Run these on the host (or from a machine that can reach it).',
    steps: [
      {
        title: 'Is it accepting connections?',
        code: 'pg_isready -h 127.0.0.1 -p 5432',
        healthy: '127.0.0.1:5432 - accepting connections',
      },
      {
        title: 'Can you run a query?',
        code: `psql -h 127.0.0.1 -p 5432 -U postgres -c 'select 1'`,
        healthy: 'A table showing 1 and "(1 row)".',
      },
    ],
  },
  mssql: {
    title: 'Microsoft SQL Server',
    intro: 'Run these on the host (or from a machine that can reach it).',
    steps: [
      {
        title: 'Is the port open?',
        code: 'nc -zv 127.0.0.1 1433   # Windows PowerShell: Test-NetConnection 127.0.0.1 -Port 1433',
        healthy: 'Connection succeeded (TcpTestSucceeded : True). A refused connection means SQL Server is not listening on TCP: enable TCP/IP in SQL Server Configuration Manager.',
      },
      {
        title: 'Can you run a query?',
        code: `sqlcmd -S 127.0.0.1,1433 -U sa -Q "SELECT @@VERSION"`,
        healthy: 'The SQL Server version is printed. "Login failed" still means the server is running.',
      },
    ],
  },
  redis: {
    title: 'Redis',
    intro: 'Run these on the host (or from a machine that can reach it).',
    steps: [
      {
        title: 'Ping it',
        code: 'redis-cli -h 127.0.0.1 -p 6379 ping',
        healthy: 'PONG. NOAUTH means it needs a password: add -a YOUR_PASSWORD.',
      },
      {
        title: 'Check basic health',
        code: 'redis-cli -h 127.0.0.1 -p 6379 info server | head -n 5',
        healthy: 'redis_version and uptime_in_seconds are shown.',
      },
    ],
  },
  systemd: {
    title: 'System service',
    intro: 'Run these on the host that runs the service. Replace nginx with your unit name.',
    steps: [
      {
        title: 'Is it running?',
        code: 'systemctl status nginx --no-pager',
        healthy: 'Active: active (running).',
      },
      {
        title: 'Short answer for scripts',
        code: 'systemctl is-active nginx',
        healthy: 'active. "inactive" or "failed" means YuktiOps will report it as stopped.',
      },
      {
        title: 'List all unit names',
        code: 'systemctl list-units --type=service --state=running',
        healthy: 'Your service appears. Use the name without .service.',
      },
    ],
  },
  process: {
    title: 'Program',
    intro: 'Run these on the host. The program name is the name of the process, not the folder.',
    steps: [
      {
        title: 'Is the process running?',
        code: 'pgrep -a php-fpm',
        healthy: 'One or more lines with a process ID. No output means it is not running.',
      },
      {
        title: 'Alternative with ps',
        code: 'ps aux | grep [p]hp-fpm',
        healthy: 'At least one line for the program.',
      },
    ],
  },
  frontend: {
    title: 'Frontend app',
    intro: 'Start the app on its own and check it from the browser and the terminal.',
    steps: [
      {
        title: 'Start only the frontend',
        code: 'npm run dev -w frontend',
        healthy: 'It prints a local address such as http://127.0.0.1:5173.',
      },
      {
        title: 'Check it answers',
        code: 'curl -I http://127.0.0.1:5173',
        healthy: 'HTTP/1.1 200 OK. Open the address in a browser and the page loads without errors in the console.',
      },
    ],
  },
  backend: {
    title: 'Backend app',
    intro: 'Start the API on its own in a separate terminal and call it.',
    steps: [
      {
        title: 'Start only the backend',
        code: 'npm run dev -w backend',
        healthy: 'It logs that it is listening on a port (for example 4000).',
      },
      {
        title: 'Check the health route',
        code: 'curl -i http://127.0.0.1:4000/health',
        healthy: 'HTTP 200 with a small ok message. Adjust the port or path to your app.',
      },
    ],
  },
  worker: {
    title: 'Worker',
    intro: 'A worker has no web address, so check that it runs and picks up jobs.',
    steps: [
      {
        title: 'Start only the worker',
        code: 'npm run dev -w backend -- worker   # or your own worker command',
        healthy: 'The log says it is ready and waiting for jobs, with no connection errors to Redis or the database.',
      },
      {
        title: 'Check Redis is reachable',
        code: 'redis-cli -h 127.0.0.1 ping',
        healthy: 'PONG. Then trigger a job in the app and watch the worker log print it.',
      },
    ],
  },
  server: {
    title: 'Server',
    intro: 'After installing the agent, check it from the server itself.',
    steps: [
      {
        title: 'Is the agent running?',
        code: 'systemctl status yuktiops-agent --no-pager   # Docker: docker ps --filter name=yuktiops-agent',
        healthy: 'Active: active (running), or the container shows "Up".',
      },
      {
        title: 'Can the server reach YuktiOps?',
        code: 'curl -I https://YOUR_YUKTIOPS_URL/api/health',
        healthy: 'HTTP 200. The server shows as Connected on the Servers page within a minute.',
      },
    ],
  },
};

const ALIASES = {
  http: 'website', keyword: 'website', web: 'website', 'web page': 'website', url: 'website',
  mariadb: 'mysql', postgresql: 'postgres', httpd: 'apache', program: 'process',
  'system service': 'systemd', 'tcp port': 'tcp', port: 'tcp', host: 'server', 'docker-host': 'server',
  sqlserver: 'mssql', 'sql server': 'mssql', 'microsoft sql server': 'mssql',
  'frontend app': 'frontend', 'backend app': 'backend',
};

/** Find the guide for a type or kind string; null when we have none. */
export function guideFor(type) {
  const key = String(type || '').toLowerCase().trim();
  return LOCAL_TEST_GUIDES[ALIASES[key] || key] || null;
}
