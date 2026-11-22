import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmDialog, CopyField, FormField, notify } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSession } from '@/lib/session';
import { useAction } from '@/lib/hooks';
import { FALLBACK_COMMANDS } from './ConnectionTab';

const COLLECTORS = [
  ['cpu', 'Processor (CPU)'],
  ['memory', 'Memory'],
  ['swap', 'Swap'],
  ['disk', 'Disk space'],
  ['diskIo', 'Disk activity'],
  ['network', 'Network'],
  ['load', 'Load'],
  ['processes', 'Busiest programs'],
];

const KINDS = {
  systemd: 'System service',
  process: 'Program (by name)',
  port: 'Network port',
  nginx: 'nginx status page',
  apache: 'Apache status page',
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  redis: 'Redis',
};

/** Add and remove the services the agent should check on this server. */
function ServicesEditor({ services, onChange, disabled }) {
  const [kind, setKind] = useState('systemd');
  const [name, setName] = useState('');
  const [extra, setExtra] = useState('');
  const [problem, setProblem] = useState('');
  const needsPort = kind === 'port';
  const needsUrl = kind === 'nginx' || kind === 'apache';

  function add() {
    const clean = name.trim();
    if (!clean) return setProblem('Give the service a name.');
    if (services.some((x) => x.kind === kind && x.name === clean))
      return setProblem('You already watch that one.');
    const entry = { kind, name: clean };
    if (needsPort) {
      const port = Number(extra);
      if (!(port >= 1 && port <= 65535)) return setProblem('Enter a port between 1 and 65535.');
      entry.port = port;
    }
    if (needsUrl) {
      if (!/^https?:\/\//.test(extra))
        return setProblem('Enter the status page address, starting with http.');
      entry.url = extra;
    }
    setProblem('');
    onChange([...services, entry]);
    setName('');
    setExtra('');
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium">Services to watch</p>
      {services.length === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">
          None yet. Add things like nginx or MySQL and you'll see them under Services.
        </p>
      ) : (
        <ul className="mb-3 divide-y surface-muted">
          {services.map((x) => (
            <li key={`${x.kind}-${x.name}`} className="flex items-center justify-between gap-3 p-3 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{x.name}</span>{' '}
                <span className="text-muted-foreground">
                  {KINDS[x.kind]}
                  {x.port ? ` · port ${x.port}` : ''}
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => onChange(services.filter((y) => y !== x))}
                aria-label={`Stop watching ${x.name}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr_1fr_auto] sm:items-end">
          <FormField label="Type">
            {(p) => (
              <Select value={kind} onValueChange={(v) => { setKind(v); setExtra(''); }}>
                <SelectTrigger id={p.id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(KINDS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label="Name" hint={kind === 'systemd' ? 'The unit name, e.g. nginx' : undefined}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />}
          </FormField>
          {needsPort || needsUrl ? (
            <FormField label={needsPort ? 'Port' : 'Status page address'}>
              {(p) => <Input {...p} value={extra} onChange={(e) => setExtra(e.target.value)} />}
            </FormField>
          ) : (
            <span aria-hidden="true" />
          )}
          <Button type="button" variant="outline" onClick={add}>
            Add
          </Button>
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

function RenameCard({ server, canEdit }) {
  const action = useAction();
  const [name, setName] = useState(server.name);
  const clean = name.trim();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-base font-semibold tracking-tight">Name</CardTitle>
        <CardDescription>
          This is only the name shown here. The server's own name ({server.hostname}) stays the same.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            action.mutate({
              path: `/servers/${server.id}`,
              method: 'PATCH',
              body: { name: clean },
              quiet: true,
            }, { onSuccess: () => notify.success('Name saved') });
          }}
        >
          <FormField label="Server name" className="flex-1">
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={100}
                disabled={!canEdit}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <Button type="submit" disabled={!canEdit || !clean || clean === server.name || action.isPending}>
            Save name
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ConfigCard({ server, canEdit }) {
  const action = useAction();
  const initial = server.config?.settings;
  const [send, setSend] = useState(initial?.sendIntervalSeconds ?? 30);
  const [sample, setSample] = useState(initial?.sampleIntervalSeconds ?? 10);
  const [collectors, setCollectors] = useState(initial?.collectors ?? {});
  const [services, setServices] = useState(initial?.collectors?.services ?? []);
  const [error, setError] = useState('');
  if (!initial) return null;

  function save(e) {
    e.preventDefault();
    const s = Number(send);
    const m = Number(sample);
    if (!(s >= 15 && s <= 300)) return setError('Send data every 15 to 300 seconds.');
    if (!(m >= 5 && m <= 60)) return setError('Measure every 5 to 60 seconds.');
    if (m > s) return setError('Measuring can’t be less often than sending.');
    setError('');
    action.mutate(
      {
        path: `/servers/${server.id}`,
        method: 'PATCH',
        body: {
          config: { ...initial, sendIntervalSeconds: s, sampleIntervalSeconds: m, collectors: { ...collectors, services } },
        },
        quiet: true,
      },
      { onSuccess: () => notify.success('Saved. The agent picks this up within a minute.') },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-base font-semibold tracking-tight">What this server reports</CardTitle>
        <CardDescription>
          Changes reach the agent by themselves. You don't need to log in to the server.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={save} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Measure every (seconds)" hint="Between 5 and 60.">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  value={sample}
                  disabled={!canEdit}
                  onChange={(e) => setSample(e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Send data every (seconds)" hint="Between 15 and 300.">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  value={send}
                  disabled={!canEdit}
                  onChange={(e) => setSend(e.target.value)}
                />
              )}
            </FormField>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">What to collect</legend>
            <ul className="grid gap-2 sm:grid-cols-2">
              {COLLECTORS.map(([key, label]) => (
                <li key={key} className="flex items-center justify-between gap-3 surface-muted p-3">
                  <label htmlFor={`col-${key}`} className="text-sm">
                    {label}
                  </label>
                  <Switch
                    id={`col-${key}`}
                    checked={collectors[key] !== false}
                    disabled={!canEdit}
                    onCheckedChange={(v) => setCollectors((c) => ({ ...c, [key]: v }))}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="space-y-2 surface-muted p-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="col-docker" className="text-sm font-medium">
                Containers (Docker)
              </label>
              <Switch
                id="col-docker"
                checked={collectors.docker === true}
                disabled={!canEdit}
                onCheckedChange={(v) => setCollectors((c) => ({ ...c, docker: v }))}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Lets the agent read your containers' state and usage. This gives it read access to
              Docker. It only reads, it never starts or stops anything. Your Docker group may need
              the agent user, so check the Connection tab if nothing shows up.
            </p>
          </div>
          <ServicesEditor services={services} onChange={setServices} disabled={!canEdit} />
          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
          {canEdit ? (
            <Button type="submit" disabled={action.isPending}>
              Save changes
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only owners and admins can change these settings.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export default function SettingsTab({ server, commands }) {
  const { isAdmin } = useSession();
  const navigate = useNavigate();
  const remove = useAction();
  const [confirm, setConfirm] = useState(false);
  const cmd = { ...FALLBACK_COMMANDS, ...(commands || {}) };

  return (
    <div className="space-y-6">
      <RenameCard server={server} canEdit={isAdmin} />
      <ConfigCard key={server.config?.version} server={server} canEdit={isAdmin} />

      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base font-semibold tracking-tight">Commands for this server</CardTitle>
          <CardDescription>Run these in a terminal on the server.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            ['Check the agent', cmd.status],
            ['Restart the agent', cmd.restart],
            ['Watch live logs', cmd.logs],
            ['Find and fix problems', cmd.doctor],
            ['Remove the agent from this server', cmd.uninstall],
          ].map(([label, value]) => (
            <div key={label} className="space-y-1.5">
              <p className="text-sm font-medium">{label}</p>
              <CopyField value={value} label={label.toLowerCase()} />
            </div>
          ))}
        </CardContent>
      </Card>

      {isAdmin && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="font-serif text-base font-semibold tracking-tight">Remove this server</CardTitle>
            <CardDescription>
              We stop accepting data from it and delete it from your dashboard. The agent stays
              installed until you run the uninstall command above.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" onClick={() => setConfirm(true)}>
              Remove {server.name}
            </Button>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        destructive
        title={`Remove ${server.name}?`}
        description="Its history will no longer be available and the agent will be locked out. This can't be undone."
        confirmLabel="Remove server"
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { path: `/servers/${server.id}`, method: 'DELETE', quiet: true },
            {
              onSuccess: () => {
                notify.success(`${server.name} was removed`);
                navigate('/servers');
              },
            },
          )
        }
      />
    </div>
  );
}
