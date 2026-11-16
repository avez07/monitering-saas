import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  CardSkeleton,
  ConfirmDialog,
  CopyField,
  ErrorState,
  MetricBar,
  RelativeTime,
} from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useSession } from '@/lib/session';
import {
  createTelemetryKey,
  getAppSettings,
  listTelemetryKeys,
  revokeTelemetryKey,
  saveAppSettings,
} from '@/pages/apps/api';
import { SelectField } from '@/pages/apps/shared';
import { SEVERITY_ORDER, formatBytesGb, percentToRatio } from '@/pages/apps/model';
import { useCall, useDo } from './api';

const PRESETS = [
  { value: 'email', label: 'Email addresses' },
  { value: 'credit_card', label: 'Card numbers' },
  { value: 'ipv4', label: 'IP addresses' },
  { value: 'jwt', label: 'JWT tokens' },
  { value: 'bearer', label: 'Bearer tokens' },
];
const ruleText = (r) =>
  r.type === 'attribute'
    ? `${r.action === 'drop' ? 'Remove' : 'Scramble (hash)'} the attribute "${r.key}"`
    : `${r.action === 'mask' ? 'Hide' : 'Scramble (hash)'} ${PRESETS.find((p) => p.value === r.preset)?.label.toLowerCase() ?? r.preset} found in text`;

function Keys({ isAdmin }) {
  const query = useCall(['telemetry-keys'], listTelemetryKeys);
  const [fresh, setFresh] = useState(null);
  const [name, setName] = useState('production');
  const [revoking, setRevoking] = useState(null);
  const create = useDo(() => createTelemetryKey(name.trim() || 'production'), {
    success: 'Telemetry key created.',
  });
  const revoke = useDo((id) => revokeTelemetryKey(id), { success: 'Key revoked.' });
  const keys = query.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Telemetry keys</CardTitle>
        <CardDescription>
          Keys your apps use to send traces and logs. They can only send data. Create one per
          environment, for example production and staging.{' '}
          <Link to="/apps/connect" className="underline underline-offset-4">
            How to connect an app
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {fresh && (
          <Alert role="status">
            <TriangleAlert className="size-4" aria-hidden="true" />
            <AlertTitle>Copy your new key now</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>This is the only time it is shown. If you lose it, create a new one.</p>
              <CopyField value={fresh} label="telemetry key" />
              <Button variant="outline" size="sm" onClick={() => setFresh(null)}>
                I have saved it
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {query.isPending ? (
          <CardSkeleton />
        ) : query.isError ? (
          <ErrorState title="We couldn't load your keys" error={query.error} onRetry={() => query.refetch()} />
        ) : keys.length === 0 ? (
          <p className="text-muted-foreground">
            You have no telemetry keys yet. Create one to start sending data from an app.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="font-medium">{k.name}</p>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-mono">{k.prefix}…</span> · last used{' '}
                    {k.lastSeenAt || k.lastUsedAt ? (
                      <RelativeTime value={k.lastSeenAt || k.lastUsedAt} />
                    ) : (
                      'never'
                    )}
                  </p>
                </div>
                {isAdmin && (
                  <Button variant="outline" size="sm" onClick={() => setRevoking(k)}>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Revoke<span className="sr-only"> {k.name}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin && (
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, { onSuccess: (r) => setFresh(r.key) });
            }}
          >
            <div className="space-y-1.5 sm:w-64">
              <Label htmlFor="tk-name">Key name</Label>
              <Input id="tk-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </div>
            <Button type="submit" disabled={create.isPending}>
              <KeyRound className="size-4" aria-hidden="true" />
              Create key
            </Button>
          </form>
        )}
      </CardContent>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke "${revoking?.name}"?`}
        description="Apps using this key stop sending data within seconds. Data already stored is kept."
        confirmLabel="Revoke key"
        destructive
        loading={revoke.isPending}
        onConfirm={() => revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
      />
    </Card>
  );
}

function Redaction({ settings, isAdmin, save, saving }) {
  const [rules, setRules] = useState(settings.redaction?.rules ?? []);
  const [kind, setKind] = useState('attribute');
  const [key, setKey] = useState('');
  const [preset, setPreset] = useState('email');
  const [action, setAction] = useState('drop');
  useEffect(() => setRules(settings.redaction?.rules ?? []), [settings]);

  const actionOptions =
    kind === 'attribute'
      ? [
          { value: 'drop', label: 'Remove it' },
          { value: 'hash', label: 'Scramble it (hash)' },
        ]
      : [
          { value: 'mask', label: 'Hide it' },
          { value: 'hash', label: 'Scramble it (hash)' },
        ];

  function add(e) {
    e.preventDefault();
    if (kind === 'attribute' && !key.trim()) return toast.error('Enter the attribute name first.');
    const a = actionOptions.some((o) => o.value === action) ? action : actionOptions[0].value;
    setRules([...rules, kind === 'attribute' ? { type: 'attribute', key: key.trim(), action: a } : { type: 'pattern', preset, action: a }]);
    setKey('');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Hide private data</CardTitle>
        <CardDescription>
          Rules run before anything is stored, so private values never reach your dashboard. Scrambled
          (hashed) values stay the same each time, so you can still match them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rules.length === 0 ? (
          <p className="text-muted-foreground">No rules yet. Add one below, for example remove the attribute http.request.header.authorization.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rules.map((r, i) => (
              <li key={r.id ?? i} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span className="min-w-0 break-words">{ruleText(r)}</span>
                {isAdmin && (
                  <Button variant="ghost" size="sm" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                    Remove<span className="sr-only"> rule {i + 1}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin && (
          <>
            <form onSubmit={add} className="grid gap-3 sm:grid-cols-4 sm:items-end">
              <SelectField
                id="rule-kind"
                label="Match"
                value={kind}
                onChange={(v) => {
                  setKind(v);
                  setAction(v === 'attribute' ? 'drop' : 'mask');
                }}
                options={[
                  { value: 'attribute', label: 'An attribute name' },
                  { value: 'pattern', label: 'A kind of value' },
                ]}
              />
              {kind === 'attribute' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="rule-key">Attribute name</Label>
                  <Input id="rule-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="http.request.header.*" />
                </div>
              ) : (
                <SelectField id="rule-preset" label="Value type" value={preset} onChange={setPreset} options={PRESETS} />
              )}
              <SelectField id="rule-action" label="Then" value={action} onChange={setAction} options={actionOptions} />
              <Button type="submit" variant="outline">
                <Plus className="size-4" aria-hidden="true" /> Add rule
              </Button>
            </form>
            <Button disabled={saving} onClick={() => save({ redaction: { rules } })}>
              Save rules
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Sampling({ settings, isAdmin, save, saving }) {
  const s = settings.sampling ?? {};
  const [pct, setPct] = useState(String(Math.round((s.tracesRatio ?? 1) * 100)));
  const [keepErrors, setKeepErrors] = useState(s.keepErrors !== false);
  const [slow, setSlow] = useState(s.keepSlowMs ?? '');
  const [sev, setSev] = useState(s.logsMinSeverity ?? 'trace');
  useEffect(() => {
    setPct(String(Math.round((settings.sampling?.tracesRatio ?? 1) * 100)));
    setKeepErrors(settings.sampling?.keepErrors !== false);
    setSlow(settings.sampling?.keepSlowMs ?? '');
    setSev(settings.sampling?.logsMinSeverity ?? 'trace');
  }, [settings]);

  function submit(e) {
    e.preventDefault();
    const ratio = percentToRatio(pct);
    if (ratio === null) return toast.error('Enter a number from 0 to 100.');
    const slowMs = slow === '' ? null : Number(slow);
    if (slowMs !== null && (!Number.isFinite(slowMs) || slowMs < 0)) return toast.error('Slow limit must be a number of milliseconds.');
    save({ sampling: { tracesRatio: ratio, keepErrors, keepSlowMs: slowMs, logsMinSeverity: sev } });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Keep less data (sampling)</CardTitle>
        <CardDescription>
          Save volume by keeping only part of your traces. Dropped data still counts toward your
          monthly volume because we received it. To save volume at the source, set a sampling ratio
          in your app instead.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-pct">Traces to keep (%)</Label>
            <Input id="s-pct" type="number" min="0" max="100" value={pct} onChange={(e) => setPct(e.target.value)} disabled={!isAdmin} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-slow">Always keep traces slower than (ms)</Label>
            <Input id="s-slow" type="number" min="0" value={slow} onChange={(e) => setSlow(e.target.value)} placeholder="Off" disabled={!isAdmin} />
          </div>
          <SelectField
            id="s-sev"
            label="Lowest log level to keep"
            value={sev}
            onChange={setSev}
            options={SEVERITY_ORDER.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))}
          />
          <div className="flex items-center gap-3 self-end pb-2">
            <Switch id="s-err" checked={keepErrors} onCheckedChange={setKeepErrors} disabled={!isAdmin} />
            <Label htmlFor="s-err">Always keep traces that failed</Label>
          </div>
          {isAdmin && (
            <div className="sm:col-span-2">
              <Button type="submit" disabled={saving}>
                Save sampling
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function Usage({ settings }) {
  const u = settings.usage;
  const r = settings.retention;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Usage and retention</CardTitle>
        <CardDescription>Traces, logs and metrics all count toward one monthly volume.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {u && (
          <>
            <MetricBar
              label="This month"
              value={u.percent}
              detail={`${formatBytesGb(u.bytes)} of ${formatBytesGb(u.limitBytes)} used. Resets ${new Date(u.resetsAt).toLocaleDateString()}.`}
            />
            <p className="text-sm text-muted-foreground">
              Traces {formatBytesGb(u.bySignal?.traces)} · Logs {formatBytesGb(u.bySignal?.logs)}. At
              100% new data is refused until the month rolls over or you upgrade.
            </p>
          </>
        )}
        {r && (
          <p className="text-base">
            Data is kept for <strong>{r.days} days</strong> on your {r.plan} plan.{' '}
            <Link to="/settings/plan" className="underline underline-offset-4">
              See plans
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Telemetry() {
  const { isAdmin } = useSession();
  const query = useCall(['apps-settings'], getAppSettings);
  const save = useDo((body) => saveAppSettings(body), { success: 'Saved.' });

  return (
    <div className="space-y-6">
      <Keys isAdmin={isAdmin} />
      {query.isPending ? (
        <CardSkeleton />
      ) : query.isError ? (
        <ErrorState
          title="We couldn't load telemetry settings"
          error={query.error?.status === 503 ? 'Telemetry storage is unavailable. Try again shortly.' : query.error}
          onRetry={() => query.refetch()}
        />
      ) : (
        <>
          <Usage settings={query.data} />
          <Redaction settings={query.data} isAdmin={isAdmin} save={(b) => save.mutate(b)} saving={save.isPending} />
          <Sampling settings={query.data} isAdmin={isAdmin} save={(b) => save.mutate(b)} saving={save.isPending} />
        </>
      )}
    </div>
  );
}
