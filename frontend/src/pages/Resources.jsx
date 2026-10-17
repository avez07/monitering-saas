import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Server,
  Boxes,
  AppWindow,
  Database,
  Layers3,
  Plus,
  ArrowUpRight,
  Copy,
  Trash2,
  Activity,
} from 'lucide-react';
import { useApi, useWorkspace, useAction, formatNumber } from '../lib/workspace';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  Field,
  Input,
  Select,
  SearchInput,
  Modal,
  PageHeader,
  QueryState,
  Progress,
  StatCard,
  Tabs,
  MetricChart,
} from '../components/ui';

const definitions = {
  server: {
    title: 'Servers',
    description: 'Keep every host healthy, wherever it runs.',
    icon: Server,
  },
  container: {
    title: 'Containers',
    description: 'A clear view of your workloads, from first start to last restart.',
    icon: Boxes,
  },
  application: {
    title: 'Applications',
    description: 'Understand the services that power your product.',
    icon: AppWindow,
  },
  database: {
    title: 'Databases',
    description: 'Watch connections, query latency, and database health.',
    icon: Database,
  },
};
export function ResourcePage({ type }) {
  const ws = useWorkspace(),
    action = useAction(),
    [searchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') || ''),
    [status, setStatus] = useState(''),
    [selected, setSelected] = useState(null),
    [create, setCreate] = useState(false),
    [tab, setTab] = useState('metrics');
  const definition = definitions[type] || {
    title: 'Infrastructure',
    description: 'Every resource, every environment. One connected view.',
    icon: Layers3,
  };
  const Icon = definition.icon;
  const query = useApi(
    '/resources',
    { type, projectId: ws.filters.projectId, environment: ws.filters.environment },
    { refetchInterval: 30000 },
  );
  const chart = useApi(
    '/query/metrics',
    { projectId: selected?.projectId, range: ws.filters.range, metric: 'cpu' },
    { enabled: !!selected },
  );
  const rows = (query.data || []).filter(
    (r) => r.name.toLowerCase().includes(search.toLowerCase()) && (!status || r.status === status),
  );
  const metric = (key, suffix = '%') => ({
    key,
    label: {
      cpu: 'CPU',
      memory: 'Memory',
      disk: 'Disk',
      p95: 'P95 latency',
      throughput: 'Throughput',
      errorRate: 'Error rate',
      connections: 'Connections',
      latency: 'Query latency',
      restarts: 'Restarts',
    }[key],
    sortValue: (r) => r.labels?.[key] || 0,
    render: (r) =>
      ['cpu', 'memory', 'disk'].includes(key) && type !== 'container' ? (
        <div className="metric-cell">
          <span>
            {r.labels?.[key] ?? '—'}
            {suffix}
          </span>
          <Progress value={r.labels?.[key]} />
        </div>
      ) : (
        <span className="tabular">
          {r.labels?.[key] == null ? '—' : formatNumber(r.labels[key], 2)}
          {suffix}
        </span>
      ),
  });
  const columns = [
    {
      key: 'name',
      label: type ? `${definition.title.replace(/s$/, '')} name` : 'Resource name',
      render: (r) => {
        const ResourceIcon = definitions[r.type]?.icon || Server;
        return (
          <div className="resource-name">
            <span className={`resource-icon ${r.type === 'application' ? 'purple' : ''}`}>
              <ResourceIcon size={17} />
            </span>
            <div>
              <strong>{r.name}</strong>
              <small>
                {r.labels?.image ||
                  r.labels?.engine ||
                  r.labels?.runtime ||
                  r.labels?.ip ||
                  r.labels?.region ||
                  r.type}
              </small>
            </div>
          </div>
        );
      },
    },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
    ...(!type
      ? [
          {
            key: 'type',
            label: 'Type',
            render: (r) => <span className="capitalize">{r.type}</span>,
          },
        ]
      : []),
    ...(type === 'application'
      ? [metric('throughput', ' req/s'), metric('errorRate'), metric('p95', ' ms')]
      : type === 'database'
        ? [metric('connections', ''), metric('latency', ' ms')]
        : type === 'container'
          ? [metric('cpu'), metric('memory', ' MB'), metric('restarts', '')]
          : [metric('cpu'), metric('memory'), metric('disk')]),
    {
      key: 'environment',
      label: 'Environment',
      render: (r) => <span className="environment-tag">{r.environment}</span>,
    },
    {
      key: 'open',
      label: '',
      sortable: false,
      render: () => <ArrowUpRight className="muted" size={15} />,
    },
  ];
  async function add(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await action.mutateAsync({ path: '/resources', body: { ...data, labels: {} } });
      setCreate(false);
      ws.notify('Resource registered. Connect an exporter or agent to report its measurements.');
    } catch {}
  }
  return (
    <>
      <PageHeader title={definition.title} description={definition.description}>
        <Button
          onClick={type === 'server' || !type ? ws.openOnboarding : () => setCreate(true)}
          disabled={!ws.canEdit}
        >
          <Plus size={16} />
          {type === 'server' || !type ? 'Connect source' : `Add ${type}`}
        </Button>
      </PageHeader>
      <QueryState query={query}>
        {(data) => (
          <>
            <div className="stats-grid compact">
              <StatCard
                title={`Total ${type ? definition.title.toLowerCase() : 'resources'}`}
                value={data.length}
                icon={Icon}
                seed={2}
                detail="Across the selected workspace"
              />
              <StatCard
                title="Healthy resources"
                value={data.filter((r) => ['healthy', 'running'].includes(r.status)).length}
                icon={Activity}
                tone="green"
                seed={4}
                detail={
                  <>
                    <i className="status-dot" />
                    Reporting normal operation
                  </>
                }
              />
              <StatCard
                title="Needs attention"
                value={
                  data.filter((r) => ['warning', 'unhealthy', 'stopped'].includes(r.status)).length
                }
                icon={Activity}
                tone="amber"
                seed={7}
                detail="Review resources with warnings"
              />
              <StatCard
                title="Environments"
                value={new Set(data.map((r) => r.environment)).size}
                icon={Layers3}
                tone="blue"
                seed={1}
                detail="Isolated views of your infrastructure"
              />
            </div>
            <Card>
              <div className="table-toolbar">
                <div>
                  <h3>
                    {type ? `All ${definition.title.toLowerCase()}` : 'All resources'}{' '}
                    <span className="count-chip">{rows.length}</span>
                  </h3>
                </div>
                <div>
                  <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Search resources…"
                  />
                  <Select
                    aria-label="Resource status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {['healthy', 'running', 'warning', 'stopped', 'pending', 'unhealthy'].map(
                      (s) => (
                        <option key={s}>{s}</option>
                      ),
                    )}
                  </Select>
                </div>
              </div>
              <DataTable
                columns={columns}
                rows={rows}
                onRowClick={(r) => {
                  setSelected(r);
                  setTab('metrics');
                }}
                emptyTitle="No resources found"
                emptyDescription="Connect a source or adjust your filters to see your infrastructure."
              />
            </Card>
            {type === 'application' && (
              <Card className="dependency-card">
                <CardHeader
                  title="Service dependencies"
                  subtitle="Relationships reported by your services"
                />
                <div className="dependency-map">
                  {data
                    .filter((r) => r.labels?.dependencies?.length)
                    .map((r) => (
                      <div key={r.id}>
                        <span className="dependency-node">
                          <AppWindow size={16} />
                          {r.name}
                        </span>
                        <span className="dependency-line">→</span>
                        <div>
                          {r.labels.dependencies.map((d) => (
                            <span key={d} className="dependency-node">
                              <Database size={15} />
                              {d}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  {!data.some((r) => r.labels?.dependencies?.length) && (
                    <p className="muted">
                      Dependency relationships require service graph instrumentation.
                    </p>
                  )}
                </div>
              </Card>
            )}
            {type === 'database' && (
              <div className="callout">
                <Database size={18} />
                <p>
                  Use a least-privilege database exporter to send measurements. Query values and
                  database content are excluded from the supplied collector configuration. See
                  docs/AGENTS.md for integration steps.
                </p>
              </div>
            )}
          </>
        )}
      </QueryState>
      <Modal
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        title={selected?.name || 'Resource details'}
        description="Resource measurements and reported metadata."
        wide
      >
        {selected && (
          <>
            <div className="detail-summary">
              <Badge status={selected.status} />
              <span className="environment-tag">{selected.environment}</span>
              <code>{selected.id}</code>
            </div>
            <Tabs
              tabs={[
                { value: 'metrics', label: 'Performance' },
                { value: 'metadata', label: 'Resource metadata' },
              ]}
              value={tab}
              onChange={setTab}
            />
            {tab === 'metrics' ? (
              <>
                <div className="mini-stat-grid">
                  {Object.entries(selected.labels || {})
                    .filter(([, v]) => typeof v === 'number')
                    .slice(0, 6)
                    .map(([k, v]) => (
                      <div key={k}>
                        <small>{k}</small>
                        <strong>{formatNumber(v, 2)}</strong>
                      </div>
                    ))}
                </div>
                <p className="muted text-sm">
                  Project CPU trend · Host measurements above are the most recent report.
                </p>
                <QueryState query={chart}>
                  {(data) => <MetricChart points={data.points} />}
                </QueryState>
              </>
            ) : (
              <pre className="json-view">{JSON.stringify(selected, null, 2)}</pre>
            )}
            <div className="form-actions">
              {ws.canEdit && (
                <Button
                  variant="danger"
                  loading={action.isPending}
                  onClick={async () => {
                    try {
                      await action.mutateAsync({
                        path: `/resources/${selected.id}`,
                        method: 'DELETE',
                      });
                      setSelected(null);
                      ws.notify('Resource removed from inventory.');
                    } catch {}
                  }}
                >
                  <Trash2 size={15} />
                  Remove resource
                </Button>
              )}
              <Button variant="secondary" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={create}
        onOpenChange={setCreate}
        title={`Register ${type || 'resource'}`}
        description="Register the resource, then connect its instrumentation to report telemetry."
      >
        <form onSubmit={add} className="form-stack">
          <Field label="Name">
            <Input
              name="name"
              required
              minLength={2}
              placeholder={type === 'application' ? 'checkout-service' : 'postgres-primary'}
            />
          </Field>
          <Field label="Project">
            <Select name="projectId" defaultValue={ws.filters.projectId || ws.projects[0]?.id}>
              {ws.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Environment">
            <Select name="environment">
              <option>production</option>
              <option>staging</option>
              <option>development</option>
            </Select>
          </Field>
          <input type="hidden" name="type" value={type || 'server'} />
          <div className="form-actions">
            <Button type="submit" loading={action.isPending}>
              Register resource
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
