import { useState } from 'react';
import {
  Bell,
  Plus,
  Check,
  CheckCheck,
  ShieldCheck,
  Clock3,
  Mail,
  Radio,
  KeyRound,
  RefreshCw,
  Ban,
  Server,
  Globe,
  Play,
  Trash2,
  Copy,
  ExternalLink,
  TriangleAlert,
} from 'lucide-react';
import { useApi, useWorkspace, useAction, relativeTime, formatDate } from '../lib/workspace';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  Modal,
  FormModal,
  PageHeader,
  QueryState,
  Tabs,
  Toggle,
  SearchInput,
  StatCard,
  Field,
  Input,
  Select,
  Empty,
  copy,
} from '../components/ui';

export function AlertsPage() {
  const ws = useWorkspace(),
    action = useAction();
  const query = useApi('/alerts', {}, { refetchInterval: 30000 }),
    notifications = useApi('/notifications', {}, { enabled: ws.canAdmin });
  const [tab, setTab] = useState('incidents'),
    [create, setCreate] = useState(false),
    [delivery, setDelivery] = useState(null);
  const counts =
    query.data?.incidents.reduce((a, i) => ({ ...a, [i.state]: (a[i.state] || 0) + 1 }), {}) || {};
  const projectOptions = ws.projects.map((p) => ({ value: p.id, label: p.name }));
  const selected = (row) => !ws.filters.projectId || row.projectId === ws.filters.projectId;
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Know when something needs you. Stay focused when it doesn’t."
      >
        <Button
          variant="secondary"
          onClick={() => action.mutate({ path: '/alerts/evaluate' })}
          loading={action.isPending}
          disabled={!ws.canEdit}
        >
          <RefreshCw size={15} />
          Evaluate now
        </Button>
        <Button onClick={() => setCreate(true)} disabled={!ws.canEdit}>
          <Plus size={16} />
          Create alert rule
        </Button>
      </PageHeader>
      <div className="stats-grid three">
        <StatCard
          title="Firing"
          value={counts.firing || 0}
          icon={Bell}
          tone="amber"
          seed={3}
          detail="Incidents that need attention"
        />
        <StatCard
          title="Acknowledged"
          value={counts.acknowledged || 0}
          icon={CheckCheck}
          tone="blue"
          seed={6}
          detail="Your team is on it"
        />
        <StatCard
          title="Resolved"
          value={counts.resolved || 0}
          icon={ShieldCheck}
          tone="green"
          seed={9}
          detail="Recovered and back to normal"
        />
      </div>
      <Card>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'incidents', label: 'Incidents', count: query.data?.incidents.length },
            { value: 'rules', label: 'Alert rules', count: query.data?.rules.length },
            ...(ws.canAdmin
              ? [
                  {
                    value: 'notifications',
                    label: 'Notification history',
                    count: notifications.data?.deliveries.length,
                  },
                ]
              : []),
          ]}
        />
        <QueryState query={query}>
          {(data) =>
            tab === 'incidents' ? (
              <DataTable
                rows={data.incidents.filter(selected)}
                emptyTitle="No incidents"
                emptyDescription="Your alert rules are watching. Active incidents will appear here."
                columns={[
                  {
                    key: 'name',
                    label: 'Incident',
                    render: (r) => (
                      <div className="resource-name">
                        <span
                          className={`resource-icon ${r.state === 'resolved' ? 'green' : 'amber'}`}
                        >
                          <Bell size={16} />
                        </span>
                        <div>
                          <strong>{r.name}</strong>
                          <small>Observed value: {r.value}</small>
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'severity',
                    label: 'Severity',
                    render: (r) => <Badge status={r.severity} />,
                  },
                  { key: 'state', label: 'State', render: (r) => <Badge status={r.state} /> },
                  { key: 'startedAt', label: 'Started', render: (r) => relativeTime(r.startedAt) },
                  {
                    key: 'actions',
                    label: '',
                    sortable: false,
                    render: (r) =>
                      ws.canEdit &&
                      r.state !== 'resolved' && (
                        <div className="row-actions">
                          {r.state === 'firing' && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                action.mutate({
                                  path: `/alerts/incidents/${r.id}`,
                                  method: 'PATCH',
                                  body: { state: 'acknowledged' },
                                })
                              }
                            >
                              Acknowledge
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              action.mutate({
                                path: `/alerts/incidents/${r.id}`,
                                method: 'PATCH',
                                body: { state: 'resolved' },
                              })
                            }
                          >
                            <Check size={14} />
                            Resolve
                          </Button>
                        </div>
                      ),
                  },
                ]}
              />
            ) : tab === 'rules' ? (
              <DataTable
                rows={data.rules.filter(selected)}
                emptyTitle="Create your first alert rule"
                emptyDescription="Start with CPU utilization, memory, or service availability."
                columns={[
                  {
                    key: 'name',
                    label: 'Alert rule',
                    render: (r) => (
                      <div className="name-stack">
                        <strong>{r.name}</strong>
                        <small>
                          {r.metric} {r.operator === 'gt' ? '>' : '<'} {r.threshold} for{' '}
                          {r.durationSeconds}s
                        </small>
                      </div>
                    ),
                  },
                  {
                    key: 'severity',
                    label: 'Severity',
                    render: (r) => <Badge status={r.severity} />,
                  },
                  {
                    key: 'cooldownSeconds',
                    label: 'Cooldown',
                    render: (r) => `${r.cooldownSeconds / 60} min`,
                  },
                  {
                    key: 'enabled',
                    label: 'Enabled',
                    render: (r) => (
                      <Toggle
                        label={`Enable ${r.name}`}
                        checked={r.enabled}
                        disabled={!ws.canEdit}
                        onChange={(enabled) =>
                          action.mutate({
                            path: `/alerts/rules/${r.id}`,
                            method: 'PATCH',
                            body: { enabled },
                          })
                        }
                      />
                    ),
                  },
                  {
                    key: 'silence',
                    label: '',
                    sortable: false,
                    render: (r) => (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!ws.canEdit}
                        onClick={() =>
                          action.mutate({
                            path: `/alerts/rules/${r.id}`,
                            method: 'PATCH',
                            body: {
                              silenceUntil:
                                r.silenceUntil && new Date(r.silenceUntil) > new Date()
                                  ? null
                                  : new Date(Date.now() + 3600000).toISOString(),
                            },
                          })
                        }
                      >
                        <Clock3 size={14} />
                        {r.silenceUntil && new Date(r.silenceUntil) > new Date()
                          ? 'Unsilence'
                          : 'Silence 1h'}
                      </Button>
                    ),
                  },
                ]}
              />
            ) : (
              <QueryState query={notifications}>
                {(n) => (
                  <>
                    <div className="inline-note">
                      <Mail size={15} />
                      {n.provider === 'local'
                        ? 'Local email adapter: messages are saved here. No email is sent.'
                        : 'Messages are delivered through your SMTP provider.'}
                    </div>
                    <DataTable
                      rows={n.deliveries}
                      onRowClick={setDelivery}
                      emptyTitle="No notifications yet"
                      emptyDescription="Notification delivery attempts will be recorded here."
                      columns={[
                        { key: 'subject', label: 'Notification' },
                        { key: 'address', label: 'Recipient' },
                        {
                          key: 'status',
                          label: 'Delivery',
                          render: (r) => <Badge status={r.status} />,
                        },
                        { key: 'attempts', label: 'Attempts' },
                        {
                          key: 'createdAt',
                          label: 'Created',
                          render: (r) => formatDate(r.createdAt),
                        },
                      ]}
                    />
                  </>
                )}
              </QueryState>
            )
          }
        </QueryState>
      </Card>
      <FormModal
        open={create}
        onOpenChange={setCreate}
        title="Create alert rule"
        description="A focused rule for the resources in your project."
        loading={action.isPending}
        submitLabel="Create rule"
        onSubmit={(body) => action.mutateAsync({ path: '/alerts/rules', body })}
        fields={[
          { name: 'name', label: 'Rule name', placeholder: 'High CPU utilization' },
          {
            name: 'projectId',
            label: 'Project',
            options: projectOptions,
            defaultValue: ws.filters.projectId || projectOptions[0]?.value,
          },
          {
            name: 'metric',
            label: 'Metric',
            options: [
              { value: 'cpu', label: 'CPU utilization (%)' },
              { value: 'memory', label: 'Memory utilization (%)' },
              { value: 'disk', label: 'Disk utilization (%)' },
              { value: 'availability', label: 'Availability (0 or 1)' },
              { value: 'certificateDays', label: 'Certificate days remaining' },
            ],
          },
          {
            name: 'operator',
            label: 'Condition',
            options: [
              { value: 'gt', label: 'Above threshold' },
              { value: 'lt', label: 'Below threshold' },
            ],
          },
          { name: 'threshold', label: 'Threshold', type: 'number', defaultValue: 85 },
          {
            name: 'durationSeconds',
            label: 'Pending duration (seconds)',
            type: 'number',
            defaultValue: 60,
            min: 0,
            max: 3600,
          },
          { name: 'severity', label: 'Severity', options: ['warning', 'critical'] },
        ]}
      />
      <Modal
        open={!!delivery}
        onOpenChange={(v) => !v && setDelivery(null)}
        title={delivery?.subject || 'Notification'}
        description={delivery?.address}
      >
        {delivery && <pre className="json-view">{delivery.body}</pre>}
      </Modal>
    </>
  );
}
export function AgentsPage() {
  const ws = useWorkspace(),
    query = useApi('/agents', {}, { refetchInterval: 10000 }),
    action = useAction();
  const [search, setSearch] = useState(''),
    [secret, setSecret] = useState(null);
  const rows = (query.data || []).filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) &&
      (!ws.filters.projectId || a.projectId === ws.filters.projectId),
  );
  return (
    <>
      <PageHeader
        title="Agent management"
        description="Small footprint. Strong connection. Your link to every host."
      >
        <Button onClick={ws.openOnboarding} disabled={!ws.canEdit}>
          <Plus size={16} />
          Connect agent
        </Button>
      </PageHeader>
      <div className="stats-grid three">
        <StatCard
          title="Connected agents"
          value={rows.filter((a) => ['healthy', 'degraded'].includes(a.status)).length}
          icon={Radio}
          tone="green"
          seed={4}
          detail="Agents reporting to your workspace"
        />
        <StatCard
          title="Total agents"
          value={rows.length}
          icon={Server}
          seed={6}
          detail="Servers and hosts you have connected"
        />
        <StatCard
          title="Offline or revoked"
          value={rows.filter((a) => ['offline', 'revoked'].includes(a.status)).length}
          icon={TriangleAlert}
          tone="amber"
          seed={8}
          detail="Check connectivity or enroll again"
        />
      </div>
      <Card>
        <div className="table-toolbar">
          <h3>
            All agents <span className="count-chip">{rows.length}</span>
          </h3>
          <SearchInput value={search} onChange={setSearch} placeholder="Search agents…" />
        </div>
        <QueryState query={query}>
          <DataTable
            rows={rows}
            emptyTitle="No agents connected"
            emptyDescription="Connect a host to start reporting infrastructure measurements."
            columns={[
              {
                key: 'name',
                label: 'Agent',
                render: (a) => (
                  <div className="resource-name">
                    <span className="resource-icon">
                      <Radio size={17} />
                    </span>
                    <div>
                      <strong>{a.name}</strong>
                      <small>{a.id.slice(0, 12)}</small>
                    </div>
                  </div>
                ),
              },
              { key: 'status', label: 'Status', render: (a) => <Badge status={a.status} /> },
              {
                key: 'platform',
                label: 'Platform',
                render: (a) => <span className="capitalize">{a.platform}</span>,
              },
              { key: 'version', label: 'Version', render: (a) => <code>v{a.version}</code> },
              {
                key: 'lastSeen',
                label: 'Last heartbeat',
                render: (a) => relativeTime(a.lastSeen),
              },
              {
                key: 'actions',
                label: '',
                sortable: false,
                render: (a) => (
                  <div className="row-actions">
                    {ws.canEdit && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Rotate credential"
                          aria-label={`Rotate credential for ${a.name}`}
                          disabled={a.status === 'revoked'}
                          onClick={async () => {
                            try {
                              setSecret(
                                await action.mutateAsync({ path: `/agents/${a.id}/rotate` }),
                              );
                            } catch {}
                          }}
                        >
                          <KeyRound size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Revoke agent"
                          aria-label={`Revoke ${a.name}`}
                          disabled={a.status === 'revoked'}
                          onClick={() => action.mutate({ path: `/agents/${a.id}/revoke` })}
                        >
                          <Ban size={15} />
                        </Button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <div className="callout">
        <Radio size={18} />
        <p>
          Each server has its own credential, shown once. We store only a hash of it, so a lost
          credential is replaced by rotating it. Revoke an agent to cut off a server immediately.
        </p>
      </div>
      <Modal
        open={!!secret}
        onOpenChange={(v) => !v && setSecret(null)}
        title="New agent credential"
        description="Save this value as AGENT_TOKEN in the agent’s config file, then restart the agent."
      >
        <div className="secret-value">
          <code>{secret?.token}</code>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy agent credential"
            onClick={() => copy(secret.token, ws.notify)}
          >
            <Copy size={16} />
          </Button>
        </div>
        <p className="muted text-sm">The previous credential is revoked immediately.</p>
      </Modal>
    </>
  );
}
export function UptimePage() {
  const ws = useWorkspace(),
    query = useApi('/uptime', {}, { refetchInterval: 30000 }),
    action = useAction();
  const [create, setCreate] = useState(false),
    [selected, setSelected] = useState(null);
  const checks = useApi(`/uptime/${selected?.id || 'none'}/checks`, {}, { enabled: !!selected });
  const rows = (query.data || []).filter(
    (r) => !ws.filters.projectId || r.projectId === ws.filters.projectId,
  );
  return (
    <>
      <PageHeader
        title="Uptime monitoring"
        description="Be the first to know when your services stop responding."
      >
        <Button onClick={() => setCreate(true)} disabled={!ws.canEdit}>
          <Plus size={16} />
          Add monitor
        </Button>
      </PageHeader>
      <div className="stats-grid three">
        <StatCard
          title="Healthy endpoints"
          value={rows.filter((r) => r.status === 'healthy').length}
          icon={Globe}
          tone="green"
          seed={2}
          detail="Public HTTP, HTTPS, and TCP endpoints"
        />
        <StatCard
          title="Total monitors"
          value={rows.length}
          icon={ActivityIcon}
          tone="blue"
          seed={5}
          detail="Checked from this deployment"
        />
        <StatCard
          title="Average response"
          value={
            <>
              {rows.length
                ? Math.round(rows.reduce((a, r) => a + (r.latencyMs || 0), 0) / rows.length)
                : '—'}
              <small>ms</small>
            </>
          }
          icon={Clock3}
          seed={7}
          detail="From the most recent checks"
        />
      </div>
      <Card>
        <CardHeader
          title="Your monitors"
          subtitle="Availability, response time, and certificate health"
        />
        <QueryState query={query}>
          <DataTable
            rows={rows}
            onRowClick={setSelected}
            emptyTitle="Keep an eye on your first endpoint"
            emptyDescription="Add a public URL to monitor availability and response time."
            columns={[
              {
                key: 'name',
                label: 'Monitor',
                render: (r) => (
                  <div className="resource-name">
                    <span className="resource-icon">
                      <Globe size={17} />
                    </span>
                    <div>
                      <strong>{r.name}</strong>
                      <small>{r.target}</small>
                    </div>
                  </div>
                ),
              },
              {
                key: 'status',
                label: 'Status',
                render: (r) => <Badge status={r.enabled ? r.status : 'paused'} />,
              },
              { key: 'latencyMs', label: 'Response', render: (r) => `${r.latencyMs ?? '—'} ms` },
              { key: 'intervalSeconds', label: 'Interval', render: (r) => `${r.intervalSeconds}s` },
              {
                key: 'lastCheckedAt',
                label: 'Last checked',
                render: (r) => relativeTime(r.lastCheckedAt),
              },
              {
                key: 'actions',
                label: '',
                sortable: false,
                render: (r) =>
                  ws.canEdit && (
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Run check"
                        aria-label={`Check ${r.name}`}
                        onClick={() => action.mutate({ path: `/uptime/${r.id}/check` })}
                      >
                        <Play size={14} />
                      </Button>
                      <Toggle
                        label={`Enable ${r.name}`}
                        checked={r.enabled}
                        onChange={(enabled) =>
                          action.mutate({
                            path: `/uptime/${r.id}`,
                            method: 'PATCH',
                            body: { enabled },
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete monitor"
                        aria-label={`Delete ${r.name}`}
                        onClick={() => action.mutate({ path: `/uptime/${r.id}`, method: 'DELETE' })}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <div className="inline-note">
        <Globe size={15} />
        Checks run from one region. Private networks, redirects to internal addresses, and cloud
        metadata endpoints are blocked.
      </div>
      <FormModal
        open={create}
        onOpenChange={setCreate}
        title="Add uptime monitor"
        description="Monitor a public service from this deployment."
        loading={action.isPending}
        submitLabel="Create monitor"
        onSubmit={(body) => action.mutateAsync({ path: '/uptime', body })}
        fields={[
          { name: 'name', label: 'Monitor name', placeholder: 'Production API' },
          {
            name: 'projectId',
            label: 'Project',
            options: ws.projects.map((p) => ({ value: p.id, label: p.name })),
            defaultValue: ws.filters.projectId || ws.projects[0]?.id,
          },
          {
            name: 'target',
            label: 'Target URL',
            placeholder: 'https://example.com/health',
            hint: 'HTTP, HTTPS, or tcp://public-host:port',
          },
          {
            name: 'intervalSeconds',
            label: 'Check interval (seconds)',
            type: 'number',
            min: ws.plan.minCheckIntervalSeconds,
            max: 86400,
            defaultValue: ws.plan.minCheckIntervalSeconds,
          },
          {
            name: 'failureThreshold',
            label: 'Failures before marking down',
            type: 'number',
            min: 1,
            max: 10,
            defaultValue: 3,
          },
        ]}
      />
      <Modal
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        title={selected?.name || 'Check history'}
        description={selected?.target}
        wide
      >
        <QueryState query={checks}>
          {(data) => (
            <DataTable
              rows={data}
              emptyTitle="No checks recorded yet"
              emptyDescription="Checks run on the configured interval. You can also run one manually."
              columns={[
                { key: 'createdAt', label: 'Checked at', render: (r) => formatDate(r.createdAt) },
                {
                  key: 'ok',
                  label: 'Result',
                  render: (r) => <Badge status={r.ok ? 'healthy' : 'unhealthy'} />,
                },
                { key: 'statusCode', label: 'HTTP status' },
                { key: 'latencyMs', label: 'Response', render: (r) => `${r.latencyMs} ms` },
                { key: 'error', label: 'Details', render: (r) => r.error || 'OK' },
              ]}
            />
          )}
        </QueryState>
      </Modal>
    </>
  );
}
const ActivityIcon = Radio;
