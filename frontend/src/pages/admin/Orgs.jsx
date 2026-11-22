import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { DataTable, EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/app';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatNumber } from '@/lib/format';
import { usePlatform } from './api';
import { formatDate, OrgStatus, Pager, PlanBadge, SearchBox } from './shared';

const PAGE_SIZE = 25;
const PLANS = ['free', 'starter', 'pro', 'business'];

const COLUMNS = [
  {
    key: 'name',
    header: 'Organization',
    cell: (o) => (
      <div className="min-w-0">
        <p className="truncate font-medium">{o.name}</p>
        <p className="truncate text-xs text-muted-foreground">{o.owner?.email ?? o.slug}</p>
      </div>
    ),
  },
  { key: 'planId', header: 'Plan', cell: (o) => <PlanBadge planId={o.planId} /> },
  { key: 'status', header: 'Status', cell: (o) => <OrgStatus suspendedAt={o.suspendedAt} /> },
  {
    key: 'servers',
    header: 'Servers',
    className: 'tabular-nums',
    cell: (o) => formatNumber(o.servers),
  },
  {
    key: 'members',
    header: 'Members',
    className: 'tabular-nums',
    cell: (o) => formatNumber(o.members),
  },
  {
    key: 'periodEnd',
    header: 'Period ends',
    cell: (o) =>
      o.planId === 'free' ? (
        <span className="text-muted-foreground">-</span>
      ) : (
        formatDate(o.periodEnd)
      ),
  },
  { key: 'createdAt', header: 'Created', cell: (o) => formatDate(o.createdAt) },
];

/** Filter value in the URL, so a filtered list can be shared and survives a reload. */
function useFilters() {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (key, value) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value && value !== 'all') next.set(key, value);
          else next.delete(key);
          if (key !== 'page') next.delete('page');
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [params, set];
}

export default function AdminOrgs() {
  const navigate = useNavigate();
  const [params, set] = useFilters();
  const filters = {
    q: params.get('q') || '',
    plan: params.get('plan') || '',
    status: params.get('status') || '',
    page: Number(params.get('page')) || 1,
    pageSize: PAGE_SIZE,
  };
  const { data, isLoading, error, refetch } = usePlatform('/orgs', filters);
  const onSearch = useCallback((v) => set('q', v), [set]);

  return (
    <>
      <PageHeader
        title="Organizations"
        description="Search by name, slug, id or a member's email."
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchBox
          value={filters.q}
          onChange={onSearch}
          placeholder="Search organizations…"
          label="Search organizations"
        />
        <Select value={filters.plan || 'all'} onValueChange={(v) => set('plan', v)}>
          <SelectTrigger className="sm:w-40" aria-label="Plan">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plans</SelectItem>
            {PLANS.map((p) => (
              <SelectItem key={p} value={p} className="capitalize">
                {p[0].toUpperCase() + p.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.status || 'all'} onValueChange={(v) => set('status', v)}>
          <SelectTrigger className="sm:w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isLoading ? (
        <TableSkeleton rows={8} />
      ) : error ? (
        <ErrorState title="Couldn't load organizations" error={error} onRetry={refetch} />
      ) : (
        <>
          <DataTable
            columns={COLUMNS}
            rows={data.items}
            onRowClick={(o) => navigate(`/admin/orgs/${o.id}`)}
            empty={
              <EmptyState
                icon={Building2}
                title="No organizations match"
                text="Try another search or clear the filters."
              />
            }
          />
          <Pager
            page={filters.page}
            pageSize={PAGE_SIZE}
            total={data.total}
            onPage={(p) => set('page', String(p))}
          />
        </>
      )}
    </>
  );
}
