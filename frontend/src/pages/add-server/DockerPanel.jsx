import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import GuideSteps from './GuideSteps';
import { dockerSteps } from './guide';
import { DOCKER_DENIED_HELP, DOCKER_DESKTOP_NOTE, DOCKER_PLATFORMS, WINDOWS_SHELLS, dockerCompose, dockerRun } from './model';

/** Group of mutually exclusive buttons. */
export function Choice({ label, value, onChange, options }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <Button
          key={o.id}
          type="button"
          size="sm"
          variant={o.id === value ? 'default' : 'outline'}
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/** "Where are you running Docker?" and the matching docker run / compose commands. */
export function DockerPlatformPicker({ platform, onPlatform, shell, onShell }) {
  const current = DOCKER_PLATFORMS.find((p) => p.id === platform);
  return (
    <div className="space-y-3">
      <p className="font-medium" id="docker-where">
        Where are you running Docker?
      </p>
      <Choice
        label="Where are you running Docker?"
        value={platform}
        onChange={onPlatform}
        options={DOCKER_PLATFORMS}
      />
      <p className="text-sm text-muted-foreground">{current?.hint}</p>
      {platform === 'windows' && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Which window will you paste it in?</p>
          <Choice label="Shell" value={shell} onChange={onShell} options={WINDOWS_SHELLS} />
        </div>
      )}
      {platform !== 'linux' && (
        <Alert>
          <AlertDescription>{DOCKER_DESKTOP_NOTE}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export default function DockerPanel({ release, keyValue, apiUrl, docker }) {
  const [platform, setPlatform] = useState('linux');
  const [shell, setShell] = useState('powershell');
  const common = { release, key: keyValue, apiUrl, docker };
  const command = dockerRun({ ...common, platform, shell });
  return (
    <div className="space-y-5">
      <DockerPlatformPicker
        platform={platform}
        onPlatform={setPlatform}
        shell={shell}
        onShell={setShell}
      />
      <p className="text-sm text-muted-foreground">
        It registers itself the first time it starts and does not keep your API key. It uses your
        default setup profile.
      </p>
      <GuideSteps
        title="Install the YuktiOps agent with Docker"
        steps={dockerSteps({ command, compose: dockerCompose(common), desktop: platform !== 'linux' })}
      />
      <Alert>
        <AlertDescription className="space-y-2">
          <p className="font-medium">{DOCKER_DENIED_HELP.title}</p>
          <p>{DOCKER_DENIED_HELP.body}</p>
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{DOCKER_DENIED_HELP.build}</pre>
          <p>
            Or, if the package is private, run <code>{DOCKER_DENIED_HELP.login}</code> first.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
