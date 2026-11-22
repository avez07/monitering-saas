import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

function Choice({ id, label, children, checked, onChange, disabled, badge }) {
  return (
    <div className="flex items-start gap-3 surface card-accent p-4">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange?.(v === true)}
        className="mt-1"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id} className="text-sm font-medium">
            {label}
          </Label>
          {badge && <Badge variant="secondary">{badge}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

export default function StepWhat({ docker, onDocker, processes, onProcesses, system }) {
  return (
    <div className="space-y-3">
      <Choice id="want-system" label="System health" checked disabled badge="Always on">
        CPU, memory, disk, network and uptime. This is what every server needs.
      </Choice>
      <Choice id="want-docker" label="Docker containers" checked={docker} onChange={onDocker}>
        {system === 'docker'
          ? 'See each container on this machine. We mount the Docker socket read-only, so the agent can look but not change anything.'
          : 'See each container, its CPU and memory. This gives the agent read access to Docker: the installer adds the agent user to the "docker" group. Docker access is powerful, so only turn it on if you need it.'}
      </Choice>
      <Choice
        id="want-processes"
        label="Specific programs"
        checked={processes}
        onChange={onProcesses}
      >
        Shows the programs that use the most CPU and memory, so you can see what is slowing a server
        down.
      </Choice>
      <Choice id="want-web" label="Web server" disabled badge="Coming soon">
        nginx and Apache request and error rates. For now, check your website from outside under
        Websites.
      </Choice>
      <Choice id="want-db" label="Databases" disabled badge="Coming soon">
        MySQL, PostgreSQL and Redis health.
      </Choice>
    </div>
  );
}
