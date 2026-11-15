import { useState } from 'react';
import { Download } from 'lucide-react';
import { CopyField } from '@/components/app';
import Command from './Command';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { download } from '@/lib/api';
import KeyPanel from './KeyPanel';
import {
  AFTER_INSTALL,
  KEY_PATTERN,
  SYSTEMS,
  agentYaml,
  dockerCompose,
  dockerRun,
  oneCommand,
} from './model';

const KIND_LABEL = {
  deb: '.deb (Ubuntu, Debian)',
  rpm: '.rpm (RHEL, Rocky, Amazon)',
  'tar.gz': '.tar.gz (any Linux)',
};

function Step({ n, title, children }) {
  return (
    <li className="space-y-2">
      <p className="font-medium">
        <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-muted text-sm">
          {n}
        </span>
        {title}
      </p>
      {children}
    </li>
  );
}

function DownloadTab({ release, system, keyValue, setupId, apiUrl }) {
  const files = release?.files || [];
  const wanted = SYSTEMS.find((s) => s.id === system)?.kind;
  const kinds = [...new Set(files.map((f) => f.kind))];
  const [kind, setKind] = useState(kinds.includes(wanted) ? wanted : kinds[0]);
  const arches = [...new Set(files.filter((f) => f.kind === kind).map((f) => f.arch))];
  const [arch, setArch] = useState('amd64');
  const file = files.find(
    (f) => f.kind === kind && f.arch === (arches.includes(arch) ? arch : arches[0]),
  );
  const k = keyValue || 'YOUR_API_KEY';

  if (!files.length)
    return (
      <Alert>
        <AlertDescription>
          Downloads are not available right now. Use the One command tab instead.
        </AlertDescription>
      </Alert>
    );

  const install = {
    deb: `sudo dpkg -i ${file?.name}`,
    rpm: `sudo rpm -i ${file?.name}`,
    'tar.gz': [
      `tar -xzf ${file?.name}`,
      'sudo useradd --system --no-create-home --shell /usr/sbin/nologin yuktiops',
      'sudo install -m 0755 yuktiops-agent /usr/local/bin/yuktiops-agent',
      'sudo cp yuktiops-agent.service /etc/systemd/system/',
    ].join('\n'),
  }[kind];
  const register = `sudo yuktiops-agent register --key=${k}${setupId ? ` --setup=${setupId}` : ''}${/localhost|127\.0\.0\.1/.test(apiUrl) ? ` --api=${apiUrl}` : ''}`;
  const start =
    kind === 'tar.gz'
      ? 'sudo systemctl daemon-reload && sudo systemctl enable --now yuktiops-agent'
      : 'sudo systemctl enable --now yuktiops-agent';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-4">
        <div role="group" aria-label="Package type" className="flex flex-wrap gap-2">
          {kinds.map((kd) => (
            <Button
              key={kd}
              size="sm"
              variant={kd === kind ? 'default' : 'outline'}
              aria-pressed={kd === kind}
              onClick={() => setKind(kd)}
            >
              {KIND_LABEL[kd] || kd}
            </Button>
          ))}
        </div>
        <div role="group" aria-label="Processor type" className="flex flex-wrap gap-2">
          {arches.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={file?.arch === a ? 'default' : 'outline'}
              aria-pressed={file?.arch === a}
              onClick={() => setArch(a)}
            >
              {files.find((f) => f.arch === a)?.archLabel || a}
            </Button>
          ))}
        </div>
      </div>

      <ol className="space-y-5">
        <Step n={1} title="Download and install the package">
          {file && (
            <div className="space-y-2">
              <Button
                asChild
                variant="outline"
                className="h-auto whitespace-normal break-all py-2 text-left"
              >
                <a href={file.url} download>
                  <Download className="size-4" aria-hidden="true" />
                  Download {file.name}
                </a>
              </Button>
              <p className="break-all text-xs text-muted-foreground">
                SHA-256: <code className="font-mono">{file.sha256}</code>
              </p>
              <Command code={install} label="install command" />
            </div>
          )}
        </Step>
        <Step n={2} title="Connect it to your account">
          <Command code={register} label="register command" />
        </Step>
        <Step n={3} title="Start it">
          <Command code={start} label="start command" />
        </Step>
      </ol>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Want to edit settings by hand? Download the config file and put it at
          /etc/yuktiops/agent.yaml.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => download('agent.yaml', agentYaml({ apiUrl, setupId }))}
        >
          <Download className="size-4" aria-hidden="true" />
          Download agent.yaml
        </Button>
      </div>
    </div>
  );
}

export default function StepInstall({
  system,
  docker,
  setupId,
  keyValue,
  onKey,
  release,
  apiUrl,
  isAdmin,
}) {
  const isDocker = system === 'docker';
  const [tab, setTab] = useState(isDocker ? 'docker' : 'command');
  const ready = KEY_PATTERN.test(keyValue);
  const common = { release, key: keyValue, apiUrl, docker };

  if (!isAdmin)
    return (
      <Alert>
        <AlertDescription>
          Only owners and admins can create the API key needed to add a server. Ask one of them to
          do this step.
        </AlertDescription>
      </Alert>
    );

  return (
    <div className="space-y-6">
      <KeyPanel keyValue={keyValue} onKey={onKey} />
      {!ready && (
        <p className="text-sm text-muted-foreground">
          The commands below show YOUR_API_KEY until you add your key above.
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="command">One command (recommended)</TabsTrigger>
          <TabsTrigger value="download">Download</TabsTrigger>
          <TabsTrigger value="docker">Docker</TabsTrigger>
        </TabsList>

        <TabsContent value="command" className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Log in to your server over SSH and run this. It downloads the agent, checks its SHA-256,
            installs it and connects it to your account.
          </p>
          <Command code={oneCommand({ ...common, setupId })} label="install command" />
          {docker && (
            <p className="text-sm text-muted-foreground">
              The <code className="font-mono">--docker</code> part gives the agent read access to
              Docker by adding its user to the &quot;docker&quot; group.
            </p>
          )}
        </TabsContent>

        <TabsContent value="download" className="pt-2">
          <DownloadTab
            release={release}
            system={system}
            keyValue={keyValue}
            setupId={setupId}
            apiUrl={apiUrl}
          />
        </TabsContent>

        <TabsContent value="docker" className="space-y-4 pt-2">
          <p className="text-sm text-muted-foreground">
            Run it as a container. It registers itself the first time it starts and does not keep
            your API key. It uses your default setup profile.
          </p>
          <div className="space-y-2">
            <p className="font-medium">docker run</p>
            <Command code={dockerRun(common)} label="docker run command" />
          </div>
          <div className="space-y-2">
            <p className="font-medium">Docker Compose</p>
            <Command code={dockerCompose(common)} label="compose file" />
          </div>
        </TabsContent>
      </Tabs>

      <section aria-labelledby="after-install" className="space-y-2">
        <h3 id="after-install" className="font-medium">
          Useful commands after installing
        </h3>
        <dl className="grid gap-2 text-sm">
          {[
            ['Check it is running', AFTER_INSTALL.status],
            ['Restart it', AFTER_INSTALL.restart],
            ['Watch the logs', AFTER_INSTALL.logs],
            ['Find problems', AFTER_INSTALL.doctor],
            ['Remove it', AFTER_INSTALL.uninstall],
          ].map(([label, command]) => (
            <div key={label} className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-center">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <CopyField value={command} label={label.toLowerCase()} />
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
