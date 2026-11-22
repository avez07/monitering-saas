import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ban, CreditCard, PlayCircle } from 'lucide-react';
import {
  ConfirmDialog,
  DataTable,
  notify,
  ErrorState,
  LoadingState,
  PageHeader,
  RelativeTime,
  StatusBadge,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { formatBytes, formatDateTime, formatNumber } from '@/lib/format';
import { usePlatform, usePlatformAction } from './api';
import {
  actionLabel,
  AuditDetails,
  formatCents,
  formatDate,
  OrgStatus,
  PlanBadge,
  UserStatus,
} from './shared';

const DAY = 86400000;
const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

// ---------------------------------------------------------------- dialogs

/** Change, comp or extend: pick a plan and an optional period end, review, then confirm. */
function ChangePlanDialog({ open, onOpenChange, org, subscription, plans }) {
  const action = usePlatformAction();
  const [planId, setPlanId] = useState(subscription?.planId ?? 'free');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [review, setReview] = useState(false);
  const reset = (next) => {
    if (!next) {
      setReview(false);
      setPlanId(subscription?.planId ?? 'free');
      setUntil('');
      setNote('');
    }
    onOpenChange(next);
  };
  const plan = plans.find((p) => p.id === planId);
  const same = planId === subscription?.planId;
  const tooEarly = until && new Date(`${until}T23:59:59Z`) <= new Date();
  const submit = async () => {
    try {
      const result = await action.run(`/orgs/${org.id}/plan`, {
        planId,
        ...(until ? { periodEnd: new Date(`${until}T23:59:59Z`).toISOString() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      // Staff may put an org above the new plan's limits; the change still applies.
      if (result?.warnings?.length)
        notify.info(`Above the new plan's limits: ${result.warnings.join(', ')}`);
      reset(false);
    } catch {
      /* toasted by useAction */
    }
  };
  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{review ? 'Confirm plan change' : 'Change plan'}</DialogTitle>
          <DialogDescription>
            {review
              ? 'This takes effect immediately and is recorded in the platform audit log.'
              : 'Change, comp or extend the subscription. No payment is taken; the payment provider is not contacted.'}
          </DialogDescription>
        </DialogHeader>
        {review ? (
          <dl className="space-y-2 rounded-xl border bg-muted/40 p-4 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Organization</dt>
              <dd className="font-medium">{org.name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Plan</dt>
              <dd className="font-medium">
                {same
                  ? `${plan?.name} (extend)`
                  : `${subscription?.planId ?? 'none'} → ${plan?.name}`}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Period ends</dt>
              <dd className="font-medium">
                {until
                  ? formatDate(`${until}T23:59:59Z`)
                  : planId === 'free'
                    ? 'Never (Free)'
                    : same
                      ? 'Unchanged'
                      : 'In 30 days'}
              </dd>
            </div>
            {note.trim() && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Note</dt>
                <dd className="max-w-[60%] text-right">{note.trim()}</dd>
              </div>
            )}
            {subscription?.provider && (
              <p className="pt-1 text-xs text-muted-foreground">
                This organization pays through {subscription.provider}. A later event from the
                provider can change the plan again.
              </p>
            )}
          </dl>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="plan-select">Plan</Label>
              <Select value={planId} onValueChange={setPlanId}>
                <SelectTrigger id="plan-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {formatCents(p.priceUsdCents)}/mo
                      {p.id === subscription?.planId ? ' (current)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-until">Period end (optional)</Label>
              <Input
                id="plan-until"
                type="date"
                min={isoDay(Date.now() + DAY)}
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                aria-invalid={Boolean(tooEarly)}
              />
              <p className="text-xs text-muted-foreground">
                {tooEarly
                  ? 'Pick a date in the future.'
                  : 'Leave empty: 30 days for a new paid plan, unchanged when extending the same plan.'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-note">Note for the audit log (optional)</Label>
              <Textarea
                id="plan-note"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Design partner, 3 months free"
              />
            </div>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          {review ? (
            <>
              <Button
                variant="outline"
                onClick={() => setReview(false)}
                disabled={action.isPending}
              >
                Back
              </Button>
              <Button onClick={submit} disabled={action.isPending}>
                {action.isPending ? 'Working…' : 'Confirm change'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => reset(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => setReview(true)}
                disabled={!plan || Boolean(tooEarly) || (same && !until)}
              >
                Review
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Suspend with a reason; the admin types the organization name to confirm. */
function SuspendDialog({ open, onOpenChange, org }) {
  const action = usePlatformAction();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const close = (next) => {
    if (!next) {
      setReason('');
      setTyped('');
    }
    onOpenChange(next);
  };
  const ready = reason.trim().length >= 3 && typed.trim() === org.name;
  const submit = async () => {
    try {
      await action.run(`/orgs/${org.id}/suspend`, { reason: reason.trim() });
      close(false);
    } catch {
      /* toasted */
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend {org.name}?</DialogTitle>
          <DialogDescription>
            Members see a suspended notice instead of the dashboard, agent reports are refused (HTTP
            403) and checks and alerts stop. Data is kept, and reactivating restores everything.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="suspend-reason">Reason (shown to the organization's members)</Label>
            <Textarea
              id="suspend-reason"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Unpaid invoices since March"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="suspend-confirm">
              Type <span className="font-semibold">{org.name}</span> to confirm
            </Label>
            <Input
              id="suspend-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => close(false)} disabled={action.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!ready || action.isPending}>
            {action.isPending ? 'Working…' : 'Suspend organization'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- tabs

function Fact({ label, children }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

function UsageRow({ label, used, limit }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const over = limit !== null && used > limit;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          <span
            className={over ? 'font-semibold text-destructive' : 'font-semibold text-foreground'}
          >
            {formatNumber(used)}
          </span>
          {' / '}
          {limit === null ? 'unlimited' : formatNumber(limit)}
          {over && ' · over limit'}
        </span>
      </div>
      {limit !== null && (
        <div className="h-2 rounded-full bg-muted">
          <div
            className={`h-2 rounded-full ${over ? 'bg-destructive' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Summary({ data }) {
  const { organization: org, subscription, plan, usage } = data;
  const t = usage.telemetry;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organization</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4">
            <Fact label="Status">
              <OrgStatus suspendedAt={org.suspendedAt} />
            </Fact>
            <Fact label="Created">{formatDate(org.createdAt)}</Fact>
            <Fact label="Slug">{org.slug}</Fact>
            <Fact label="Id">
              <code className="break-all text-xs">{org.id}</code>
            </Fact>
            {org.suspendedAt && (
              <>
                <Fact label="Suspended">{formatDateTime(org.suspendedAt)}</Fact>
                <Fact label="Reason">{org.suspendReason || '-'}</Fact>
              </>
            )}
            <Fact label="Plan">
              <PlanBadge planId={plan?.id} />
            </Fact>
            <Fact label="Subscription">
              {subscription ? `${subscription.status} · ${subscription.interval}` : 'none'}
            </Fact>
            <Fact label="Period ends">
              {plan?.id === 'free' ? '-' : formatDate(subscription?.periodEnd)}
            </Fact>
            <Fact label="Monthly value">{formatCents(data.monthlyCents)}</Fact>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <UsageRow label="Servers" {...usage.servers} />
          <UsageRow label="Website checks" {...usage.monitors} />
          <UsageRow label="Members" {...usage.members} />
          <UsageRow label="Alert rules" {...usage.alertRules} />
          {t ? (
            <UsageRow
              label={`Telemetry this month (${formatBytes(t.bytes)} of ${formatBytes(t.quotaBytes)})`}
              used={Math.round((t.bytes / t.quotaBytes) * 100)}
              limit={100}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Telemetry usage is unavailable (Redis unreachable).
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const MEMBER_COLUMNS = [
  {
    key: 'user',
    header: 'Member',
    cell: (m) => (
      <div>
        <p className="font-medium">
          {m.user.name}
          {m.user.isPlatformAdmin && <span className="ml-2 text-xs text-primary">Yukti staff</span>}
        </p>
        <p className="text-xs text-muted-foreground">{m.user.email}</p>
      </div>
    ),
  },
  { key: 'role', header: 'Role', className: 'capitalize' },
  { key: 'status', header: 'Status', cell: (m) => <UserStatus disabledAt={m.user.disabledAt} /> },
  {
    key: 'verified',
    header: 'Email',
    cell: (m) => (m.user.emailVerifiedAt ? 'Verified' : 'Not verified'),
  },
  { key: 'createdAt', header: 'Joined', cell: (m) => formatDate(m.createdAt) },
];

const AGENT_COLUMNS = [
  { key: 'name', header: 'Server', className: 'font-medium' },
  {
    key: 'status',
    header: 'Status',
    cell: (a) => (
      <StatusBadge status={a.status === 'revoked' ? 'unknown' : a.status} label={a.status} />
    ),
  },
  { key: 'os', header: 'System', cell: (a) => [a.os, a.arch].filter(Boolean).join(' · ') || '-' },
  { key: 'version', header: 'Agent', cell: (a) => a.version },
  { key: 'kind', header: 'Kind' },
  { key: 'lastSeen', header: 'Last seen', cell: (a) => <RelativeTime value={a.lastSeen} /> },
];

const MONITOR_COLUMNS = [
  {
    key: 'name',
    header: 'Check',
    cell: (m) => (
      <div className="min-w-0">
        <p className="truncate font-medium">{m.name}</p>
        <p className="max-w-[24rem] truncate text-xs text-muted-foreground">{m.target}</p>
      </div>
    ),
  },
  { key: 'type', header: 'Type', className: 'uppercase text-xs' },
  {
    key: 'status',
    header: 'Status',
    cell: (m) => (
      <StatusBadge
        status={m.enabled ? m.status : 'unknown'}
        label={m.enabled ? undefined : 'Paused'}
      />
    ),
  },
  { key: 'intervalSeconds', header: 'Every', cell: (m) => `${m.intervalSeconds}s` },
  {
    key: 'lastCheckedAt',
    header: 'Last check',
    cell: (m) => <RelativeTime value={m.lastCheckedAt} />,
  },
];

const INVOICE_COLUMNS = [
  { key: 'number', header: 'Invoice', className: 'font-mono text-xs' },
  {
    key: 'amount',
    header: 'Amount',
    className: 'tabular-nums',
    cell: (i) =>
      new Intl.NumberFormat(undefined, { style: 'currency', currency: i.currency }).format(
        i.amount / 100,
      ),
  },
  { key: 'status', header: 'Status', className: 'capitalize' },
  { key: 'provider', header: 'Provider' },
  {
    key: 'period',
    header: 'Period',
    cell: (i) => `${formatDate(i.periodStart)} – ${formatDate(i.periodEnd)}`,
  },
  { key: 'createdAt', header: 'Issued', cell: (i) => formatDate(i.createdAt) },
];

const PLATFORM_AUDIT_COLUMNS = [
  { key: 'createdAt', header: 'When', cell: (r) => formatDateTime(r.createdAt) },
  {
    key: 'action',
    header: 'Action',
    cell: (r) => <span className="font-medium">{actionLabel(r.action)}</span>,
  },
  { key: 'adminEmail', header: 'By' },
  { key: 'details', header: 'Details', cell: (r) => <AuditDetails details={r.details} /> },
];
const ORG_AUDIT_COLUMNS = [
  { key: 'createdAt', header: 'When', cell: (r) => formatDateTime(r.createdAt) },
  { key: 'action', header: 'Action', className: 'font-mono text-xs' },
  { key: 'userEmail', header: 'By' },
  { key: 'target', header: 'Target', className: 'max-w-[16rem] truncate' },
];

const Empty = ({ children }) => (
  <p className="rounded-2xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
    {children}
  </p>
);

// ---------------------------------------------------------------- page

export default function AdminOrgDetail() {
  const { id } = useParams();
  const { data, isLoading, error, refetch } = usePlatform(`/orgs/${id}`);
  const [dialog, setDialog] = useState(null); // 'plan' | 'suspend' | 'reactivate'
  const action = usePlatformAction();

  if (isLoading) return <LoadingState />;
  if (error)
    return <ErrorState title="Couldn't load this organization" error={error} onRetry={refetch} />;
  const org = data.organization;
  const reactivate = async () => {
    try {
      await action.run(`/orgs/${org.id}/reactivate`);
      setDialog(null);
    } catch {
      /* toasted */
    }
  };

  return (
    <>
      <PageHeader
        title={org.name}
        breadcrumbs={[{ label: 'Organizations', to: '/admin/orgs' }, { label: org.name }]}
        description={data.members.find((m) => m.role === 'owner')?.user.email}
        actions={
          <>
            <Button variant="outline" onClick={() => setDialog('plan')}>
              <CreditCard className="size-4" aria-hidden="true" /> Change plan
            </Button>
            {org.suspendedAt ? (
              <Button onClick={() => setDialog('reactivate')}>
                <PlayCircle className="size-4" aria-hidden="true" /> Reactivate
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => setDialog('suspend')}>
                <Ban className="size-4" aria-hidden="true" /> Suspend
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <PlanBadge planId={data.plan?.id} />
        <OrgStatus suspendedAt={org.suspendedAt} />
      </div>
      {org.suspendedAt && (
        <div
          role="status"
          className="mb-4 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
        >
          <span className="font-semibold">Suspended</span> since {formatDateTime(org.suspendedAt)}
          {org.suspendReason ? ` · ${org.suspendReason}` : ''}
        </div>
      )}
      <Tabs defaultValue="summary">
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="members">Members ({data.members.length})</TabsTrigger>
          <TabsTrigger value="servers">Servers ({data.agents.length})</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">
          <Summary data={data} />
        </TabsContent>
        <TabsContent value="members">
          <DataTable
            columns={MEMBER_COLUMNS}
            rows={data.members}
            empty={<Empty>No members.</Empty>}
          />
        </TabsContent>
        <TabsContent value="servers" className="space-y-6">
          <section aria-labelledby="agents-h">
            <h2 id="agents-h" className="mb-2 text-base font-semibold">
              Agents
            </h2>
            <DataTable
              columns={AGENT_COLUMNS}
              rows={data.agents}
              empty={<Empty>No servers connected.</Empty>}
            />
          </section>
          <section aria-labelledby="monitors-h">
            <h2 id="monitors-h" className="mb-2 text-base font-semibold">
              Website checks
            </h2>
            <DataTable
              columns={MONITOR_COLUMNS}
              rows={data.monitors}
              empty={<Empty>No website checks.</Empty>}
            />
          </section>
        </TabsContent>
        <TabsContent value="billing" className="space-y-6">
          <Card>
            <CardContent className="p-5">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Fact label="Plan">{data.plan?.name ?? '-'}</Fact>
                <Fact label="Status">{data.subscription?.status ?? '-'}</Fact>
                <Fact label="Provider">
                  {data.subscription?.provider ?? 'none (manual or comped)'}
                </Fact>
                <Fact label="Currency">{data.subscription?.currency ?? '-'}</Fact>
                <Fact label="Interval">{data.subscription?.interval ?? '-'}</Fact>
                <Fact label="Period ends">{formatDate(data.subscription?.periodEnd)}</Fact>
                <Fact label="Cancels at period end">
                  {data.subscription?.cancelAtPeriodEnd ? 'Yes' : 'No'}
                </Fact>
                <Fact label="Past due since">{formatDate(data.subscription?.pastDueSince)}</Fact>
              </dl>
            </CardContent>
          </Card>
          <section aria-labelledby="invoices-h">
            <h2 id="invoices-h" className="mb-2 text-base font-semibold">
              Invoices
            </h2>
            <DataTable
              columns={INVOICE_COLUMNS}
              rows={data.invoices}
              empty={<Empty>No invoices yet.</Empty>}
            />
          </section>
        </TabsContent>
        <TabsContent value="audit" className="space-y-6">
          <section aria-labelledby="paudit-h">
            <h2 id="paudit-h" className="mb-2 text-base font-semibold">
              Yukti staff actions
            </h2>
            <DataTable
              columns={PLATFORM_AUDIT_COLUMNS}
              rows={data.platformAudit}
              empty={<Empty>No staff actions on this organization.</Empty>}
            />
          </section>
          <section aria-labelledby="oaudit-h">
            <h2 id="oaudit-h" className="mb-2 text-base font-semibold">
              Organization activity (latest 50)
            </h2>
            <DataTable
              columns={ORG_AUDIT_COLUMNS}
              rows={data.audit}
              empty={<Empty>No activity recorded.</Empty>}
            />
          </section>
        </TabsContent>
      </Tabs>

      <ChangePlanDialog
        key={`${data.subscription?.planId}-${data.subscription?.periodEnd}`}
        open={dialog === 'plan'}
        onOpenChange={(o) => setDialog(o ? 'plan' : null)}
        org={org}
        subscription={data.subscription}
        plans={data.plans}
      />
      <SuspendDialog
        open={dialog === 'suspend'}
        onOpenChange={(o) => setDialog(o ? 'suspend' : null)}
        org={org}
      />
      <ConfirmDialog
        open={dialog === 'reactivate'}
        onOpenChange={(o) => setDialog(o ? 'reactivate' : null)}
        title={`Reactivate ${org.name}?`}
        description="Members get their dashboard back, agents can report again, and checks and alerts resume."
        confirmLabel="Reactivate"
        loading={action.isPending}
        onConfirm={reactivate}
      />
    </>
  );
}
