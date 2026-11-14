import { Link } from 'react-router-dom';
import {
  Server,
  Globe,
  TriangleAlert,
  Plus,
  ArrowUpRight,
  ChevronRight,
  Check,
  Zap,
  ServerOff,
} from 'lucide-react';
import { useApi, useWorkspace, relativeTime } from '../lib/workspace';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  StatCard,
  PageHeader,
  QueryState,
  DataTable,
  Progress,
  Empty,
} from '../components/ui';

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
        title="Overview"
        description="Your servers and websites at a glance. Everything that matters, in one place."
      >
        <Button onClick={ws.openOnboarding} disabled={!ws.canEdit}>
          <Plus size={16} />
          Connect a server
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
                    ? 'Something needs your attention'
                    : data.servers
                      ? 'Looking good. Everything is healthy.'
                      : 'Your workspace is ready to connect.'}
                </strong>
                <p>
                  {data.incidents.length
                    ? `${data.incidents.length} active ${data.incidents.length === 1 ? 'incident' : 'incidents'}. Everything else is running smoothly.`
                    : data.servers
                      ? 'Your connected servers are reporting healthy status.'
                      : 'Connect a server to start monitoring it.'}
                </p>
              </div>
              <Link to="/alerts">
                View alerts
                <ArrowUpRight size={15} />
              </Link>
            </div>
            <div className="stats-grid">
              <StatCard
                title="Servers"
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
                title="Servers offline"
                value={data.offlineServers}
                icon={ServerOff}
                seed={3}
                tone="amber"
                detail={
                  data.warningServers
                    ? `${data.warningServers} more under heavy load`
                    : 'No servers under heavy load'
                }
              />
              <StatCard
                title="Websites"
                value={data.sites}
                icon={Globe}
                seed={5}
                tone="green"
                detail={
                  <>
                    <span className="purple-text">{data.healthySites} up</span>
                    <span className="muted"> of {data.sites} monitored</span>
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
            <div className="overview-lower">
              <Card>
                <CardHeader title="Server health" subtitle="The latest report from each server">
                  <Link className="subtle-link" to="/servers">
                    View all
                    <ChevronRight size={14} />
                  </Link>
                </CardHeader>
                <DataTable
                  pageSize={5}
                  rows={data.resources}
                  emptyTitle="No servers connected"
                  emptyDescription="Connect a server and it will show up here within a minute."
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
                            <small>{r.labels?.os || r.environment}</small>
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
            <p className="data-note">
              Charts with 1 hour to 30 day history are coming in the next release. Values shown are
              each server’s latest report.
            </p>
          </>
        )}
      </QueryState>
    </>
  );
}
