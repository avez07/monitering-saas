import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { FormField } from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import InstallAgentDialog from './InstallAgentDialog';

// Contract: docs/api/phase16.md (POST /api/services).
export const SERVICE_TYPES = [
  { id: 'website', label: 'Website', text: 'A web page. We check it from outside.', external: true },
  { id: 'api', label: 'API', text: 'An API address. We check it from outside.', external: true },
  { id: 'tcp', label: 'TCP port', text: 'Is a port open? Public address or on one of your hosts.' },
  { id: 'nginx', label: 'nginx', text: 'The nginx status page on a host.' },
  { id: 'apache', label: 'Apache', text: 'The Apache status page on a host.' },
  { id: 'mysql', label: 'MySQL', text: 'Does MySQL answer on a host?' },
  { id: 'postgres', label: 'PostgreSQL', text: 'Does PostgreSQL answer on a host?' },
  { id: 'redis', label: 'Redis', text: 'Does Redis answer on a host?' },
  { id: 'systemd', label: 'System service', text: 'A systemd unit such as nginx or cron.' },
  { id: 'process', label: 'Program', text: 'A program by its process name.' },
];
const PUBLIC = '__public__';
const INSTALL = '__install__';
const DEFAULT_PORT = { mysql: 3306, postgres: 5432, redis: 6379 };

function Waiting({ created, onClose }) {
  const [tries, setTries] = useState(0);
  const list = useApi('/services', {}, { refetchInterval: 4000 });
  const items = Array.isArray(list.data) ? list.data : (list.data?.items ?? []);
  const seen = items.find((s) => s.id === created.id || (s.name === created.name && (s.serverId ?? null) === (created.serverId ?? null)));
  useEffect(() => {
    const id = setInterval(() => setTries((t) => t + 1), 4000);
    return () => clearInterval(id);
  }, []);
  const monitor = created.source === 'monitor';
  return (
    <div className="space-y-4" role="status">
      {seen ? (
        <Alert>
          <AlertTitle>First result is in</AlertTitle>
          <AlertDescription>
            {created.name} is {seen.state}.{' '}
            <Link to={`/services/${seen.id}`} className="underline underline-offset-4">
              Open it
            </Link>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          <AlertTitle>Waiting for first result…</AlertTitle>
          <AlertDescription>
            {monitor
              ? 'The first check runs in a few seconds.'
              : 'The agent picks up the new service on its next settings check, usually within a minute.'}
            {tries > 20 && ' This is taking longer than usual. You can close this window, it keeps trying.'}
          </AlertDescription>
        </Alert>
      )}
      {monitor && created.monitorId && (
        <p className="text-sm text-muted-foreground">
          This one is checked from outside, so you can also see it under{' '}
          <Link to={`/websites/${created.monitorId}`} className="underline underline-offset-4">
            Websites and APIs
          </Link>
          .
        </p>
      )}
      <Button onClick={onClose}>{seen ? 'Done' : 'Close'}</Button>
    </div>
  );
}

export default function AddServiceDialog({ open, onOpenChange }) {
  const { isAdmin } = useSession();
  const client = useQueryClient();
  const hosts = useApi('/servers', { includeDockerHosts: 'true' }, { enabled: open });
  const hostList = Array.isArray(hosts.data) ? hosts.data : (hosts.data?.items ?? []);
  const [type, setType] = useState(null);
  const [form, setForm] = useState({ name: '', host: '', url: '', port: '', address: '', unit: '', processName: '' });
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const [installing, setInstalling] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const def = SERVICE_TYPES.find((t) => t.id === type);

  const create = useMutation({
    mutationFn: (body) => api('/services', { method: 'POST', body }),
    onSuccess: (row) => {
      client.invalidateQueries();
      setCreated(row);
    },
    onError: (e) => setError(e.message),
  });

  function reset() {
    setType(null);
    setForm({ name: '', host: '', url: '', port: '', address: '', unit: '', processName: '' });
    setError('');
    setCreated(null);
  }
  function close(next) {
    if (!next) reset();
    onOpenChange(next);
  }

  const onHost = type && !def.external && !(type === 'tcp' && form.host === PUBLIC);
  const needsUrl = type === 'website' || type === 'api' || type === 'nginx' || type === 'apache';
  const urlRequired = type === 'website' || type === 'api';

  function submit(event) {
    event.preventDefault();
    setError('');
    const name = form.name.trim();
    if (!name) return setError('Give the service a name.');
    const body = { type, name };
    if (onHost) {
      if (!form.host || form.host === INSTALL) return setError('Choose the host it runs on.');
      body.host = form.host;
    }
    if (needsUrl && form.url.trim()) body.url = form.url.trim();
    if (urlRequired && !form.url.trim()) return setError('Enter the address, starting with http.');
    if (type === 'tcp' && form.host === PUBLIC) {
      if (!form.address.trim()) return setError('Enter the address to check.');
      body.address = form.address.trim();
    }
    if (form.port) {
      const port = Number(form.port);
      if (!(port >= 1 && port <= 65535)) return setError('Enter a port between 1 and 65535.');
      body.port = port;
    } else if (type === 'tcp') return setError('Enter a port.');
    if (type === 'systemd' && form.unit.trim()) body.unit = form.unit.trim();
    if (type === 'process' && form.processName.trim()) body.processName = form.processName.trim();
    create.mutate(body);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add a service</DialogTitle>
            <DialogDescription>
              {created
                ? 'Added.'
                : type
                  ? def.text
                  : 'What do you want to watch? You can stay on this page, nothing is installed unless you pick a service that runs on a host.'}
            </DialogDescription>
          </DialogHeader>
          {!isAdmin ? (
            <Alert>
              <AlertDescription>
                Only owners and admins can add services. Ask one of them to do this.
              </AlertDescription>
            </Alert>
          ) : created ? (
            <Waiting created={created} onClose={() => close(false)} />
          ) : !type ? (
            <ul className="grid gap-2 sm:grid-cols-2">
              {SERVICE_TYPES.map((t) => (
                <li key={t.id}>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto w-full flex-col items-start gap-1 whitespace-normal py-3 text-left"
                    onClick={() => {
                      setType(t.id);
                      set({ host: t.id === 'tcp' ? PUBLIC : '' });
                    }}
                  >
                    <span className="font-medium">{t.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">{t.text}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              {(!def.external) && (
                <FormField
                  label={type === 'tcp' ? 'Where is the port?' : 'Which host does it run on?'}
                >
                  {(p) => (
                    <Select
                      value={form.host}
                      onValueChange={(v) => {
                        if (v === INSTALL) setInstalling(true);
                        else set({ host: v });
                      }}
                    >
                      <SelectTrigger {...p}>
                        <SelectValue placeholder="Choose a host" />
                      </SelectTrigger>
                      <SelectContent>
                        {type === 'tcp' && (
                          <SelectItem value={PUBLIC}>A public address (checked from outside)</SelectItem>
                        )}
                        {hostList.map((h) => (
                          <SelectItem key={h.id} value={h.id}>
                            {h.name}
                            {h.kind === 'docker-host' ? ' (Docker host)' : ''}
                          </SelectItem>
                        ))}
                        <SelectItem value={INSTALL}>Install the agent on that host…</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              )}
              <FormField label="Name" hint="Shown in your list, for example Main database.">
                {(p) => (
                  <Input {...p} value={form.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
                )}
              </FormField>
              {needsUrl && (
                <FormField
                  label={type === 'nginx' || type === 'apache' ? 'Status page address (optional)' : 'Address'}
                  hint={
                    type === 'nginx'
                      ? 'Default: http://127.0.0.1/nginx_status'
                      : type === 'apache'
                        ? 'Default: http://127.0.0.1/server-status?auto'
                        : 'Starts with http:// or https://'
                  }
                >
                  {(p) => <Input {...p} type="url" value={form.url} onChange={(e) => set({ url: e.target.value })} />}
                </FormField>
              )}
              {type === 'tcp' && form.host === PUBLIC && (
                <FormField label="Host name or IP address">
                  {(p) => <Input {...p} value={form.address} onChange={(e) => set({ address: e.target.value })} />}
                </FormField>
              )}
              {(type === 'tcp' || DEFAULT_PORT[type]) && (
                <FormField label={type === 'tcp' ? 'Port' : 'Port (optional)'} hint={DEFAULT_PORT[type] ? `Default: ${DEFAULT_PORT[type]}` : undefined}>
                  {(p) => (
                    <Input {...p} type="number" inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value })} />
                  )}
                </FormField>
              )}
              {type === 'systemd' && (
                <FormField label="Unit name (optional)" hint="Leave empty to use the name above, for example nginx.">
                  {(p) => <Input {...p} value={form.unit} onChange={(e) => set({ unit: e.target.value })} />}
                </FormField>
              )}
              {type === 'process' && (
                <FormField label="Program name (optional)" hint="Leave empty to use the name above, for example php-fpm.">
                  {(p) => <Input {...p} value={form.processName} onChange={(e) => set({ processName: e.target.value })} />}
                </FormField>
              )}
              {error && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                <Button type="button" variant="outline" onClick={() => { setType(null); setError(''); }}>
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Back
                </Button>
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                  Add service
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {installing && <InstallAgentDialog onClose={() => setInstalling(false)} />}
    </>
  );
}
