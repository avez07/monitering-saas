import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { cva } from 'class-variance-authority';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  LoaderCircle,
  Search,
  X,
  Inbox,
  AlertCircle,
} from 'lucide-react';

export const cn = (...inputs) => twMerge(clsx(inputs));
const buttonVariants = cva('button', {
  variants: {
    variant: {
      default: 'button-primary',
      secondary: 'button-secondary',
      ghost: 'button-ghost',
      danger: 'button-danger',
    },
    size: { default: '', sm: 'button-sm', icon: 'button-icon' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});
export function Button({ children, variant, size, className, loading, disabled, ...props }) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
export const Input = ({ className, ...props }) => (
  <input className={cn('input', className)} {...props} />
);
export const Select = ({ children, className, ...props }) => (
  <select className={cn('input select', className)} {...props}>
    {children}
  </select>
);
export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Badge({ children, status, className }) {
  const value = (status || String(children)).toLowerCase();
  const tone = [
    'healthy',
    'running',
    'active',
    'ok',
    'delivered',
    'resolved',
    'succeeded',
  ].includes(value)
    ? 'green'
    : ['warning', 'warn', 'pending', 'trialing', 'degraded', 'acknowledged', 'past_due'].includes(
          value,
        )
      ? 'amber'
      : [
            'critical',
            'error',
            'unhealthy',
            'firing',
            'offline',
            'stopped',
            'failed',
            'revoked',
            'cancelled',
          ].includes(value)
        ? 'red'
        : 'neutral';
  return (
    <span className={cn('badge', `badge-${tone}`, className)}>
      <i />
      {children || status}
    </span>
  );
}
export function Card({ children, className, ...props }) {
  return (
    <section className={cn('card', className)} {...props}>
      {children}
    </section>
  );
}
export function CardHeader({ title, subtitle, children }) {
  return (
    <div className="card-header">
      <div>
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
export function Empty({
  title = 'Nothing here yet',
  description = 'Connect your infrastructure to see data here.',
  action,
  icon: Icon = Inbox,
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={25} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={22} />
      <span>Loading workspace…</span>
    </div>
  );
}
export function ErrorState({ error, retry }) {
  return (
    <div className="error-state">
      <AlertCircle size={20} />
      <div>
        <strong>We couldn’t load this data</strong>
        <p>{error?.message}</p>
      </div>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
export function QueryState({ query, children }) {
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} retry={query.refetch} />;
  return typeof children === 'function' ? children(query.data) : children;
}
export function Modal({ open, onOpenChange, title, description, children, wide }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={cn('modal', wide && 'modal-wide')}>
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>
                {description || 'Manage your monitoring workspace.'}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close dialog">
                <X size={19} />
              </Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Progress({ value, className }) {
  return (
    <div className={cn('progress', className)}>
      <span
        style={{
          width: `${Math.min(100, Math.max(0, value || 0))}%`,
          background: value > 85 ? 'var(--amber)' : undefined,
        }}
      />
    </div>
  );
}
export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      role="switch"
      type="button"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn('toggle', checked && 'checked')}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
export function SearchInput({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className="search-input">
      <Search size={16} />
      <Input
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
export function Sparkline({ seed = 0, color = '#8c76ed' }) {
  const points = Array.from(
    { length: 24 },
    (_, i) => `${i * 4},${23 - (Math.sin(i * 0.8 + seed) * 6 + Math.sin(i * 0.3 + seed) * 8)}`,
  ).join(' ');
  return (
    <svg viewBox="0 0 92 45" className="sparkline" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function StatCard({ title, value, detail, icon: Icon, seed, tone = 'purple' }) {
  return (
    <Card className="stat-card">
      <div className="stat-top">
        <span>{title}</span>
        <span className={cn('stat-icon', tone)}>
          <Icon size={17} />
        </span>
      </div>
      <div className="stat-value">
        {value}
        <Sparkline
          seed={seed}
          color={tone === 'green' ? '#2bad84' : tone === 'blue' ? '#5693e3' : '#9177f0'}
        />
      </div>
      <div className="stat-detail">{detail}</div>
    </Card>
  );
}
export function MetricChart({ points = [], color = '#8b70ed', unit = '%', height = 220 }) {
  if (!points.length)
    return (
      <Empty
        title="Waiting for telemetry"
        description="Metrics will appear after the first collection interval."
      />
    );
  const gradientId = `gradient-${color.replace('#', '')}`;
  return (
    <div style={{ height, width: '100%', minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={points} margin={{ left: -23, right: 12, top: 12, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 4" vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t) =>
              new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }
            tick={{ fontSize: 10, fill: '#91929e' }}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#91929e' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v}${unit}`}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--card)',
              fontSize: 12,
            }}
            labelFormatter={(t) => new Date(t).toLocaleTimeString()}
            formatter={(v) => [`${Number(v).toFixed(2)}${unit}`, 'Value']}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
export function DataTable({
  columns,
  rows = [],
  onRowClick,
  emptyTitle,
  emptyDescription,
  pageSize = 10,
}) {
  const [sort, setSort] = useState({ key: '', direction: 1 });
  const [page, setPage] = useState(0);
  const sorted = [...rows].sort((a, b) => {
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return 0;
    const x = column.sortValue ? column.sortValue(a) : a[column.key],
      y = column.sortValue ? column.sortValue(b) : b[column.key];
    return (
      (typeof x === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) *
      sort.direction
    );
  });
  const maxPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1),
    currentPage = Math.min(page, maxPage);
  if (!rows.length) return <Empty title={emptyTitle} description={emptyDescription} />;
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>
                  {c.sortable === false ? (
                    c.label
                  ) : (
                    <button
                      className="sort-button"
                      onClick={() =>
                        setSort({ key: c.key, direction: sort.key === c.key ? -sort.direction : 1 })
                      }
                    >
                      {c.label}
                      {sort.key === c.key ? (
                        sort.direction === 1 ? (
                          <ArrowUp size={12} />
                        ) : (
                          <ArrowDown size={12} />
                        )
                      ) : (
                        <ChevronsUpDown size={12} />
                      )}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((row) => (
              <tr
                key={row.id || row.traceId}
                className={onRowClick ? 'clickable' : ''}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={() => onRowClick?.(row)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onRowClick?.(row);
                }}
              >
                {columns.map((c) => (
                  <td key={c.key}>{c.render ? c.render(row) : (row[c.key] ?? '—')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-footer">
        <span>
          Showing {currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, rows.length)}{' '}
          of {rows.length} results
        </span>
        <div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous page"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={15} />
          </Button>
          <span>
            {currentPage + 1} / {maxPage + 1}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next page"
            disabled={currentPage >= maxPage}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>
    </>
  );
}
export function PageHeader({ title, description, children }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          className={cn('tab', value === t.value && 'active')}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count != null && <span>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
export async function copy(value, notify) {
  try {
    await navigator.clipboard.writeText(value);
    notify?.('Copied to clipboard.');
  } catch {
    notify?.('Copy is unavailable in this browser. Select and copy the text.', 'error');
  }
}
export function FormModal({
  open,
  onOpenChange,
  title,
  description,
  fields,
  onSubmit,
  loading,
  submitLabel = 'Save changes',
}) {
  async function submit(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    for (const f of fields) if (f.type === 'number') body[f.name] = Number(body[f.name]);
    try {
      await onSubmit(body);
      onOpenChange(false);
    } catch {
      /* The centralized action hook displays the error. */
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <form onSubmit={submit} className="form-stack">
        {fields.map((f) => (
          <Field key={f.name} label={f.label} hint={f.hint}>
            {f.options ? (
              <Select name={f.name} defaultValue={f.defaultValue} required={f.required !== false}>
                {f.options.map((o) => (
                  <option
                    key={typeof o === 'string' ? o : o.value}
                    value={typeof o === 'string' ? o : o.value}
                  >
                    {typeof o === 'string' ? o : o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                name={f.name}
                type={f.type || 'text'}
                required={f.required !== false}
                min={f.min}
                max={f.max}
                minLength={f.minLength}
                placeholder={f.placeholder}
                defaultValue={f.defaultValue}
                step={f.step || (f.type === 'number' ? 'any' : undefined)}
              />
            )}
          </Field>
        ))}
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
