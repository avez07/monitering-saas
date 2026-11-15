import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField, notify } from '@/components/app';
import { INTERVALS, createWebsite, updateWebsite, useAction } from './api';

const KINDS = [
  { value: 'http', label: 'Web page', text: 'Is the page loading?' },
  { value: 'keyword', label: 'Page with a word', text: 'Is a word on the page (or gone)?' },
  { value: 'api', label: 'API check', text: 'Does the API answer correctly?' },
  { value: 'tcp', label: 'Port (TCP)', text: 'Is a service port open?' },
];

const headersToText = (headers) =>
  Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

function textToHeaders(text) {
  const headers = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0 && line.trim()) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

export default function WebsiteDialog({ site, limits, onClose }) {
  const editing = !!site;
  const action = useAction();
  const min = limits?.minIntervalSeconds || 60;
  const allowed = INTERVALS.filter((i) => i.seconds >= min);
  const [form, setForm] = useState(() => ({
    type: site?.type || 'http',
    name: site?.name || '',
    url: site?.type === 'tcp' ? '' : site?.target || '',
    host: site?.host || '',
    port: site?.port ? String(site.port) : '',
    keyword: site?.keyword || '',
    keywordMode: site?.keywordMode || 'present',
    method: site?.method || 'GET',
    headers: headersToText(site?.headers),
    body: '',
    expectedStatus: site?.expectedStatus ? String(site.expectedStatus) : '',
    jsonContains: site?.jsonContains || '',
    interval: String(
      site?.intervalSeconds ?? allowed.find((i) => i.seconds >= 300)?.seconds ?? min,
    ),
    failures: String(site?.failuresBeforeDown ?? 2),
  }));
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  function submit(event) {
    event.preventDefault();
    setError('');
    const f = form;
    const body = {
      name: f.name.trim() || (f.type === 'tcp' ? `${f.host}:${f.port}` : f.url.trim()),
      intervalSeconds: Number(f.interval),
      failuresBeforeDown: Number(f.failures),
    };
    if (!editing) body.type = f.type;
    if (f.type === 'tcp') {
      body.host = f.host.trim();
      body.port = Number(f.port);
    } else {
      body.url = f.url.trim();
    }
    if (f.type === 'keyword') {
      body.keyword = f.keyword;
      body.keywordMode = f.keywordMode;
    }
    if (f.type === 'api') {
      body.method = f.method;
      body.headers = textToHeaders(f.headers);
      if (f.body) body.body = f.body;
      if (f.expectedStatus) body.expectedStatus = Number(f.expectedStatus);
      body.jsonContains = f.jsonContains || null;
    }
    if (f.type === 'tcp' && !(Number(f.port) >= 1 && Number(f.port) <= 65535))
      return setError('Enter a port between 1 and 65535.');
    action.mutate(editing ? updateWebsite(site.id, body) : createWebsite(body), {
      onSuccess: () => {
        notify.success(editing ? 'Saved' : 'Added. The first check runs shortly.');
        onClose();
      },
      onError: (e) => setError(e.message),
    });
  }

  const upgradeNote = error && /upgrade|plan|limit/i.test(error);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${site.name}` : 'Add a website or API'}</DialogTitle>
          <DialogDescription>
            We check it from outside, so there is nothing to install on your hosting.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {!editing && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">What should we check?</legend>
              <RadioGroup
                value={form.type}
                onValueChange={(type) => set({ type })}
                className="grid gap-2 sm:grid-cols-2"
              >
                {KINDS.map((k) => (
                  <Label
                    key={k.value}
                    htmlFor={`kind-${k.value}`}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring hover:bg-accent"
                  >
                    <RadioGroupItem id={`kind-${k.value}`} value={k.value} className="mt-1" />
                    <span>
                      <span className="block font-medium">{k.label}</span>
                      <span className="block text-sm text-muted-foreground">{k.text}</span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          )}

          {form.type === 'tcp' ? (
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <FormField
                label="Server address"
                hint="A domain or public IP, for example db.example.com."
              >
                {(p) => (
                  <Input
                    {...p}
                    required
                    value={form.host}
                    onChange={(e) => set({ host: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label="Port">
                {(p) => (
                  <Input
                    {...p}
                    required
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={(e) => set({ port: e.target.value })}
                  />
                )}
              </FormField>
            </div>
          ) : (
            <FormField label="Address" hint="Starting with https:// or http://">
              {(p) => (
                <Input
                  {...p}
                  required
                  type="url"
                  placeholder="https://example.com"
                  value={form.url}
                  onChange={(e) => set({ url: e.target.value })}
                />
              )}
            </FormField>
          )}

          <FormField label="Name" hint="Optional. We use the address if you leave it empty.">
            {(p) => (
              <Input
                {...p}
                maxLength={80}
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </FormField>

          {form.type === 'keyword' && (
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <FormField label="Word or phrase on the page">
                {(p) => (
                  <Input
                    {...p}
                    required
                    maxLength={200}
                    value={form.keyword}
                    onChange={(e) => set({ keyword: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label="Alert me when it is">
                {(p) => (
                  <Select
                    value={form.keywordMode}
                    onValueChange={(keywordMode) => set({ keywordMode })}
                  >
                    <SelectTrigger id={p.id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="present">Missing</SelectItem>
                      <SelectItem value="absent">Found</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </div>
          )}

          {form.type === 'api' && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Request type">
                  {(p) => (
                    <Select value={form.method} onValueChange={(method) => set({ method })}>
                      <SelectTrigger id={p.id}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
                <FormField
                  label="Expected answer code"
                  hint="Empty means any success (200 to 299)."
                >
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      inputMode="numeric"
                      min={100}
                      max={599}
                      placeholder="200"
                      value={form.expectedStatus}
                      onChange={(e) => set({ expectedStatus: e.target.value })}
                    />
                  )}
                </FormField>
              </div>
              <FormField
                label="Headers"
                hint="One per line, like Authorization: Bearer abc. Saved values stay hidden."
              >
                {(p) => (
                  <Textarea
                    {...p}
                    rows={3}
                    className="font-mono text-sm"
                    value={form.headers}
                    onChange={(e) => set({ headers: e.target.value })}
                  />
                )}
              </FormField>
              {form.method !== 'GET' && form.method !== 'HEAD' && (
                <FormField
                  label="Request body"
                  hint={editing ? 'Leave empty to keep the saved body.' : undefined}
                >
                  {(p) => (
                    <Textarea
                      {...p}
                      rows={3}
                      maxLength={4096}
                      className="font-mono text-sm"
                      value={form.body}
                      onChange={(e) => set({ body: e.target.value })}
                    />
                  )}
                </FormField>
              )}
              <FormField
                label="Answer must contain (optional)"
                hint="A piece of text the answer has to include, like “ok”."
              >
                {(p) => (
                  <Input
                    {...p}
                    value={form.jsonContains}
                    onChange={(e) => set({ jsonContains: e.target.value })}
                  />
                )}
              </FormField>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Check it">
              {(p) => (
                <Select value={form.interval} onValueChange={(interval) => set({ interval })}>
                  <SelectTrigger id={p.id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allowed.map((i) => (
                      <SelectItem key={i.seconds} value={String(i.seconds)}>
                        {i.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField
              label="Say it is down after"
              hint="We re-check quickly first, so one hiccup does not alert you."
            >
              {(p) => (
                <Select value={form.failures} onValueChange={(failures) => set({ failures })}>
                  <SelectTrigger id={p.id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 5].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n} failed {n === 1 ? 'check' : 'checks'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>
          {min > 30 && (
            <p className="-mt-2 text-sm text-muted-foreground">
              Your plan checks as often as {INTERVALS.find((i) => i.seconds >= min)?.label}.{' '}
              <Link to="/settings/plan" className="font-medium text-foreground underline">
                Faster checks on paid plans
              </Link>
            </p>
          )}

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}{' '}
              {upgradeNote && (
                <Link to="/settings/plan" className="underline">
                  See plans
                </Link>
              )}
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={action.isPending}>
              {action.isPending ? 'Saving…' : editing ? 'Save' : 'Add and start checking'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
