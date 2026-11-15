import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Hash, Loader2, Mail, MessageSquare, Send, Webhook, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CodeBlock, CopyField, FormField, notify } from '@/components/app';
import { createContact, rotateSecret, updateContact, useAction } from './api';

export const TYPES = [
  { type: 'email', label: 'Email', icon: Mail, text: 'A message to your inbox.' },
  { type: 'telegram', label: 'Telegram', icon: Send, text: 'One tap to connect our bot.' },
  { type: 'slack', label: 'Slack', icon: Hash, text: 'Post in a channel.' },
  { type: 'discord', label: 'Discord', icon: MessageSquare, text: 'Post in a channel.' },
  { type: 'webhook', label: 'Webhook', icon: Webhook, text: 'Send to your own system.' },
];

const VERIFY_CODE = `// Node.js: check the signature before you trust a request
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromYuktiOps(rawBody, headers, secret) {
  const timestamp = headers['x-yuktiops-timestamp'];
  const sent = headers['x-yuktiops-signature'];            // "sha256=<hex>"
  const expected =
    'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
  return sent.length === expected.length &&
    timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}`;

/** How to check the signature on a signed webhook. */
export function WebhookHelp({ compact }) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="link" size="sm" className="h-auto p-0">
          How to check our signature
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-3 text-sm">
        <p className="text-muted-foreground">
          Every message is signed so you know it really came from us. We send two headers:{' '}
          <code>X-YuktiOps-Timestamp</code> (seconds) and <code>X-YuktiOps-Signature</code>. The
          signature is <code>sha256=</code> plus an HMAC-SHA256 of the timestamp, a dot, and the raw
          body, using your secret. Reject messages with an old timestamp.
          {compact ? '' : ' Your secret is shown once, so save it now.'}
        </p>
        <CodeBlock code={VERIFY_CODE} label="signature check example" />
      </CollapsibleContent>
    </Collapsible>
  );
}

function SecretBox({ secret }) {
  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="font-medium">Your signing secret</p>
      <p className="text-sm text-muted-foreground">
        Copy it now. For safety we only show it this once.
      </p>
      <CopyField value={secret} label="signing secret" />
      <WebhookHelp />
    </div>
  );
}

function TelegramStep({ contact, link, live }) {
  const connected = live?.status === 'connected';
  return (
    <div className="space-y-4">
      {connected ? (
        <p role="status" className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-5 text-chart-2" aria-hidden="true" />
          Connected{live.target ? ` to ${live.target}` : ''}. You can close this.
        </p>
      ) : (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-base">
            <li>Press the button below. Telegram opens.</li>
            <li>
              Press <strong>Start</strong> in the chat with our bot.
            </li>
            <li>Come back here. This page updates by itself.</li>
          </ol>
          <Button asChild>
            <a href={link?.url} target="_blank" rel="noreferrer">
              Open Telegram
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Button>
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Waiting for you to press Start in Telegram… The link works for 15 minutes.
          </p>
        </>
      )}
      {contact?.name && (
        <p className="text-sm text-muted-foreground">Contact name: {contact.name}</p>
      )}
    </div>
  );
}

export default function ContactDialog({
  mode,
  contact,
  link,
  allowedTypes,
  telegram,
  contacts,
  onClose,
}) {
  const action = useAction();
  const [type, setType] = useState(mode === 'edit' ? contact.type : null);
  const [name, setName] = useState(mode === 'edit' ? contact.name : '');
  const [value, setValue] = useState(
    mode === 'edit' && contact.type === 'email' ? contact.target : '',
  );
  const [error, setError] = useState('');
  const [created, setCreated] = useState(mode === 'link' ? { contact, link } : null);
  const [secret, setSecret] = useState('');

  const live = created && contacts.find((c) => c.id === created.contact.id);
  const typeInfo = TYPES.find((t) => t.type === type);
  const needsValue = type && type !== 'telegram';
  const title =
    mode === 'edit'
      ? `Edit ${contact.name}`
      : created
        ? created.contact.type === 'telegram'
          ? 'Connect Telegram'
          : 'Contact added'
        : type
          ? `Add ${typeInfo.label}`
          : 'Where should alerts go?';

  const valueLabel = {
    email: 'Email address',
    slack: 'Slack incoming webhook URL',
    discord: 'Discord webhook URL',
    webhook: 'Your endpoint URL',
  }[type];
  const valuePlaceholder = {
    email: 'you@example.com',
    slack: 'https://hooks.slack.com/services/…',
    discord: 'https://discord.com/api/webhooks/…',
    webhook: 'https://example.com/alerts',
  }[type];

  function submit(event) {
    event.preventDefault();
    setError('');
    const label = name.trim() || typeInfo.label;
    if (mode === 'edit') {
      const body = { name: label };
      if (value && contact.type === 'email') body.address = value.trim();
      else if (value && needsValue) body.url = value.trim();
      return action.mutate(updateContact(contact.id, body), {
        onSuccess: () => {
          notify.success('Saved');
          onClose();
        },
        onError: (e) => setError(e.message),
      });
    }
    if (needsValue && !value.trim()) return setError(`Enter the ${valueLabel.toLowerCase()}.`);
    const body =
      type === 'email'
        ? { type, name: label, address: value.trim() }
        : type === 'telegram'
          ? { type, name: label }
          : { type, name: label, url: value.trim() };
    action.mutate(createContact(body), {
      onSuccess: (c) => {
        setCreated({ contact: c, link: c.link });
        if (c.secret) setSecret(c.secret);
        else if (type !== 'telegram') {
          notify.success('Contact added. Press "Send test" to try it.');
          onClose();
        }
      },
      onError: (e) => setError(e.message),
    });
  }

  function newSecret() {
    action.mutate(rotateSecret(contact.id), {
      onSuccess: (r) => setSecret(r.secret),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {created
              ? 'Follow the steps to finish.'
              : type
                ? typeInfo.text
                : 'Pick one. You can add more later.'}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            {created.contact.type === 'telegram' ? (
              <TelegramStep contact={created.contact} link={created.link} live={live} />
            ) : (
              <p role="status" className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="size-5 text-chart-2" aria-hidden="true" />
                {created.contact.name} is ready.
              </p>
            )}
            {secret && <SecretBox secret={secret} />}
            <DialogFooter>
              <Button onClick={onClose}>{secret ? "I've saved the secret" : 'Done'}</Button>
            </DialogFooter>
          </div>
        ) : !type ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {TYPES.map((t) => {
              const allowed = allowedTypes.includes(t.type);
              const unavailable = t.type === 'telegram' && telegram && !telegram.configured;
              return (
                <li key={t.type}>
                  <button
                    type="button"
                    disabled={!allowed || unavailable}
                    onClick={() => setType(t.type)}
                    className="flex h-full w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    <t.icon
                      className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="block font-medium">{t.label}</span>
                      <span className="block text-sm text-muted-foreground">
                        {!allowed
                          ? 'Not on your plan'
                          : unavailable
                            ? 'Not set up on this server yet'
                            : t.text}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {TYPES.some((t) => !allowedTypes.includes(t.type)) && (
              <li className="sm:col-span-2">
                <p className="text-sm text-muted-foreground">
                  Slack, Discord and Webhook need a paid plan.{' '}
                  <Link to="/settings/plan" className="font-medium text-foreground underline">
                    See plans
                  </Link>
                </p>
              </li>
            )}
          </ul>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <FormField label="Name" hint="So you can tell contacts apart, for example “My phone”.">
              {(p) => (
                <Input
                  {...p}
                  value={name}
                  maxLength={60}
                  placeholder={typeInfo.label}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </FormField>
            {needsValue && (
              <FormField
                label={valueLabel}
                hint={
                  mode === 'edit' && contact.type !== 'email'
                    ? 'Leave empty to keep the current address.'
                    : type === 'slack'
                      ? 'In Slack, add an “Incoming Webhook” app and copy its URL.'
                      : type === 'discord'
                        ? 'In Discord: Channel settings, Integrations, Webhooks, Copy URL.'
                        : type === 'webhook'
                          ? 'We send a signed message to this address. It must be public on the internet.'
                          : undefined
                }
              >
                {(p) => (
                  <Input
                    {...p}
                    type={type === 'email' ? 'email' : 'url'}
                    required={!(mode === 'edit' && type !== 'email')}
                    value={value}
                    placeholder={valuePlaceholder}
                    autoComplete="off"
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
              </FormField>
            )}
            {mode === 'edit' && type === 'webhook' && (
              <div className="space-y-2">
                {secret ? (
                  <SecretBox secret={secret} />
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={newSecret}
                    disabled={action.isPending}
                  >
                    Make a new signing secret
                  </Button>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            )}
            <DialogFooter className="gap-2 sm:gap-0">
              {mode === 'add' && (
                <Button type="button" variant="ghost" onClick={() => setType(null)}>
                  Back
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={action.isPending}>
                {action.isPending
                  ? 'Saving…'
                  : mode === 'edit'
                    ? 'Save'
                    : type === 'telegram'
                      ? 'Get the Telegram link'
                      : 'Add contact'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
