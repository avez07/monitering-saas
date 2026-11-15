import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MailPlus, Trash2, Users } from 'lucide-react';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormField,
  RelativeTime,
  TableSkeleton,
} from '@/components/app';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSession } from '@/lib/session';
import {
  cancelInvite,
  changeRole,
  inviteMember,
  listInvites,
  listMembers,
  removeMember,
  resendInvite,
  useCall,
  useDo,
} from './api';

export const ROLES = {
  owner: {
    label: 'Owner',
    text: 'Everything, including billing, deleting the organization and handing over ownership.',
  },
  admin: {
    label: 'Admin',
    text: 'Manages servers, websites, alerts and the team. Cannot change billing.',
  },
  viewer: { label: 'Viewer', text: 'Can look at everything but cannot change anything.' },
};

function RoleGuide() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What each role can do</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 sm:grid-cols-3">
          {Object.entries(ROLES).map(([key, { label, text }]) => (
            <div key={key}>
              <dt className="font-medium">{label}</dt>
              <dd className="text-sm text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function InviteForm() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [error, setError] = useState(null);
  const invite = useDo((body) => inviteMember(body), { success: 'Invitation sent.', quiet: true });

  function submit(event) {
    event.preventDefault();
    setError(null);
    invite.mutate(
      { email: email.trim(), role },
      {
        onSuccess: () => setEmail(''),
        onError: setError,
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Invite someone</CardTitle>
        <CardDescription>We email them a link that works for 7 days.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <FormField label="Email address" className="flex-1">
            {(p) => (
              <Input
                {...p}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label="Role" className="sm:w-40">
            {(p) => (
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id={p.id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          <Button type="submit" disabled={invite.isPending}>
            {invite.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <MailPlus className="size-4" aria-hidden="true" />
            )}
            Send invitation
          </Button>
        </form>
        <p className="mt-2 text-sm text-muted-foreground">{ROLES[role].text}</p>
        {error && (
          <Alert variant="destructive" role="alert" className="mt-4">
            <AlertDescription>
              {error.message}
              {error.status === 402 && (
                <>
                  {' '}
                  <Link to="/settings/plan" className="font-medium underline underline-offset-4">
                    See plans
                  </Link>
                </>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function MemberRow({ member, me, canChangeRoles, onRemove }) {
  const update = useDo(({ id, role }) => changeRole(id, role), { success: 'Role updated.' });
  const isOwner = member.role === 'owner';
  const isMe = member.userId === me?.id;
  const editable = !isOwner && !isMe && (canChangeRoles || member.role !== 'admin');
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {member.name}
          {isMe && <span className="ml-2 text-sm font-normal text-muted-foreground">(you)</span>}
        </p>
        <p className="truncate text-sm text-muted-foreground">{member.email}</p>
      </div>
      <div className="flex items-center gap-2">
        {editable ? (
          <Select
            value={member.role}
            onValueChange={(role) => update.mutate({ id: member.id, role })}
            disabled={update.isPending || (!canChangeRoles && member.role === 'admin')}
          >
            <SelectTrigger className="w-32" aria-label={`Role for ${member.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="viewer">Viewer</SelectItem>
              {canChangeRoles && <SelectItem value="admin">Admin</SelectItem>}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant={isOwner ? 'default' : 'secondary'}>
            {ROLES[member.role]?.label || member.role}
          </Badge>
        )}
        {editable && (
          <Button
            variant="outline"
            size="icon"
            aria-label={`Remove ${member.name}`}
            onClick={() => onRemove(member)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>
    </li>
  );
}

function InviteRow({ invite }) {
  const resend = useDo(() => resendInvite(invite.id), {
    success: 'Invitation sent again. The old link no longer works.',
  });
  const cancel = useDo(() => cancelInvite(invite.id), { success: 'Invitation cancelled.' });
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate font-medium">{invite.email}</p>
        <p className="text-sm text-muted-foreground">
          {ROLES[invite.role]?.label || invite.role} · sent{' '}
          <RelativeTime value={invite.createdAt} />
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
        >
          Resend
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          Cancel
        </Button>
      </div>
    </li>
  );
}

export default function Team() {
  const { role, user, isAdmin } = useSession();
  const members = useCall(['members'], listMembers, { enabled: isAdmin });
  const invites = useCall(['invites'], listInvites, { enabled: isAdmin });
  const [removing, setRemoving] = useState(null);
  const remove = useDo((member) => removeMember(member.id), { success: 'Member removed.' });

  if (!isAdmin)
    return (
      <div className="space-y-6">
        <Alert>
          <AlertDescription>
            You are a {ROLES[role]?.label || role}. Only owners and admins can see and manage the
            team. Ask an owner if you need a change.
          </AlertDescription>
        </Alert>
        <RoleGuide />
      </div>
    );

  const pending = (invites.data || []).filter((i) => i.status === 'pending');
  const canChangeRoles = role === 'owner';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Members</CardTitle>
          <CardDescription>People who can sign in to this organization.</CardDescription>
        </CardHeader>
        <CardContent>
          {members.isPending ? (
            <TableSkeleton rows={3} />
          ) : members.isError ? (
            <ErrorState
              title="We couldn't load the team"
              error={members.error}
              onRetry={() => members.refetch()}
            />
          ) : members.data.length === 0 ? (
            <EmptyState icon={Users} title="No members yet" />
          ) : (
            <ul className="divide-y">
              {members.data.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  me={user}
                  canChangeRoles={canChangeRoles}
                  onRemove={setRemoving}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <InviteForm />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pending invitations</CardTitle>
        </CardHeader>
        <CardContent>
          {invites.isPending ? (
            <TableSkeleton rows={1} />
          ) : invites.isError ? (
            <ErrorState
              title="We couldn't load invitations"
              error={invites.error}
              onRetry={() => invites.refetch()}
            />
          ) : pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invitations waiting.</p>
          ) : (
            <ul className="divide-y">
              {pending.map((i) => (
                <InviteRow key={i.id} invite={i} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <RoleGuide />

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name || 'this person'}?`}
        description="They lose access straight away. Their account is not deleted and they can be invited again."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate(removing, { onSuccess: () => setRemoving(null) })}
      />
    </div>
  );
}
