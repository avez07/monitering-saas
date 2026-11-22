import { Link, useSearchParams } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import { DataTable, EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/app';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDateTime } from '@/lib/format';
import { usePlatform } from './api';
import { actionLabel, AuditDetails, Pager } from './shared';

const PAGE_SIZE = 50;

const COLUMNS = [
  {
    key: 'createdAt',
    header: 'When',
    className: 'whitespace-nowrap',
    cell: (r) => formatDateTime(r.createdAt),
  },
  {
    key: 'action',
    header: 'Action',
    cell: (r) => <span className="font-medium">{actionLabel(r.action)}</span>,
  },
  {
    key: 'target',
    header: 'Target',
    cell: (r) =>
      r.targetType === 'organization' ? (
        <Link to={`/admin/orgs/${r.targetId}`} className="hover:underline">
          {r.targetLabel || r.targetId}
        </Link>
      ) : (
        <span>{r.targetLabel || r.targetId}</span>
      ),
  },
  { key: 'admin', header: 'By', cell: (r) => r.adminEmail || '-' },
  { key: 'details', header: 'Details', cell: (r) => <AuditDetails details={r.details} /> },
];

export default function AdminAudit() {
  const [params, setParams] = useSearchParams();
  const filters = {
    targetType: params.get('targetType') || undefined,
    page: Number(params.get('page')) || 1,
    pageSize: PAGE_SIZE,
  };
  const set = (key, value) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value && value !== 'all') next.set(key, value);
        else next.delete(key);
        if (key !== 'page') next.delete('page');
        return next;
      },
      { replace: true },
    );
  const { data, isLoading, error, refetch } = usePlatform('/audit', filters);
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change made through Yukti Admin or the admin CLI, newest first."
      />
      <div className="mb-4">
        <Select value={filters.targetType || 'all'} onValueChange={(v) => set('targetType', v)}>
          <SelectTrigger className="sm:w-48" aria-label="Target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All targets</SelectItem>
            <SelectItem value="organization">Organizations</SelectItem>
            <SelectItem value="user">Users</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isLoading ? (
        <TableSkeleton rows={10} />
      ) : error ? (
        <ErrorState title="Couldn't load the audit log" error={error} onRetry={refetch} />
      ) : (
        <>
          <DataTable
            columns={COLUMNS}
            rows={data.items}
            empty={
              <EmptyState
                icon={ScrollText}
                title="Nothing recorded yet"
                text="Plan changes, suspensions and user access changes appear here."
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
