import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import { CardSkeleton, ConfirmDialog, DataTable, ErrorState } from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cancelSubscription, getBilling, openPortal, startCheckout } from './billing-api';
import { useCall, useDo } from './api';
import BillingProfile from './BillingProfile';

/** Minor units (cents, paise) to a price. */
export const money = (minor, currency = 'USD') =>
  new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: minor % 100 ? 2 : 0,
  }).format(minor / 100);

/** A small group of mutually exclusive buttons. */
function Toggle({ label, value, onChange, options }) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-1 rounded-md bg-muted p-1">
      {options.map(([id, text]) => (
        <Button
          key={id}
          size="sm"
          variant={id === value ? 'default' : 'ghost'}
          aria-pressed={id === value}
          onClick={() => onChange(id)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

const days = (n) => (n >= 365 ? `${Math.round(n / 365)} year` : `${n} days`);

/** What a plan includes, as plain sentences. */
const features = (plan, currency) => [
  plan.extraServerUsdCents > 0
    ? `${plan.includedServers} servers included, then ${money(currency === 'INR' ? plan.extraServerInrPaise : plan.extraServerUsdCents, currency)} each`
    : `Up to ${plan.includedServers} servers`,
  `${plan.monitors} website checks, as often as every ${plan.minCheckIntervalSeconds >= 60 ? `${plan.minCheckIntervalSeconds / 60} min` : `${plan.minCheckIntervalSeconds} s`}`,
  `${plan.members} team member${plan.members === 1 ? '' : 's'}`,
  `${plan.alertRules} alert rules`,
  `${days(plan.retentionDays)} of history`,
];

function Usage({ label, used, limit, loading }) {
  const unlimited = !Number.isFinite(limit);
  const pct = unlimited || !limit ? 0 : Math.min(100, (used / limit) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {loading ? '…' : used}
          {unlimited ? ' (no limit)' : ` of ${limit}`}
          {!unlimited && !loading && used >= limit && (
            <span className="ml-2 font-medium text-foreground">Limit reached</span>
          )}
        </span>
      </div>
      <Progress value={pct} aria-label={`${label} used`} className="h-2" />
    </div>
  );
}

const count = (path) => () => api(path).then((rows) => (Array.isArray(rows) ? rows.length : 0));

export default function Plan() {
  const { role, plan: sessionPlan } = useSession();
  const [search] = useSearchParams();
  const returned = search.get('checkout'); // success | cancelled (from the payment page)
  const allowed = role === 'owner' || role === 'admin';
  const owner = role === 'owner';
  const billing = useCall(['billing'], getBilling, {
    enabled: allowed,
    // After paying, the plan changes when the provider's webhook arrives: look again for a while.
    refetchInterval: returned === 'success' ? 3000 : false,
  });
  const servers = useCall(['count', 'servers'], count('/servers'));
  const websites = useCall(['count', 'websites'], count('/websites'));
  const members = useCall(['count', 'members'], count('/members'), { enabled: allowed });
  const [interval, setInterval] = useState('monthly');
  const [currencyChoice, setCurrency] = useState(null);
  const [target, setTarget] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  const change = useDo(({ id, ...options }) => startCheckout(id, options), {
    success: (r) => {
      if (r?.scheduled)
        return `Your plan switches to Free on ${formatDateTime(r.effectiveAt)}. Until then you keep everything.`;
      if (r?.pending) return r.message || 'Plan change requested. It appears in a few seconds.';
      if (r?.switched) return 'You are now on the Free plan.';
      return '';
    },
  });
  const cancel = useDo(cancelSubscription, {
    success: 'Your plan will end at the end of the billing period.',
  });
  const portal = useDo(openPortal);

  if (allowed && billing.isPending) return <CardSkeleton />;
  if (allowed && billing.isError)
    return (
      <ErrorState
        title="We couldn't load billing"
        error={billing.error}
        onRetry={() => billing.refetch()}
      />
    );

  const data = billing.data;
  const plans = data?.plans?.slice().sort((a, b) => a.priceUsdCents - b.priceUsdCents) || [];
  const subscription = data?.subscription;
  const current = plans.find((p) => p.id === subscription?.planId) || sessionPlan;
  if (!current)
    return <ErrorState title="No plan found" error="Your subscription could not be read." />;
  const limitOf = (plan) => (plan.extraServerUsdCents > 0 ? Infinity : plan.includedServers);

  const providers = data?.providers || {};
  const paymentsReady = Object.values(providers).some((p) => p.configured);
  const currencies = ['USD', 'INR'].filter((c) =>
    Object.values(providers).some((p) => p.currency === c && p.configured),
  );
  const locked = subscription?.currency; // an active subscription fixes the currency
  const currency = locked || currencyChoice || currencies[0] || 'USD';
  const gstRate = data?.gst?.rate ?? 0.18;
  const priceOf = (p) => (currency === 'INR' ? p.priceInrPaise : p.priceUsdCents);
  const pastDue = subscription?.status === 'past_due';

  function choose(p) {
    // Free is a downgrade: confirm first. Paid plans go straight to checkout.
    if (p.priceUsdCents === 0 || subscription?.provider) setTarget(p);
    else go(p);
  }
  function go(p) {
    change.mutate(
      { id: p.id, interval, currency },
      {
        onSuccess: (r) => {
          setTarget(null);
          if (r?.url) window.location.assign(r.url);
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      {returned === 'success' && (
        <Alert role="status">
          <AlertTitle>Thank you</AlertTitle>
          <AlertDescription>
            Your payment went through. Your new plan appears here in a few seconds.
          </AlertDescription>
        </Alert>
      )}
      {returned === 'cancelled' && (
        <Alert role="status">
          <AlertDescription>Checkout was cancelled. Nothing was charged.</AlertDescription>
        </Alert>
      )}
      {pastDue && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Your last payment failed</AlertTitle>
          <AlertDescription>
            Please update your payment method
            {data?.graceDays ? `. After ${data.graceDays} days your account moves to Free` : ''}.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-lg">Your plan: {current.name}</CardTitle>
            {subscription?.status && (
              <Badge variant="secondary" className="capitalize">
                {subscription.status.replace('_', ' ')}
              </Badge>
            )}
          </div>
          {subscription?.periodEnd && current.priceUsdCents > 0 && (
            <CardDescription>
              {subscription.cancelAtPeriodEnd ? 'Ends on ' : 'Renews on '}
              {formatDateTime(subscription.periodEnd)}
              {subscription.cancelAtPeriodEnd && '. It will not renew.'}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <Usage
            label="Servers"
            used={servers.data ?? 0}
            limit={limitOf(current)}
            loading={servers.isPending}
          />
          <Usage
            label="Website checks"
            used={websites.data ?? 0}
            limit={current.monitors}
            loading={websites.isPending}
          />
          {allowed && (
            <Usage
              label="Team members"
              used={members.data ?? 0}
              limit={current.members}
              loading={members.isPending}
            />
          )}
          <p className="text-sm text-muted-foreground">
            History is kept for {days(current.retentionDays)}.
          </p>
          {owner && subscription?.provider === 'stripe' && (
            <Button
              variant="outline"
              disabled={portal.isPending}
              onClick={() => portal.mutate(undefined, { onSuccess: (r) => window.location.assign(r.url) })}
            >
              Manage card and invoices
            </Button>
          )}
        </CardContent>
      </Card>

      {!allowed ? (
        <Alert>
          <AlertDescription>Only owners and admins can see plans and billing.</AlertDescription>
        </Alert>
      ) : (
        <>
          <section aria-labelledby="plans-heading" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="plans-heading" className="text-lg font-semibold">
                Compare plans
              </h2>
              <div className="flex flex-wrap gap-2">
                {currencies.length > 1 && !locked && (
                  <Toggle label="Currency" value={currency} onChange={setCurrency} options={currencies.map((c) => [c, c])} />
                )}
                <Toggle
                  label="Billing period"
                  value={interval}
                  onChange={setInterval}
                  options={[
                    ['monthly', 'Monthly'],
                    ['annual', 'Yearly (2 months free)'],
                  ]}
                />
              </div>
            </div>
            {!owner && (
              <Alert>
                <AlertDescription>Only the owner can change the plan.</AlertDescription>
              </Alert>
            )}
            {owner && !paymentsReady && (
              <Alert>
                <AlertDescription>
                  Payments are not available yet, so plans cannot be changed right now.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {plans.map((p) => {
                const isCurrent = p.id === current.id;
                const price = priceOf(p) * (interval === 'annual' ? 10 : 1);
                return (
                  <Card key={p.id} className={isCurrent ? 'border-primary' : undefined}>
                    <CardHeader>
                      <CardTitle className="text-lg">{p.name}</CardTitle>
                      <CardDescription>
                        <span className="text-2xl font-semibold text-foreground">
                          {price === 0 ? 'Free' : money(price, currency)}
                        </span>
                        {price > 0 && (interval === 'annual' ? ' per year' : ' per month')}
                        {price > 0 && currency === 'INR' && (
                          <span className="block text-xs">
                            plus {Math.round(gstRate * 100)}% GST
                          </span>
                        )}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <ul className="space-y-2 text-sm">
                        {features(p, currency).map((f) => (
                          <li key={f} className="flex gap-2">
                            <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                            {f}
                          </li>
                        ))}
                      </ul>
                      {isCurrent ? (
                        <Badge variant="outline">Your current plan</Badge>
                      ) : (
                        <Button
                          variant="outline"
                          className="w-full"
                          disabled={!owner || (!paymentsReady && p.priceUsdCents > 0) || change.isPending}
                          onClick={() => choose(p)}
                        >
                          {p.priceUsdCents > current.priceUsdCents ? 'Upgrade' : 'Switch'} to{' '}
                          {p.name}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            {owner && !subscription?.cancelAtPeriodEnd && current.priceUsdCents > 0 && (
              <Button variant="ghost" onClick={() => setCancelling(true)}>
                Cancel my plan
              </Button>
            )}
          </section>

          {owner && <BillingProfile profile={data.profile} />}

          <section aria-labelledby="invoices-heading" className="space-y-3">
            <h2 id="invoices-heading" className="text-lg font-semibold">
              Invoices
            </h2>
            <DataTable
              rows={data.invoices || []}
              getKey={(r) => r.number}
              empty={<p className="text-sm text-muted-foreground">No invoices yet.</p>}
              columns={[
                { key: 'number', header: 'Number' },
                {
                  key: 'periodStart',
                  header: 'Period',
                  cell: (r) => `${formatDateTime(r.periodStart)} to ${formatDateTime(r.periodEnd)}`,
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  cell: (r) =>
                    `${money(r.amount, r.currency)}${r.tax ? ` (incl. ${money(r.tax, r.currency)} tax)` : ''}`,
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (r) => <span className="capitalize">{r.status}</span>,
                },
                {
                  key: 'url',
                  header: 'Invoice',
                  cell: (r) =>
                    r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-4"
                      >
                        View
                      </a>
                    ) : (
                      ''
                    ),
                },
              ]}
            />
          </section>
        </>
      )}

      <ConfirmDialog
        open={!!target}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`Switch to ${target?.name}?`}
        description={
          target &&
          (target.priceUsdCents === 0
            ? 'You keep your paid plan until the end of the period you paid for. After that your limits go down to the Free plan.'
            : 'Your plan changes with your payment provider. It can take a few seconds to show here.')
        }
        confirmLabel={`Switch to ${target?.name}`}
        loading={change.isPending}
        onConfirm={() => go(target)}
      />
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel your plan?"
        description="You keep everything until the end of the current period. After that your account moves to the Free plan."
        confirmLabel="Cancel plan"
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate(undefined, { onSuccess: () => setCancelling(false) })}
      />
    </div>
  );
}
