import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Hash, Mail, MessageSquare, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  RelativeTime,
  TableSkeleton,
  notify,
} from '@/components/app';
import { useSession } from '@/lib/session';
import {
  deleteContact,
  telegramLink,
  testContact,
  updateContact,
  useAction,
  useContacts,
} from './api';
import ContactDialog, { TYPES, WebhookHelp } from './ContactDialog';

const ICONS = {
  email: Mail,
  telegram: Send,
  slack: Hash,
  discord: MessageSquare,
  webhook: Webhook,
};

function ContactCard({ contact, canEdit, onEdit, onDelete, onLink }) {
  const action = useAction();
  const [result, setResult] = useState(null);
  const Icon = ICONS[contact.type] || Webhook;
  const pending = contact.status === 'pending';
  const typeLabel = TYPES.find((t) => t.type === contact.type)?.label || contact.type;

  function sendTest() {
    setResult(null);
    action.mutate(testContact(contact.id), {
      onSuccess: (r) => {
        setResult(r);
        if (r.ok) notify.success('Test message sent. Check your inbox or channel.');
      },
    });
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{contact.name}</h2>
                <Badge variant="secondary">{typeLabel}</Badge>
                <Badge variant="outline" className="gap-1.5">
                  <span
                    className={`size-2 rounded-full ${pending ? 'bg-chart-4' : 'bg-chart-2'}`}
                    aria-hidden="true"
                  />
                  {pending ? 'Waiting for you to connect' : 'Connected'}
                </Badge>
              </div>
              <p className="break-all text-sm text-muted-foreground">{contact.target}</p>
              {contact.lastTest?.at && (
                <p className="text-sm text-muted-foreground">
                  Last test {contact.lastTest.ok ? 'worked' : 'failed'}{' '}
                  <RelativeTime value={contact.lastTest.at} />
                  {!contact.lastTest.ok && contact.lastTest.error && `: ${contact.lastTest.error}`}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={contact.enabled}
              disabled={!canEdit || action.isPending}
              aria-label={`${contact.name} is ${contact.enabled ? 'on' : 'off'}`}
              onCheckedChange={(enabled) =>
                action.mutate(updateContact(contact.id, { enabled }), {
                  onSuccess: () => notify.success(enabled ? 'Switched on' : 'Switched off'),
                })
              }
            />
            <span className="w-8 text-sm text-muted-foreground" aria-hidden="true">
              {contact.enabled ? 'On' : 'Off'}
            </span>
          </div>
        </div>

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {pending ? (
              <Button size="sm" onClick={() => onLink(contact)}>
                Connect Telegram
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={sendTest} disabled={action.isPending}>
                {action.isPending ? 'Sending…' : 'Send test'}
                <span className="sr-only"> to {contact.name}</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => onEdit(contact)}>
              Edit<span className="sr-only"> {contact.name}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${contact.name}`}
              onClick={() => onDelete(contact)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        )}

        {result && (
          <p
            role="status"
            className={`rounded-md border p-3 text-sm ${result.ok ? '' : 'border-destructive/50 text-destructive'}`}
          >
            {result.ok
              ? 'The test message was delivered.'
              : `The test didn't go through: ${result.error || 'unknown reason'}`}
          </p>
        )}
        {contact.type === 'webhook' && <WebhookHelp compact />}
      </CardContent>
    </Card>
  );
}

export default function ContactsTab() {
  const { isAdmin } = useSession();
  const [dialog, setDialog] = useState(null); // { mode: 'add' } | { mode:'edit', contact } | { mode:'link', contact }
  const [removing, setRemoving] = useState(null);
  const contacts = useContacts({
    refetchInterval: (q) =>
      q.state.data?.items?.some((c) => c.status === 'pending') ? 3000 : false,
  });
  const action = useAction();

  if (contacts.isLoading) return <TableSkeleton rows={3} />;
  if (contacts.error) return <ErrorState error={contacts.error} onRetry={contacts.refetch} />;
  const { items, allowedTypes = [], telegram } = contacts.data;
  const restricted = TYPES.some((t) => !allowedTypes.includes(t.type));

  function relink(contact) {
    action.mutate(telegramLink(contact.id), {
      onSuccess: (link) => setDialog({ mode: 'link', contact, link: link.link || link }),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Alerts are sent to every contact below unless an alert is set to use only some of them.
          {restricted && (
            <>
              {' '}
              Your plan sends by Email and Telegram.{' '}
              <Link to="/settings/plan" className="font-medium text-foreground underline">
                Upgrade to add Slack, Discord or Webhook
              </Link>
              .
            </>
          )}
        </p>
        {isAdmin && (
          <Button onClick={() => setDialog({ mode: 'add' })}>
            <Plus className="size-4" aria-hidden="true" />
            Add a contact
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="Nowhere to send alerts yet"
          text="Add your email or Telegram and we will message you the moment something needs attention."
          action={
            isAdmin
              ? { label: 'Add a contact', onClick: () => setDialog({ mode: 'add' }) }
              : undefined
          }
        />
      ) : (
        <ul className="space-y-3">
          {items.map((contact) => (
            <li key={contact.id}>
              <ContactCard
                contact={contact}
                canEdit={isAdmin}
                onEdit={(c) => setDialog({ mode: 'edit', contact: c })}
                onDelete={setRemoving}
                onLink={relink}
              />
            </li>
          ))}
        </ul>
      )}

      {dialog && (
        <ContactDialog
          {...dialog}
          allowedTypes={allowedTypes}
          telegram={telegram}
          contacts={items}
          onClose={() => setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove “${removing?.name}”?`}
        description="Alerts will stop going here. Alerts that were only set to use this contact will go to all your other contacts."
        confirmLabel="Remove"
        destructive
        loading={action.isPending}
        onConfirm={() =>
          action.mutate(deleteContact(removing.id), {
            onSuccess: () => {
              setRemoving(null);
              notify.success('Contact removed');
            },
          })
        }
      />
    </div>
  );
}
