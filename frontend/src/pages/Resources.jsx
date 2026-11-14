import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Server, Plus, ArrowUpRight, Trash2, Activity, Layers3 } from 'lucide-react';
import { useApi, useWorkspace, useAction, formatNumber, relativeTime } from '../lib/workspace';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Select,
  SearchInput,
  Modal,
  PageHeader,
  QueryState,
  Progress,
  StatCard,
} from '../components/ui';

const percent = (key, label) => ({
  key,
  label,
  sortValue: (r) => r.labels?.[key] || 0,
  render: (r) => (
    <div className="metric-cell">
      <span>{r.labels?.[key] == null ? '—' : `${formatNumber(r.labels[key], 1)}%`}</span>
      <Progress value={r.labels?.[key]} />
    </div>
  ),
});

export function ServersPage() {
  const ws = useWorkspace(),
    action = useAction(),
    [searchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') || ''),
    [status, setStatus] = useState(''),
    [selected, setSelected] = useState(null);
  const query = useApi(
    '/resources',
    { type: 'server', projectId: ws.filters.projectId, environment: ws.filters.environment },
    { refetchInterval: 30000 },
  );
  const rows = (query.data || []).filter(
    (r) => r.name.toLowerCase().includes(search.toLowerCase()) && (!status || r.status === status),
  );
  const columns = [
    {
      key: 'name',
      label: 'Server',
      render: (r) => (
        <div className="resource-name">
          <span className="resource-icon">
            <Server size={17} />
          </span>
          <div>
            <strong>{r.name}</strong>
            <small>{r.labels?.os || r.environment}</small>
          </div>
        </div>
      ),
    },
    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
    percent('cpu', 'CPU'),
    percent('memory', 'Memory'),
    percent('disk', 'Disk'),
    {
      key: 'environment',
      label: 'Environment',
      render: (r) => <span className="environment-tag">{r.environment}</span>,
    },
    {
      key: 'updatedAt',
      label: 'Last report',
      render: (r) => <span className="muted">{relativeTime(r.updatedAt)}</span>,
    },
    {
      key: 'open',
      label: '',
      sortable: false,
      render: () => <ArrowUpRight className="muted" size={15} />,
    },
  ];
  return (
    <>
      <PageHeader title="Servers" description="Every server you monitor, and how it is doing now.">
        <Button onClick={ws.openOnboarding} disabled={!ws.canEdit}>
          <Plus size={16} />
          Connect a server
        </Button>
      </PageHeader>
      <QueryState query={query}>
        {(data) => (
          <>
            <div className="stats-grid compact">
              <StatCard
                title="Total servers"
                value={data.length}
                icon={Server}
                seed={2}
                detail={`${ws.plan.name} plan includes ${ws.plan.includedServers}`}
              />
              <StatCard
                title="Healthy"
                value={data.filter((r) => r.status === 'healthy').length}
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
                value={data.filter((r) => ['warning', 'unhealthy'].includes(r.status)).length}
                icon={Activity}
                tone="amber"
                seed={7}
                detail="High load, or not reporting"
              />
              <StatCard
                title="Environments"
                value={new Set(data.map((r) => r.environment)).size}
                icon={Layers3}
                tone="blue"
                seed={1}
                detail="Production, staging and more"
              />
            </div>
            <Card>
              <div className="table-toolbar">
                <div>
                  <h3>
                    All servers <span className="count-chip">{rows.length}</span>
                  </h3>
                </div>
                <div>
                  <SearchInput value={search} onChange={setSearch} placeholder="Search servers…" />
                  <Select
                    aria-label="Server status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {['healthy', 'warning', 'pending', 'unhealthy'].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <DataTable
                columns={columns}
                rows={rows}
                onRowClick={setSelected}
                emptyTitle="No servers yet"
                emptyDescription="Connect your first server. It takes about two minutes."
              />
            </Card>
            <p className="data-note">
              Charts with 1 hour to 30 day history are coming in the next release. Values shown are
              each server’s latest report.
            </p>
          </>
        )}
      </QueryState>
      <Modal
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        title={selected?.name || 'Server details'}
        description="Latest reported measurements and details."
        wide
      >
        {selected && (
          <>
            <div className="detail-summary">
              <Badge status={selected.status} />
              <span className="environment-tag">{selected.environment}</span>
              <code>{selected.id}</code>
            </div>
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
            <pre className="json-view">{JSON.stringify(selected, null, 2)}</pre>
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
                      ws.notify('Server removed from inventory.');
                    } catch {
                      /* the error toast is shown by the shared mutation handler */
                    }
                  }}
                >
                  <Trash2 size={15} />
                  Remove server
                </Button>
              )}
              <Button variant="secondary" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
