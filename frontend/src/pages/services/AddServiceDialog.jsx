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
import LocalTestGuide from './LocalTestGuide';
import InstallAgentDialog from './InstallAgentDialog';
import CredentialsSection from './CredentialsSection';
import { CREDENTIAL_KINDS, credentialsRefError } from './credentials-guide';

// Contract: docs/api/phase16.md (POST /api/services). Services run on a host with the agent;
// websites, APIs and public ports are added under Websites & APIs.
export const SERVICE_TYPES = [
  { id: 'tcp', label: 'TCP port', text: 'Is a port open on one of your hosts?' },
  { id: 'nginx', label: 'nginx', text: 'The nginx status page on a host.' },
  { id: 'apache', label: 'Apache', text: 'The Apache status page on a host.' },
  { id: 'mysql', label: 'MySQL', text: 'Does MySQL answer on a host?' },
  { id: 'postgres', label: 'PostgreSQL', text: 'Does PostgreSQL answer on a host?' },
  { id: 'mssql', label: 'Microsoft SQL Server', text: 'Does SQL Server answer on a host?' },
  { id: 'redis', label: 'Redis', text: 'Does Redis answer on a host?' },
  { id: 'systemd', label: 'System service', text: 'A systemd unit such as nginx or cron.' },
  { id: 'process', label: 'Program', text: 'A program by its process name.' },
];
const INSTALL = '__install__';
const DEFAULT_PORT = { mysql: 3306, postgres: 5432, mssql: 1433, redis: 6379 };
const EMPTY = { name: '', host: '', url: '', port: '', unit: '', processName: '', credentialsRef: '' };

function Waiting({ created, onClose }) {
  const [tries, setTries] = useState(0);
  const list = useApi('/services', {}, { refetchInterval: 4000 });
  const items = Array.isArray(list.data) ? list.data : (list.data?.items ?? []);
  // A reported service has its own id; match the pending entry by host, kind and name.
  const seen = items.find(
    (s) => s.id === created.id || (s.serverId === created.serverId && s.kind === created.kind && s.name === created.name),
  );
  useEffect(() => {
    const id = setInterval(() => setTries((t) => t + 1), 4000);
    return () => clearInterval(id);
  }, []);
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
            The agent picks up the new service on its next settings check, usually within a minute.
            {tries > 20 && ' This is taking longer than usual. You can close this window, it keeps trying.'}
          </AlertDescription>
        </Alert>
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
  const [form, setForm] = useState(EMPTY);
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
    setForm(EMPTY);
    setError('');
    setCreated(null);
  }
  function close(next) {
    if (!next) reset();
    onOpenChange(next);
  }

  const needsUrl = type === 'nginx' || type === 'apache';

  function submit(event) {
    event.preventDefault();
    setError('');
    const name = form.name.trim();
    if (!name) return setError('Give the service a name.');
    const body = { type, name };
    if (!form.host || form.host === INSTALL) return setError('Choose the host it runs on.');
    body.host = form.host;
    if (needsUrl && form.url.trim()) body.url = form.url.trim();
    if (form.port) {
      const port = Number(form.port);
      if (!(port >= 1 && port <= 65535)) return setError('Enter a port between 1 and 65535.');
      body.port = port;
    } else if (type === 'tcp') return setError('Enter a port.');
    if (type === 'systemd' && form.unit.trim()) body.unit = form.unit.trim();
    if (type === 'process' && form.processName.trim()) body.processName = form.processName.trim();
    if (CREDENTIAL_KINDS.includes(type) && form.credentialsRef.trim()) {
      const refError = credentialsRefError(form.credentialsRef);
      if (refError) return setError(refError);
      body.credentialsRef = form.credentialsRef.trim();
    }
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
                  : 'What runs on your host that you want to watch? The agent on that host checks it.'}
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
            <div className="space-y-4">
            <ul className="grid gap-2 sm:grid-cols-2">
              {SERVICE_TYPES.map((t) => (
                <li key={t.id}>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto w-full flex-col items-start gap-1 whitespace-normal py-3 text-left"
                    onClick={() => {
                      setType(t.id);
                      set({ host: '' });
                    }}
                  >
                    <span className="font-medium">{t.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">{t.text}</span>
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground" data-testid="websites-hint">
              Checking a website, API or public port? →{' '}
              <Link to="/websites" onClick={() => close(false)} className="font-medium text-foreground underline underline-offset-4">
                Websites &amp; APIs
              </Link>
            </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <FormField label={type === 'tcp' ? 'Which host has the port?' : 'Which host does it run on?'}>
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
              <FormField label="Name" hint="Shown in your list, for example Main database.">
                {(p) => (
                  <Input {...p} value={form.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
                )}
              </FormField>
              {needsUrl && (
                <FormField
                  label="Status page address (optional)"
                  hint={
                    type === 'nginx'
                      ? 'Default: http://127.0.0.1/nginx_status'
                      : 'Default: http://127.0.0.1/server-status?auto'
                  }
                >
                  {(p) => <Input {...p} type="url" value={form.url} onChange={(e) => set({ url: e.target.value })} />}
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
              <CredentialsSection
                kind={type}
                value={form.credentialsRef}
                onChange={(credentialsRef) => set({ credentialsRef })}
              />
              <LocalTestGuide type={type} />
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
