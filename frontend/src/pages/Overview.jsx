import { Link } from 'react-router-dom';
import {
  Server,
  Boxes,
  Activity,
  TriangleAlert,
  Plus,
  ArrowUpRight,
  Clock3,
  ChevronRight,
  Check,
  AppWindow,
  Globe,
  Zap,
} from 'lucide-react';
import { useApi, useWorkspace, formatNumber, relativeTime } from '../lib/workspace';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  StatCard,
  MetricChart,
  PageHeader,
  Select,
  QueryState,
  DataTable,
  Progress,
  Empty,
} from '../components/ui';

function ChartPanel({ metric, title, color, unit, subtitle }) {
  const ws = useWorkspace();
  const query = useApi(
    '/query/metrics',
    { projectId: ws.filters.projectId, range: ws.filters.range, metric },
    { refetchInterval: 30000 },
  );
  const last = query.data?.points?.at(-1)?.value;
  return (
    <Card className="chart-card">
      <CardHeader title={title} subtitle={subtitle}>
        <div className="chart-current">
          {last == null ? '—' : formatNumber(last, 1)}
          <small>{unit}</small>
        </div>
      </CardHeader>
      <div className="chart-legend">
        <i style={{ background: color }} />
        {metric === 'cpu'
          ? 'CPU utilization'
          : metric === 'memory'
            ? 'Memory utilization'
            : 'Requests per second'}
        <span>Average across selected project</span>
      </div>
      <QueryState query={query}>
        {(data) => <MetricChart points={data.points} color={color} unit={unit} />}
      </QueryState>
    </Card>
  );
}
export function Overview() {
  const ws = useWorkspace();
  const query = useApi(
    '/overview',
    { projectId: ws.filters.projectId, environment: ws.filters.environment },
    { refetchInterval: 30000 },
  );
  return (
    <>
      <PageHeader
        title="Workspace overview"
        description="Your stack at a glance. Everything that matters, in one place."
      >
        <div className="time-select">
          <Clock3 size={15} />
          <Select
            aria-label="Time range"
            value={ws.filters.range}
            onChange={(e) => ws.setRange(e.target.value)}
          >
            <option value="15m">Last 15 minutes</option>
            <option value="1h">Last 1 hour</option>
            <option value="6h">Last 6 hours</option>
            <option value="24h">Last 24 hours</option>
          </Select>
        </div>
        <Button onClick={ws.openOnboarding} disabled={!ws.canEdit}>
          <Plus size={16} />
          Connect source
        </Button>
      </PageHeader>
      <QueryState query={query}>
        {(data) => (
          <>
            <div className="health-banner">
              <span className={`health-banner-icon ${data.incidents.length ? 'warning' : ''}`}>
                {data.incidents.length ? <TriangleAlert size={18} /> : <Check size={18} />}
              </span>
              <div>
                <strong>
                  {data.incidents.length
                    ? 'Your stack needs a little attention'
                    : data.servers
                      ? 'Looking good. Your stack is healthy.'
                      : 'Your workspace is ready to connect.'}
                </strong>
                <p>
                  {data.incidents.length
                    ? `${data.incidents.length} active ${data.incidents.length === 1 ? 'incident' : 'incidents'} across your workspace. Everything else is running smoothly.`
                    : data.servers
                      ? 'Your connected resources are reporting healthy status.'
                      : 'Install an agent to start monitoring your infrastructure.'}
                </p>
              </div>
              <Link to="/alerts">
                View alerts
                <ArrowUpRight size={15} />
              </Link>
            </div>
            <div className="stats-grid">
              <StatCard
                title="Monitored servers"
                value={data.servers}
                icon={Server}
                seed={1}
                detail={
                  <>
                    <i className="status-dot" />
                    {data.healthyServers} healthy{' '}
                    <span className="muted">of {data.servers} servers</span>
                  </>
                }
              />
              <StatCard
                title="Containers"
                value={data.containers}
                icon={Boxes}
                seed={3}
                tone="blue"
                detail={
                  <>
                    <i className="status-dot" />
                    {data.runningContainers} running{' '}
                    <span className="muted">across your hosts</span>
                  </>
                }
              />
              <StatCard
                title="Request throughput"
                value={
                  <>
                    {formatNumber(data.throughput)}
                    <small>req/s</small>
                  </>
                }
                icon={Activity}
                seed={5}
                tone="green"
                detail={
                  <>
                    <span className="purple-text">{data.applications} services</span>
                    <span className="muted"> reporting application metrics</span>
                  </>
                }
              />
              <StatCard
                title="Active incidents"
                value={data.incidents.length}
                icon={TriangleAlert}
                seed={8}
                tone="amber"
                detail={
                  <>
                    <span className={data.incidents.length ? 'amber-text' : 'green-text'}>
                      {data.incidents.length ? 'Needs attention' : 'All clear'}
                    </span>
                    <span className="muted"> · Email notifications enabled</span>
                  </>
                }
              />
            </div>
            <div className="section-heading">
              <h2>Infrastructure performance</h2>
              <Link to="/infrastructure">
                Explore infrastructure
                <ArrowUpRight size={14} />
              </Link>
            </div>
            <div className="two-col">
              <ChartPanel
                metric="cpu"
                title="CPU utilization"
                subtitle="How hard your infrastructure is working"
                color="#8c74e8"
                unit="%"
              />
              <ChartPanel
                metric="memory"
                title="Memory usage"
                subtitle="Memory consumption across your hosts"
                color="#4ca9a7"
                unit="%"
              />
            </div>
            <div className="overview-lower">
              <Card>
                <CardHeader
                  title="Server health"
                  subtitle="A pulse check on your connected infrastructure"
                >
                  <Link className="subtle-link" to="/servers">
                    View all
                    <ChevronRight size={14} />
                  </Link>
                </CardHeader>
                <DataTable
                  pageSize={5}
                  rows={data.resources.filter((r) => r.type === 'server')}
                  emptyTitle="No servers connected"
                  columns={[
                    {
                      key: 'name',
                      label: 'Server',
                      render: (r) => (
                        <div className="resource-name">
                          <span className="resource-icon">
                            <Server size={16} />
                          </span>
                          <div>
                            <strong>{r.name}</strong>
                            <small>{r.labels?.region || r.environment}</small>
                          </div>
                        </div>
                      ),
                    },
                    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
                    {
                      key: 'cpu',
                      label: 'CPU',
                      render: (r) => (
                        <div className="metric-cell">
                          <span>{r.labels?.cpu ?? '—'}%</span>
                          <Progress value={r.labels?.cpu} />
                        </div>
                      ),
                    },
                    {
                      key: 'memory',
                      label: 'Memory',
                      render: (r) => <span>{r.labels?.memory ?? '—'}%</span>,
                    },
                  ]}
                />
              </Card>
              <Card className="recent-incidents">
                <CardHeader title="Recent incidents" subtitle="Keep the important things in view">
                  <span className="count-chip">{data.incidents.length}</span>
                </CardHeader>
                {data.incidents.length ? (
                  data.incidents.map((i) => (
                    <Link className="incident-preview" to="/alerts" key={i.id}>
                      <span className="incident-icon">
                        <TriangleAlert size={17} />
                      </span>
                      <div>
                        <strong>{i.name}</strong>
                        <span>
                          <Badge status={i.severity} />
                          <small>{relativeTime(i.startedAt)}</small>
                        </span>
                      </div>
                      <ChevronRight size={15} />
                    </Link>
                  ))
                ) : (
                  <Empty title="A quiet inbox" description="Active incidents will appear here." />
                )}
                <div className="incident-tip">
                  <Zap size={17} />
                  <p>
                    Catch issues before your customers do.
                    <Link to="/alerts">
                      Manage alert rules
                      <ArrowUpRight size={13} />
                    </Link>
                  </p>
                </div>
              </Card>
            </div>
            <div className="application-strip">
              <div className="application-strip-title">
                <span className="resource-icon purple">
                  <AppWindow size={20} />
                </span>
                <div>
                  <strong>A closer look at your applications</strong>
                  <p>Follow a request from first byte to final response.</p>
                </div>
              </div>
              <div>
                <span className="strip-stat">
                  <small>ERROR RATE</small>
                  <strong>
                    {formatNumber(data.errorRate, 2)}
                    <small>%</small>
                  </strong>
                </span>
                <span className="strip-stat">
                  <small>P95 LATENCY</small>
                  <strong>
                    {formatNumber(data.p95)}
                    <small>ms</small>
                  </strong>
                </span>
                <Link className="button button-secondary" to="/applications">
                  Explore applications
                  <ArrowUpRight size={15} />
                </Link>
              </div>
            </div>
            {data.source === 'demo' && (
              <p className="data-note">
                You’re viewing sample telemetry. Connect a source to try real host inventory; use
                connected mode for stored metrics, logs, and traces.
              </p>
            )}
          </>
        )}
      </QueryState>
    </>
  );
}
