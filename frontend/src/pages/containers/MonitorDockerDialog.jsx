import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CircleCheck } from 'lucide-react';
import { toast } from 'sonner';
import { CopyField, FormField, notify } from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import Command from '../add-server/Command';
import { DockerPlatformPicker } from '../add-server/DockerPanel';
import KeyPanel from '../add-server/KeyPanel';
import StepWait from '../add-server/StepWait';
import { getReleases } from '../add-server/api';
import { KEY_PATTERN, dockerRun } from '../add-server/model';

const TITLES = ['Where is Docker running?', 'Copy the command', 'Waiting for your containers'];

/** Make a freshly registered host a "Docker host" with the containers collector on. */
async function markDockerHost(serverId) {
  const server = await api(`/servers/${serverId}`);
  const settings = server.config?.settings;
  if (!settings) return;
  if (server.kind === 'docker-host' && settings.collectors?.docker) return;
  await api(`/servers/${serverId}`, {
    method: 'PATCH',
    body: {
      config: {
        ...settings,
        hostKind: 'docker-host',
        collectors: { ...settings.collectors, docker: true },
      },
    },
  });
}

function NewHost({ onClose }) {
  const { apiPublicUrl } = useSession();
  const client = useQueryClient();
  const [step, setStep] = useState(0);
  const [platform, setPlatform] = useState('linux');
  const [shell, setShell] = useState('powershell');
  const [keyValue, setKeyValue] = useState('');
  const [openedAt] = useState(() => new Date().toISOString());
  const releases = useQuery({
    queryKey: ['add-server', 'releases', 'docker-dialog'],
    queryFn: getReleases,
    staleTime: 5 * 60 * 1000,
  });
  const mark = useMutation({
    mutationFn: markDockerHost,
    onSuccess: () => client.invalidateQueries(),
    onError: (e) => toast.error(e.message),
  });
  const ready = KEY_PATTERN.test(keyValue);
  const command = dockerRun({
    release: releases.data,
    key: keyValue,
    apiUrl: apiPublicUrl || '',
    docker: true,
    platform,
    shell,
  });

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Step {step + 1} of 3: {TITLES[step]}
      </p>
      {step === 0 && (
        <DockerPlatformPicker
          platform={platform}
          onPlatform={setPlatform}
          shell={shell}
          onShell={setShell}
        />
      )}
      {step === 1 && (
        <div className="space-y-4">
          <KeyPanel keyValue={keyValue} onKey={setKeyValue} />
          {!ready && (
            <p className="text-sm text-muted-foreground">
              The command shows YOUR_API_KEY until you add your key above.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Run this where Docker runs. It starts the agent with the containers collector already
            on.
          </p>
          <Command code={command} label="docker run command" />
        </div>
      )}
      {step === 2 && (
        <StepWait
          startedAt={openedAt}
          doctorCommand="docker exec yuktiops-agent yuktiops-agent doctor"
          onServer={(id) => mark.mutate(id)}
          done={() => (
            <div className="space-y-4">
              <Alert>
                <CircleCheck className="size-4" aria-hidden="true" />
                <AlertTitle>Your Docker host is connected</AlertTitle>
                <AlertDescription>
                  Containers show up here within a minute. You can close this window.
                </AlertDescription>
              </Alert>
              <Button onClick={onClose}>Done</Button>
            </div>
          )}
        />
      )}
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-between">
        <Button variant="outline" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </Button>
        {step < 2 && (
          <Button onClick={() => setStep((s) => s + 1)}>
            {step === 1 ? 'I ran the command' : 'Continue'}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** One switch: containers on for a server that already runs the agent. */
function ExistingServer() {
  const client = useQueryClient();
  const list = useApi('/servers', { includeDockerHosts: 'true' });
  const servers = Array.isArray(list.data) ? list.data : (list.data?.items ?? []);
  const [id, setId] = useState('');
  const detail = useApi(`/servers/${id}`, {}, { enabled: !!id });
  const settings = detail.data?.config?.settings;
  const on = !!settings?.collectors?.docker;
  const save = useMutation({
    mutationFn: (docker) =>
      api(`/servers/${id}`, {
        method: 'PATCH',
        body: { config: { ...settings, collectors: { ...settings.collectors, docker } } },
      }),
    onSuccess: (_, docker) => {
      client.invalidateQueries();
      notify.success(
        docker
          ? 'Containers are on. They appear here within a minute.'
          : 'Containers are off for this server.',
      );
    },
    onError: (e) => toast.error(e.message),
  });

  if (!list.isPending && servers.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        You have no servers with the agent yet. Use the first option to add a Docker host.
      </p>
    );

  return (
    <div className="space-y-4">
      <FormField label="Server">
        {(p) => (
          <Select value={id} onValueChange={setId}>
            <SelectTrigger {...p}>
              <SelectValue placeholder="Choose a server" />
            </SelectTrigger>
            <SelectContent>
              {servers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                  {s.kind === 'docker-host' ? ' (Docker host)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      {id && settings && (
        <div className="flex items-center justify-between gap-4 surface-muted p-3">
          <label htmlFor="containers-switch" className="text-sm font-medium">
            Monitor Docker containers on this server
          </label>
          <Switch
            id="containers-switch"
            checked={on}
            disabled={save.isPending}
            onCheckedChange={(v) => save.mutate(v)}
          />
        </div>
      )}
      {id && settings && on && <PermissionHelp />}
    </div>
  );
}

const SOCKET_FLAG = '-v /var/run/docker.sock:/var/run/docker.sock:ro --group-add 0';

/** If containers do not appear: the fix depends on how the agent runs, not on the operating system you type in. */
function PermissionHelp() {
  const [how, setHow] = useState('package');
  return (
    <div className="space-y-3 text-sm text-muted-foreground">
      <p>
        The agent needs permission to talk to Docker. If containers do not appear, pick how the
        agent runs on that server:
      </p>
      <div role="group" aria-label="How the agent runs" className="flex flex-wrap gap-2">
        <Button size="sm" variant={how === 'package' ? 'default' : 'outline'} aria-pressed={how === 'package'} onClick={() => setHow('package')}>
          Linux install (script, .deb, .rpm)
        </Button>
        <Button size="sm" variant={how === 'docker' ? 'default' : 'outline'} aria-pressed={how === 'docker'} onClick={() => setHow('docker')}>
          Docker container (Linux, Windows, Mac)
        </Button>
      </div>
      {how === 'package' ? (
        <>
          <p>Run this on that Linux server (it lets the agent's own user read the Docker socket):</p>
          <CopyField value="sudo usermod -aG docker yuktiops && sudo systemctl restart yuktiops-agent" label="permission command" />
        </>
      ) : (
        <>
          <p>
            In a container there is no <code>yuktiops</code> user to change. Check that the container was started
            with the Docker socket, then check the agent:
          </p>
          <p>
            The agent in the container is not root, and the Docker socket belongs to root. Both flags are needed. On a
            Linux server use <code>--group-add $(stat -c '%g' /var/run/docker.sock)</code> instead of{' '}
            <code>--group-add 0</code>.
          </p>
          <CopyField value={SOCKET_FLAG} label="flags the docker run command needs" />
          <CopyField value="docker exec yuktiops-agent yuktiops-agent doctor" label="check command" />
          <p>
            Missing the flag? Remove the container (<code>docker rm -f yuktiops-agent</code>) and run the command from
            <strong> Add a Docker host</strong> again. It includes the flag for PowerShell, Command Prompt, bash and macOS.
          </p>
        </>
      )}
    </div>
  );
}

export default function MonitorDockerDialog({ open, onOpenChange }) {
  const { isAdmin } = useSession();
  const [mode, setMode] = useState('new');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Monitor Docker containers</DialogTitle>
          <DialogDescription>
            We call a machine that runs Docker a Docker host. It does not take a new price: it
            counts like a server.
          </DialogDescription>
        </DialogHeader>
        {!isAdmin ? (
          <Alert>
            <AlertDescription>
              Only owners and admins can add a Docker host. Ask one of them to do this.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div role="group" aria-label="What do you want to do?" className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={mode === 'new' ? 'default' : 'outline'}
                aria-pressed={mode === 'new'}
                onClick={() => setMode('new')}
              >
                Add a Docker host
              </Button>
              <Button
                size="sm"
                variant={mode === 'existing' ? 'default' : 'outline'}
                aria-pressed={mode === 'existing'}
                onClick={() => setMode('existing')}
              >
                Turn on containers for an existing server
              </Button>
            </div>
            {mode === 'new' ? <NewHost onClose={() => onOpenChange(false)} /> : <ExistingServer />}
            <p className="text-xs text-muted-foreground">
              Want to install on a Linux server with a package instead?{' '}
              <Link to="/add-server" className="underline underline-offset-4">
                Open the full install guide
              </Link>
              .
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
