import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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
import {
  createRule,
  updateRule,
  useAction,
  useContacts,
  useMetrics,
  useServerList,
  useWebsiteList,
} from './api';

/**
 * How each measurement reads in the sentence. `lead` and `t` surround the number,
 * `d` adds "for N minutes". Words like operator/threshold/severity never show in the UI.
 */
const WORDS = {
  offline: { label: 'A server stops reporting', lead: 'for more than', t: 'minutes' },
  cpu: { label: 'CPU use', lead: 'is above', t: '%', d: true },
  memory: { label: 'Memory used', lead: 'is above', t: '%', d: true },
  disk: { label: 'Disk space used', lead: 'is above', t: '%', d: true },
  website_down: { label: 'A website is down', d: true },
  website_slow: { label: 'A website is slow', lead: 'and takes more than', t: 'seconds', d: true },
  ssl_days: {
    label: 'An SSL certificate is close to expiring',
    lead: 'with',
    t: 'days or fewer left',
  },
  domain_days: {
    label: 'A domain name is close to expiring',
    lead: 'with',
    t: 'days or fewer left',
  },
  container_stopped: { label: 'A container has stopped', d: true },
  service_stopped: { label: 'A service has stopped', d: true },
};
const FALLBACK = { operator: 'gt', threshold: 1, durationMinutes: 5, severity: 'warning' };

function Pick({ value, onChange, options, label }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="inline-flex h-9 w-auto gap-2">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NumberBox({ value, onChange, label, max, min = 0, placeholder }) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={min}
      max={max}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="inline-flex h-9 w-20 px-2 text-center"
    />
  );
}

function CheckList({ title, items, selected, onChange, empty }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-2">
          <Checkbox
            id={`pick-${title}-${item.id}`}
            checked={selected.includes(item.id)}
            onCheckedChange={(on) =>
              onChange(on ? [...selected, item.id] : selected.filter((id) => id !== item.id))
            }
          />
          <Label htmlFor={`pick-${title}-${item.id}`} className="font-normal">
            {item.name}
          </Label>
        </div>
      ))}
    </fieldset>
  );
}

export default function RuleEditor({ rule, onClose }) {
  const metrics = useMetrics();
  const servers = useServerList();
  const websites = useWebsiteList();
  const contacts = useContacts();
  const action = useAction();
  const catalog = metrics.data?.items || [];
  const defaultsFor = (key) => catalog.find((m) => m.key === key)?.defaults || FALLBACK;

  const [form, setForm] = useState(() => ({
    name: rule?.name || '',
    metric: rule?.metric || 'disk',
    threshold: String(rule?.threshold ?? ''),
    duration: String(rule?.durationMinutes ?? ''),
    scopeType: rule?.scope?.type || 'all',
    scopeIds: rule?.scope?.ids || [],
    contactMode: rule?.contactIds?.length ? 'selected' : 'all',
    contactIds: rule?.contactIds || [],
    urgent: rule?.severity === 'critical',
    cooldown: String(rule?.cooldownMinutes ?? 30),
  }));
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const defaults = defaultsFor(form.metric);
  const words = WORDS[form.metric] || { label: form.metric };
  const kind = catalog.find((m) => m.key === form.metric)?.kind || rule?.kind || 'server';
  const noun = kind === 'website' ? 'websites' : 'servers';
  const resources = kind === 'website' ? websites.data?.items || [] : servers.data || [];
  const contactItems = contacts.data?.items || [];
  const metricOptions = (catalog.length ? catalog.map((m) => m.key) : Object.keys(WORDS)).map(
    (key) => ({ value: key, label: WORDS[key]?.label || key }),
  );

  function changeMetric(metric) {
    set({ metric, threshold: '', duration: '', scopeType: 'all', scopeIds: [] });
  }

  function save(event) {
    event.preventDefault();
    setError('');
    const threshold = form.threshold === '' ? defaults.threshold : Number(form.threshold);
    const durationMinutes = form.duration === '' ? defaults.durationMinutes : Number(form.duration);
    if (!Number.isFinite(threshold) || threshold < 0)
      return setError('Enter a number for the limit.');
    if (!(durationMinutes >= 0 && durationMinutes <= 60))
      return setError('The number of minutes must be between 0 and 60.');
    if (form.scopeType === 'selected' && !form.scopeIds.length)
      return setError(`Pick at least one of your ${noun}, or choose "all ${noun}".`);
    if (form.contactMode === 'selected' && !form.contactIds.length)
      return setError('Pick where to send it, or choose "all my contacts".');
    const cooldown = Number(form.cooldown);
    const body = {
      name: form.name.trim() || words.label,
      metric: form.metric,
      operator: defaults.operator,
      threshold,
      durationMinutes,
      severity: form.urgent ? 'critical' : 'warning',
      cooldownMinutes: cooldown >= 1 && cooldown <= 1440 ? cooldown : 30,
      scope: { type: form.scopeType, ids: form.scopeType === 'selected' ? form.scopeIds : [] },
      contactIds: form.contactMode === 'selected' ? form.contactIds : [],
    };
    action.mutate(rule ? updateRule(rule.id, body) : createRule(body), {
      onSuccess: () => {
        notify.success(rule ? 'Alert saved' : 'Alert created');
        onClose();
      },
      onError: (e) => setError(e.message),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit alert' : 'New alert'}</DialogTitle>
          <DialogDescription>
            Fill in the sentence below. That is the whole alert.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-5">
          <FormField label="Name" hint="Optional. We use the situation if you leave it empty.">
            {(p) => (
              <Input
                {...p}
                value={form.name}
                maxLength={80}
                placeholder={words.label}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </FormField>

          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-3 rounded-lg border bg-muted/40 p-4 text-base leading-relaxed"
            role="group"
            aria-label="Alert sentence"
          >
            <span>Alert me when</span>
            <Pick
              label="What to watch"
              value={form.metric}
              onChange={changeMetric}
              options={metricOptions}
            />
            {words.lead && <span>{words.lead}</span>}
            {words.t && (
              <>
                <NumberBox
                  label={`Limit, in ${words.t}`}
                  placeholder={String(defaults.threshold)}
                  value={form.threshold}
                  onChange={(threshold) => set({ threshold })}
                />
                <span>{words.t}</span>
              </>
            )}
            {words.d && (
              <span className="inline-flex items-center gap-2">
                <span>for</span>
                <NumberBox
                  label="For how many minutes"
                  max={60}
                  placeholder={String(defaults.durationMinutes)}
                  value={form.duration}
                  onChange={(duration) => set({ duration })}
                />
                <span>minutes</span>
              </span>
            )}
            <span>on</span>
            <Pick
              label={`Which ${noun}`}
              value={form.scopeType}
              onChange={(scopeType) => set({ scopeType })}
              options={[
                { value: 'all', label: `all ${noun}` },
                { value: 'selected', label: `only some ${noun}` },
              ]}
            />
            <span>, and send it to</span>
            <Pick
              label="Where to send it"
              value={form.contactMode}
              onChange={(contactMode) => set({ contactMode })}
              options={[
                { value: 'all', label: 'all my contacts' },
                { value: 'selected', label: 'only some contacts' },
              ]}
            />
            <span>.</span>
          </div>
          <p className="-mt-3 text-sm text-muted-foreground">
            Leave a number empty and we use the usual value, shown in grey.
          </p>

          {form.scopeType === 'selected' && (
            <CheckList
              title={`Choose ${noun}`}
              items={resources}
              selected={form.scopeIds}
              onChange={(scopeIds) => set({ scopeIds })}
              empty={`You have no ${noun} yet.`}
            />
          )}
          {form.contactMode === 'selected' && (
            <CheckList
              title="Choose contacts"
              items={contactItems}
              selected={form.contactIds}
              onChange={(contactIds) => set({ contactIds })}
              empty="You have no contacts yet. Add one under “Where to send alerts”."
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Don't repeat the same alert for (minutes)"
              hint="Stops the same message arriving again and again."
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  value={form.cooldown}
                  onChange={(e) => set({ cooldown: e.target.value })}
                />
              )}
            </FormField>
            <div className="flex items-start gap-2 sm:pt-7">
              <Checkbox
                id="urgent"
                checked={form.urgent}
                onCheckedChange={(urgent) => set({ urgent: urgent === true })}
              />
              <Label htmlFor="urgent" className="font-normal leading-snug">
                Mark this as urgent in the message
              </Label>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={action.isPending || metrics.isLoading}>
              {action.isPending ? 'Saving…' : rule ? 'Save alert' : 'Create alert'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
