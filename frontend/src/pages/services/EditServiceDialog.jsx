import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { FormField, notify } from '@/components/app';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import CredentialsSection from './CredentialsSection';
import { CREDENTIAL_KINDS, credentialsRefError } from './credentials-guide';

// Contract: PATCH /api/services/:id with a partial body (no `type`). Returns
// { id, status, source, type, kind, name, serverId, monitorId }; `id` can change for
// agent-config entries, so callers must use the returned id.
const URL_TYPES = ['nginx', 'apache'];
const PORT_TYPES = ['tcp', 'mysql', 'postgres', 'mssql', 'redis'];
const ADDRESS_TYPES = ['tcp', ...CREDENTIAL_KINDS];

export default function EditServiceDialog({ service, onClose, onSaved }) {
  const client = useQueryClient();
  // `kind` is the exact collector (`type` is a display group such as database); a port entry edits as tcp.
  const kind = String(service.kind || service.type || '').toLowerCase();
  const type = kind === 'port' ? 'tcp' : kind;
  const [form, setForm] = useState({
    name: service.name || '',
    url: service.url || service.target || '',
    address: service.address || '',
    port: service.port ? String(service.port) : '',
    unit: service.unit || '',
    processName: service.processName || '',
    credentialsRef: service.credentialsRef || '',
  });
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: (body) => api(`/services/${service.id}`, { method: 'PATCH', body }),
    onSuccess: async (row) => {
      await client.invalidateQueries();
      notify.success('Saved');
      onSaved(row?.id || service.id);
    },
    onError: (e) => setError(e.message),
  });

  function submit(event) {
    event.preventDefault();
    setError('');
    const name = form.name.trim();
    if (name.length < 1) return setError('Give the service a name.');
    const body = { name };
    if (URL_TYPES.includes(type) && form.url.trim()) body.url = form.url.trim();
    if (ADDRESS_TYPES.includes(type) && form.address.trim()) body.address = form.address.trim();
    if (PORT_TYPES.includes(type) && form.port) {
      const port = Number(form.port);
      if (!(port >= 1 && port <= 65535)) return setError('Enter a port between 1 and 65535.');
      body.port = port;
    }
    if (type === 'systemd' && form.unit.trim()) body.unit = form.unit.trim();
    if (type === 'process' && form.processName.trim()) body.processName = form.processName.trim();
    if (CREDENTIAL_KINDS.includes(type)) {
      const ref = form.credentialsRef.trim();
      const refError = credentialsRefError(ref);
      if (refError) return setError(refError);
      if (ref !== (service.credentialsRef || '')) body.credentialsRef = ref || null; // empty clears it
    }
    save.mutate(body);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {service.name}</DialogTitle>
          <DialogDescription>Change what we watch. The type cannot be changed.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField label="Name">
            {(p) => (
              <Input {...p} value={form.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
            )}
          </FormField>
          {URL_TYPES.includes(type) && (
            <FormField label="Status page address" hint="Starts with http:// or https://">
              {(p) => <Input {...p} type="url" value={form.url} onChange={(e) => set({ url: e.target.value })} />}
            </FormField>
          )}
          {ADDRESS_TYPES.includes(type) && (
            <FormField label="Address the agent connects to (optional)" hint="Leave empty for the host itself.">
              {(p) => <Input {...p} value={form.address} onChange={(e) => set({ address: e.target.value })} />}
            </FormField>
          )}
          {PORT_TYPES.includes(type) && (
            <FormField label="Port">
              {(p) => (
                <Input {...p} type="number" inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value })} />
              )}
            </FormField>
          )}
          {type === 'systemd' && (
            <FormField label="Unit name">
              {(p) => <Input {...p} value={form.unit} onChange={(e) => set({ unit: e.target.value })} />}
            </FormField>
          )}
          {type === 'process' && (
            <FormField label="Program name">
              {(p) => <Input {...p} value={form.processName} onChange={(e) => set({ processName: e.target.value })} />}
            </FormField>
          )}
          <CredentialsSection
            kind={type}
            value={form.credentialsRef}
            onChange={(credentialsRef) => set({ credentialsRef })}
          />
          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
