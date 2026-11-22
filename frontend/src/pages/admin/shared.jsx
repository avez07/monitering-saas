import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

export const formatCents = (cents) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format((cents || 0) / 100);

export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '-';

const PLAN_STYLE = {
  free: 'border-border text-muted-foreground',
  starter: 'border-chart-2/40 text-foreground',
  pro: 'border-primary/40 bg-primary/10 text-primary',
  business: 'border-chart-4/40 bg-chart-4/10 text-foreground',
};
export function PlanBadge({ planId, className }) {
  if (!planId) return <span className="text-muted-foreground">-</span>;
  return (
    <Badge variant="outline" className={cn('capitalize', PLAN_STYLE[planId], className)}>
      {planId}
    </Badge>
  );
}

/** Active / Suspended as a dot and a word (never colour alone). */
export function OrgStatus({ suspendedAt }) {
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-nowrap font-medium">
      <span
        className={cn('size-2 rounded-full', suspendedAt ? 'bg-destructive' : 'bg-emerald-500')}
        aria-hidden="true"
      />
      {suspendedAt ? 'Suspended' : 'Active'}
    </Badge>
  );
}

export function UserStatus({ disabledAt }) {
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-nowrap font-medium">
      <span
        className={cn('size-2 rounded-full', disabledAt ? 'bg-destructive' : 'bg-emerald-500')}
        aria-hidden="true"
      />
      {disabledAt ? 'Disabled' : 'Active'}
    </Badge>
  );
}

/** Search box that reports its value 300 ms after typing stops. */
export function SearchBox({ value, onChange, placeholder, label = 'Search' }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  useEffect(() => {
    if (text === (value ?? '')) return undefined;
    const id = setTimeout(() => onChange(text), 300);
    return () => clearTimeout(id);
  }, [text, value, onChange]);
  return (
    <div className="relative w-full sm:max-w-xs">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="pl-9"
      />
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total || 0, page * pageSize);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <p aria-live="polite">
        {total
          ? `${formatNumber(from)}-${formatNumber(to)} of ${formatNumber(total)}`
          : 'No results'}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-4" aria-hidden="true" /> Previous
        </Button>
        <span className="px-2 tabular-nums">
          Page {page} of {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

const ACTIONS = {
  'org.plan_changed': 'Plan changed',
  'org.plan_extended': 'Plan extended',
  'org.suspended': 'Organization suspended',
  'org.reactivated': 'Organization reactivated',
  'user.disabled': 'User disabled',
  'user.enabled': 'User enabled',
  'admin.granted': 'Staff access granted',
  'admin.revoked': 'Staff access removed',
};
export const actionLabel = (action) => ACTIONS[action] || action;

const show = (v) =>
  v === null || v === undefined
    ? '-'
    : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)
      ? formatDate(v)
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);

/** An audit row's details as short "key: value" pairs. */
export function AuditDetails({ details }) {
  const entries = Object.entries(details || {});
  if (!entries.length) return <span className="text-muted-foreground">-</span>;
  return (
    <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-1">
          <dt className="text-muted-foreground">{k}:</dt>
          <dd className="max-w-[18rem] truncate" title={show(v)}>
            {show(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
