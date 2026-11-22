import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { UserX, Users as UsersIcon } from 'lucide-react';
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  RelativeTime,
  TableSkeleton,
} from '@/components/app';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useSession } from '@/lib/session';
import { usePlatform, usePlatformAction } from './api';
import { formatDate, Pager, SearchBox, UserStatus } from './shared';

const PAGE_SIZE = 25;

/** Disable (with an optional reason) or enable one user, after a confirmation. */
function AccessDialog({ user, onClose }) {
  const action = usePlatformAction();
  const [reason, setReason] = useState('');
  const disabling = user && !user.disabledAt;
  const submit = async () => {
    try {
      await action.run(
        `/users/${user.id}/${disabling ? 'disable' : 'enable'}`,
        disabling && reason.trim() ? { reason: reason.trim() } : {},
      );
      setReason('');
      onClose();
    } catch {
      /* toasted */
    }
  };
  return (
    <Dialog open={Boolean(user)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {disabling ? `Disable ${user?.email}?` : `Enable ${user?.email}?`}
          </DialogTitle>
          <DialogDescription>
            {disabling
              ? 'They are signed out everywhere right now and cannot sign in until enabled again. Their organizations keep running.'
              : 'They can sign in again with their existing password.'}
          </DialogDescription>
        </DialogHeader>
        {disabling && (
          <div className="space-y-1.5">
            <Label htmlFor="disable-reason">Reason for the audit log (optional)</Label>
            <Textarea
              id="disable-reason"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={action.isPending}>
            Cancel
          </Button>
          <Button
            variant={disabling ? 'destructive' : 'default'}
            onClick={submit}
            disabled={action.isPending}
          >
            {action.isPending ? 'Working…' : disabling ? 'Disable user' : 'Enable user'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminUsers() {
  const { user: me } = useSession();
  const [params, setParams] = useSearchParams();
  const [target, setTarget] = useState(null);
  const filters = {
    q: params.get('q') || '',
    status: params.get('status') || '',
    page: Number(params.get('page')) || 1,
    pageSize: PAGE_SIZE,
  };
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
  const onSearch = useCallback((v) => set('q', v), [set]);
  const { data, isLoading, error, refetch } = usePlatform('/users', filters);

  const columns = [
    {
      key: 'name',
      header: 'User',
      cell: (u) => (
        <div className="min-w-0">
          <p className="truncate font-medium">
            {u.name}
            {u.isPlatformAdmin && (
              <span className="ml-2 text-xs font-semibold text-primary">Yukti staff</span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">{u.email}</p>
        </div>
      ),
    },
    {
      key: 'organizations',
      header: 'Organizations',
      cell: (u) =>
        u.organizations.length ? (
          <ul className="space-y-0.5 text-sm">
            {u.organizations.slice(0, 3).map((o) => (
              <li key={o.id}>
                <Link to={`/admin/orgs/${o.id}`} className="hover:underline">
                  {o.name}
                </Link>{' '}
                <span className="text-xs capitalize text-muted-foreground">
                  {o.role}
                  {o.suspendedAt ? ' · suspended' : ''}
                </span>
              </li>
            ))}
            {u.organizations.length > 3 && (
              <li className="text-xs text-muted-foreground">+{u.organizations.length - 3} more</li>
            )}
          </ul>
        ) : (
          <span className="text-muted-foreground">None</span>
        ),
    },
    { key: 'status', header: 'Status', cell: (u) => <UserStatus disabledAt={u.disabledAt} /> },
    {
      key: 'lastActiveAt',
      header: 'Last active',
      cell: (u) => <RelativeTime value={u.lastActiveAt} />,
    },
    { key: 'createdAt', header: 'Joined', cell: (u) => formatDate(u.createdAt) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'text-right',
      cell: (u) =>
        u.id === me?.id ? (
          <span className="text-xs text-muted-foreground">You</span>
        ) : (
          <Button
            size="sm"
            variant={u.disabledAt ? 'outline' : 'ghost'}
            onClick={() => setTarget(u)}
          >
            {u.disabledAt ? (
              'Enable'
            ) : (
              <>
                <UserX className="size-4" aria-hidden="true" /> Disable
              </>
            )}
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with a YuktiOps account. Disabling signs a user out everywhere."
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchBox
          value={filters.q}
          onChange={onSearch}
          placeholder="Search by name, email or id…"
          label="Search users"
        />
        <Select value={filters.status || 'all'} onValueChange={(v) => set('status', v)}>
          <SelectTrigger className="sm:w-44" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
            <SelectItem value="staff">Yukti staff</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isLoading ? (
        <TableSkeleton rows={8} />
      ) : error ? (
        <ErrorState title="Couldn't load users" error={error} onRetry={refetch} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={data.items}
            empty={
              <EmptyState
                icon={UsersIcon}
                title="No users match"
                text="Try another search or clear the filter."
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
      <AccessDialog user={target} onClose={() => setTarget(null)} />
    </>
  );
}
