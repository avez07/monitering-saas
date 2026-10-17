import { useEffect, useState } from 'react';
import {
  ScrollText,
  Route,
  Search,
  ChevronRight,
  Download,
  Copy,
  Clock3,
  Play,
  ArrowDownUp,
} from 'lucide-react';
import { useApi, useWorkspace, formatDate } from '../lib/workspace';
import { download } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Input,
  Select,
  Modal,
  PageHeader,
  QueryState,
  SearchInput,
  copy,
  Empty,
} from '../components/ui';

function useDebounced(value) {
  const [result, setResult] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setResult(value), 350);
    return () => clearTimeout(t);
  }, [value]);
  return result;
}
function ExplorerControls({ search, setSearch, level, setLevel }) {
  const ws = useWorkspace();
  return (
    <div className="explorer-controls">
      <div className="query-language">
        <span>{setLevel ? 'Log search' : 'Trace search'}</span>
        <Search size={15} />
        <Input
          aria-label="Search telemetry"
          placeholder={
            setLevel
              ? 'Search log messages or service names…'
              : 'Search operations or service names…'
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="explorer-selects">
        {setLevel && (
          <Select aria-label="Log level" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
            <option value="debug">Debug</option>
          </Select>
        )}
        <Select
          aria-label="Explorer time range"
          value={ws.filters.range}
          onChange={(e) => ws.setRange(e.target.value)}
        >
          <option value="15m">Last 15 minutes</option>
          <option value="1h">Last 1 hour</option>
          <option value="6h">Last 6 hours</option>
          <option value="24h">Last 24 hours</option>
        </Select>
      </div>
    </div>
  );
}
export function LogsPage() {
  const ws = useWorkspace(),
    [search, setSearch] = useState(''),
    [level, setLevel] = useState(''),
    [selected, setSelected] = useState(null),
    [live, setLive] = useState(false);
  const debounced = useDebounced(search);
  const query = useApi(
    '/query/logs',
    { projectId: ws.filters.projectId, range: ws.filters.range, search: debounced, level },
    { refetchInterval: live ? 5000 : false },
  );
  return (
    <>
      <PageHeader
        title="Logs explorer"
        description="Every event has a story. Find the one you’re looking for."
      >
        <Button
          variant="secondary"
          onClick={() =>
            download(
              'pulse-logs.json',
              JSON.stringify(query.data?.entries || [], null, 2),
              'application/json',
            )
          }
        >
          <Download size={15} />
          Export logs
        </Button>
        <Button variant={live ? 'default' : 'secondary'} onClick={() => setLive(!live)}>
          <span className={live ? 'live-dot' : ''} />
          <Play size={14} />
          {live ? 'Live refresh on' : 'Live refresh'}
        </Button>
      </PageHeader>
      <Card className="explorer-card">
        <ExplorerControls search={search} setSearch={setSearch} level={level} setLevel={setLevel} />
        <div className="explorer-result-header">
          <span>
            <ScrollText size={15} />
            {query.data?.entries?.length || 0} log entries
          </span>
          <span>Newest first · {query.data?.source === 'demo' ? 'Sample data' : 'Loki'}</span>
        </div>
        <QueryState query={query}>
          {(data) =>
            data.entries.length ? (
              <div className="log-list">
                <div className="log-head">
                  <span>TIME</span>
                  <span>LEVEL</span>
                  <span>SERVICE / MESSAGE</span>
                </div>
                {data.entries.map((log) => (
                  <button
                    key={log.id}
                    className={`log-line log-${log.level}`}
                    onClick={() => setSelected(log)}
                  >
                    <time>
                      {new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}
                      <small>
                        {new Date(log.timestamp).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </small>
                    </time>
                    <span className={`log-level ${log.level}`}>{log.level.toUpperCase()}</span>
                    <div>
                      <span className="log-service">{log.service || 'unknown-service'}</span>
                      <span>{log.message}</span>
                    </div>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                title="No matching logs"
                description="Change your search or connect an OTLP log source."
              />
            )
          }
        </QueryState>
        <div className="explorer-bottom">
          <span>
            <span className="keyboard-key">↵</span> Click an entry to inspect its attributes
          </span>
          <span>Up to 200 entries per query</span>
        </div>
      </Card>
      <Modal
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        title="Log details"
        description={selected ? formatDate(selected.timestamp) : ''}
        wide
      >
        {selected && (
          <>
            <div className="detail-summary">
              <Badge status={selected.level} />
              <span className="environment-tag">{selected.service}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copy(JSON.stringify(selected, null, 2), ws.notify)}
              >
                <Copy size={14} />
                Copy JSON
              </Button>
            </div>
            <pre className="log-message">{selected.message}</pre>
            <h3>Attributes</h3>
            <div className="attribute-list">
              {Object.entries(selected.attributes || {}).map(([k, v]) => (
                <div key={k}>
                  <code>{k}</code>
                  <span>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
export function TracesPage() {
  const ws = useWorkspace(),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState(null);
  const query = useApi('/query/traces', {
    projectId: ws.filters.projectId,
    range: ws.filters.range,
  });
  const detail = useApi(
    `/traces/${selected?.traceId || 'none'}`,
    { projectId: selected?.projectId || ws.filters.projectId || ws.projects[0]?.id },
    { enabled: !!selected },
  );
  const rows = (query.data?.traces || []).filter((t) =>
    `${t.service} ${t.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        title="Trace explorer"
        description="Follow every request. Find where the time goes."
      >
        <Button
          variant="secondary"
          onClick={() =>
            download('pulse-traces.json', JSON.stringify(rows, null, 2), 'application/json')
          }
        >
          <Download size={15} />
          Export traces
        </Button>
      </PageHeader>
      <Card>
        <ExplorerControls search={search} setSearch={setSearch} />
        <div className="explorer-result-header">
          <span>
            <Route size={15} />
            {rows.length} traces found
          </span>
          <span>{query.data?.source === 'demo' ? 'Sample data' : 'Tempo'}</span>
        </div>
        <QueryState query={query}>
          <DataTable
            rows={rows}
            onRowClick={setSelected}
            emptyTitle="No traces found"
            emptyDescription="Instrument an application with OpenTelemetry to follow its requests."
            columns={[
              {
                key: 'name',
                label: 'Operation',
                render: (t) => (
                  <div className="trace-operation">
                    <Route size={17} />
                    <div>
                      <strong>{t.name || 'Unnamed operation'}</strong>
                      <code>{t.traceId.slice(0, 16)}…</code>
                    </div>
                  </div>
                ),
              },
              {
                key: 'service',
                label: 'Root service',
                render: (t) => <span className="service-chip">{t.service}</span>,
              },
              {
                key: 'durationMs',
                label: 'Duration',
                render: (t) => (
                  <div className="duration-cell">
                    <strong>{t.durationMs} ms</strong>
                    <div>
                      <span style={{ width: `${Math.min(100, t.durationMs / 4)}%` }} />
                    </div>
                  </div>
                ),
              },
              { key: 'spans', label: 'Spans' },
              { key: 'status', label: 'Status', render: (t) => <Badge status={t.status} /> },
              { key: 'timestamp', label: 'Started', render: (t) => formatDate(t.timestamp) },
            ]}
          />
        </QueryState>
      </Card>
      <Modal
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        title={selected?.name || 'Trace details'}
        description="A request’s journey through your services."
        wide
      >
        {selected && (
          <>
            <div className="detail-summary">
              <Badge status={selected.status} />
              <strong>{selected.durationMs} ms</strong>
              <code>{selected.traceId}</code>
            </div>
            <QueryState query={detail}>
              {(data) =>
                data.source === 'demo' ? (
                  <>
                    <div className="waterfall-header">
                      <span>SERVICE / OPERATION</span>
                      <span>SPAN TIMELINE</span>
                    </div>
                    {data.spans.map((s, i) => (
                      <div className="waterfall-row" key={s.id}>
                        <span style={{ paddingLeft: `${s.depth * 14}px` }}>
                          <i style={{ background: ['#8d74eb', '#4baba5', '#e3ac4e'][i % 3] }} />
                          {s.name}
                        </span>
                        <div>
                          <span
                            style={{
                              marginLeft: `${s.startPercent}%`,
                              width: `${s.widthPercent}%`,
                              background: ['#8d74eb', '#4baba5', '#e3ac4e'][i % 3],
                            }}
                          >
                            {s.durationMs} ms
                          </span>
                        </div>
                      </div>
                    ))}
                    <p className="muted text-sm">
                      Illustrative span waterfall from the demo dataset.
                    </p>
                  </>
                ) : (
                  <pre className="json-view">{JSON.stringify(data.trace, null, 2)}</pre>
                )
              }
            </QueryState>
          </>
        )}
      </Modal>
    </>
  );
}
