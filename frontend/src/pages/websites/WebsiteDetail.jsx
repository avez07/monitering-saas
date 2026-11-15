import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Activity, Clock, Pause, Pencil, Play, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartCard,
  ConfirmDialog,
  ErrorState,
  PageHeader,
  RelativeTime,
  StatCard,
  StatGridSkeleton,
  StatusBadge,
  TimeSeriesChart,
  notify,
} from '@/components/app';
import { useSession } from '@/lib/session';
import { formatDateTime, formatMs } from '@/lib/format';
import {
  TYPE_LABELS,
  checkWebsite,
  deleteWebsite,
  expiry,
  pauseWebsite,
  resumeWebsite,
  siteStatus,
  useAction,
  useChecks,
  useWebsite,
  useWebsites,
  useWebsiteIncidents,
} from './api';
import WebsiteDialog from './WebsiteDialog';

const RANGES = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

const ERRORS = {
  timeout: 'Took too long to answer',
  dns: 'Address not found',
  connection_refused: 'Connection refused',
  tls: 'Certificate problem',
  keyword_missing: 'The word was not on the page',
  keyword_found: 'The unwanted word was found',
  json_missing: 'The answer did not contain the expected text',
  blocked_address: 'Address is not allowed',
};
const errorText = (code) =>
  !code
    ? ''
    : ERRORS[code] || (code.startsWith('status_') ? `Answered with code ${code.slice(7)}` : code);

const pct = (v) => (v === null || v === undefined ? 'No data' : `${v}%`);

function Expiry({ label, info, icon: Icon, extra }) {
  const e = expiry(info);
  return (
    <StatCard
      label={label}
      value={<span className="text-2xl">{e.text}</span>}
      hint={
        info?.expiresAt
          ? `${extra ? extra + ' · ' : ''}Ends ${formatDateTime(info.expiresAt)}`
          : extra
      }
      icon={Icon}
    />
  );
}

export default function WebsiteDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useSession();
  const [range, setRange] = useState('24h');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const site = useWebsite(id, { refetchInterval: 30000 });
  const checks = useChecks(id, range, { refetchInterval: 60000 });
  const incidents = useWebsiteIncidents(id);
  const limits = useWebsites();
  const action = useAction();

  if (site.isLoading)
    return (
      <div>
        <PageHeader title="Loading…" />
        <StatGridSkeleton />
      </div>
    );
  if (site.error)
    return (
      <div>
        <PageHeader
          title="Website"
          breadcrumbs={[{ label: 'Websites & APIs', to: '/websites' }, { label: 'Not found' }]}
        />
        <ErrorState
          title={site.error.status === 404 ? "We can't find this website" : 'Something went wrong'}
          error={site.error}
          onRetry={site.refetch}
        />
      </div>
    );

  const s = site.data;
  const info = siteStatus(s);
  const paused = s.status === 'paused';
  const points = (checks.data?.points || []).map((p) => ({ t: p.time, ms: p.avgLatencyMs }));
  const target = s.type === 'tcp' ? `${s.host}:${s.port}` : s.target;

  function runCheck() {
    setCheckResult(null);
    action.mutate(checkWebsite(s.id), { onSuccess: setCheckResult });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={s.name}
        description={`${TYPE_LABELS[s.type]} · ${target} · checked ${INTERVAL_TEXT(s.intervalSeconds)}`}
        breadcrumbs={[{ label: 'Websites & APIs', to: '/websites' }, { label: s.name }]}
        actions={
          <>
            <StatusBadge status={info.status} label={info.label} className="px-3 py-1.5" />
            {isAdmin && (
              <>
                <Button variant="outline" onClick={runCheck} disabled={action.isPending || paused}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Check now
                </Button>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" aria-hidden="true" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate(paused ? resumeWebsite(s.id) : pauseWebsite(s.id), {
                      onSuccess: () =>
                        notify.success(
                          paused ? 'Checking again' : 'Paused. No alerts while paused.',
                        ),
                    })
                  }
                >
                  {paused ? (
                    <Play className="size-4" aria-hidden="true" />
                  ) : (
                    <Pause className="size-4" aria-hidden="true" />
                  )}
                  {paused ? 'Resume' : 'Pause'}
                </Button>
                <Button variant="outline" onClick={() => setDeleting(true)}>
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete
                </Button>
              </>
            )}
          </>
        }
      />

      {checkResult && (
        <p
          role="status"
          className={`rounded-md border p-3 text-sm ${checkResult.ok ? '' : 'border-destructive/50'}`}
        >
          {checkResult.ok
            ? `Check passed${checkResult.statusCode ? ` (code ${checkResult.statusCode})` : ''}, answered in ${formatMs(checkResult.latencyMs)}.`
            : `Check failed: ${errorText(checkResult.error) || 'no answer'}.`}
        </p>
      )}
      {s.status === 'down' && s.lastError && (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm">
          Down
          {s.downSince ? (
            <>
              {' '}
              since <RelativeTime value={s.downSince} />
            </>
          ) : (
            ''
          )}
          . Last problem: {errorText(s.lastError)}.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Uptime, last 24 hours"
          value={pct(s.uptime?.['24h'] ?? s.uptime24h)}
          icon={Activity}
          hint={`7 days: ${pct(s.uptime?.['7d'])} · 30 days: ${pct(s.uptime?.['30d'])}`}
        />
        <StatCard
          label="Response time"
          value={s.latencyMs == null ? '–' : formatMs(s.latencyMs)}
          icon={Clock}
          hint={
            s.lastCheckedAt ? (
              <>
                Checked <RelativeTime value={s.lastCheckedAt} />
              </>
            ) : (
              'Not checked yet'
            )
          }
        />
        {s.type === 'tcp' ? null : (
          <Expiry label="SSL certificate" info={s.ssl} icon={ShieldCheck} />
        )}
        <Expiry
          label="Domain name"
          info={s.domain}
          icon={ShieldCheck}
          extra={
            s.domain?.status === 'unsupported' ? 'This domain ending cannot be checked' : undefined
          }
        />
      </div>

      <ChartCard
        title="Response time"
        description="How fast your site answers our checks."
        loading={checks.isLoading}
        error={checks.error}
        onRetry={checks.refetch}
        empty={
          points.every((p) => p.ms == null) ? (
            <p className="py-12 text-center text-muted-foreground">
              No successful checks in this time range yet, so there is nothing to draw.
            </p>
          ) : null
        }
        actions={
          <div role="group" aria-label="Time range" className="flex flex-wrap gap-1">
            {RANGES.map((r) => (
              <Button
                key={r.value}
                size="sm"
                variant={range === r.value ? 'default' : 'outline'}
                aria-pressed={range === r.value}
                onClick={() => setRange(r.value)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        }
      >
        <TimeSeriesChart
          data={points}
          series={[{ key: 'ms', label: 'Response time' }]}
          format={formatMs}
        />
        {checks.data && (
          <p className="mt-2 text-sm text-muted-foreground">
            Uptime in this range: {pct(checks.data.uptimePercent)} · average answer time:{' '}
            {checks.data.avgLatencyMs == null ? '–' : formatMs(checks.data.avgLatencyMs)} ·{' '}
            {checks.data.checks} checks
          </p>
        )}
      </ChartCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent checks</CardTitle>
          </CardHeader>
          <CardContent>
            {checks.data?.recent?.length ? (
              <ul className="divide-y">
                {checks.data.recent.map((c) => (
                  <li
                    key={c.time}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <StatusBadge
                        status={c.ok ? 'healthy' : 'unhealthy'}
                        label={c.ok ? 'Passed' : 'Failed'}
                      />
                      <span className="text-muted-foreground">
                        {c.ok
                          ? c.statusCode
                            ? `Code ${c.statusCode}`
                            : 'Connected'
                          : errorText(c.error)}
                      </span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {c.latencyMs == null ? '' : `${formatMs(c.latencyMs)} · `}
                      <RelativeTime value={c.time} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No checks yet. The first one runs shortly.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Problems we told you about</CardTitle>
          </CardHeader>
          <CardContent>
            {incidents.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : incidents.error ? (
              <ErrorState error={incidents.error} onRetry={incidents.refetch} />
            ) : incidents.data.items.length ? (
              <ul className="divide-y">
                {incidents.data.items.map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <StatusBadge
                        status={
                          i.state === 'resolved'
                            ? 'healthy'
                            : i.state === 'firing'
                              ? 'unhealthy'
                              : 'warning'
                        }
                        label={
                          i.state === 'resolved'
                            ? 'Resolved'
                            : i.state === 'firing'
                              ? 'Open'
                              : 'Seen, still open'
                        }
                      />
                      {i.ruleName}
                    </span>
                    <span className="text-muted-foreground">
                      <RelativeTime value={i.startedAt} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No problems so far.{' '}
                <Link to="/alerts" className="underline">
                  Manage alerts
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {editing && (
        <WebsiteDialog site={s} limits={limits.data?.limits} onClose={() => setEditing(false)} />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${s.name}”?`}
        description="We stop checking it and its history is removed. This cannot be undone."
        confirmLabel="Delete website"
        destructive
        loading={action.isPending}
        onConfirm={() =>
          action.mutate(deleteWebsite(s.id), {
            onSuccess: () => {
              notify.success('Website deleted');
              navigate('/websites');
            },
          })
        }
      />
    </div>
  );
}

function INTERVAL_TEXT(seconds) {
  if (seconds < 60) return `every ${seconds} seconds`;
  if (seconds === 60) return 'every minute';
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} minutes`;
  return seconds === 3600 ? 'every hour' : `every ${Math.round(seconds / 3600)} hours`;
}
