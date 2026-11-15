import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleDashed, Loader2, PartyPopper } from 'lucide-react';
import { CopyField } from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { session } from '@/lib/api';
import { getConnection, getPending } from './api';

const DEFAULT_STEPS = [
  { key: 'install_started', title: 'Install started' },
  { key: 'registered', title: 'Agent installed and registered' },
  { key: 'running', title: 'Agent running' },
  { key: 'data', title: 'Data arriving' },
];
const STATE_WORD = { done: 'Done', current: 'In progress', waiting: 'Waiting', failed: 'Problem' };

function StepIcon({ state }) {
  const cls = 'mt-0.5 size-5 shrink-0';
  if (state === 'done') return <CircleCheck className={cls} aria-hidden="true" />;
  if (state === 'failed')
    return <CircleAlert className={`${cls} text-destructive`} aria-hidden="true" />;
  if (state === 'current') return <Loader2 className={`${cls} animate-spin`} aria-hidden="true" />;
  return <CircleDashed className={`${cls} text-muted-foreground`} aria-hidden="true" />;
}

function Problem({ event }) {
  return (
    <Alert variant={event.severity === 'error' ? 'destructive' : 'default'}>
      <CircleAlert className="size-4" aria-hidden="true" />
      <AlertTitle>{event.title || event.code}</AlertTitle>
      <AlertDescription className="space-y-2">
        {event.explanation && <p>{event.explanation}</p>}
        {event.fix?.summary && <p className="font-medium">{event.fix.summary}</p>}
        {event.fix?.commands?.map((c) => (
          <CopyField key={c} value={c} label="fix command" />
        ))}
      </AlertDescription>
    </Alert>
  );
}

export default function StepWait({ startedAt, doctorCommand = 'sudo yuktiops-agent doctor' }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 60000);
    return () => clearTimeout(id);
  }, []);

  const pending = useQuery({
    queryKey: [session.org, 'add-server', 'pending', startedAt],
    queryFn: () => getPending(startedAt),
    refetchInterval: 3000,
    retry: true,
  });
  const serverId = pending.data?.serverId;
  const connection = useQuery({
    queryKey: [session.org, 'add-server', 'connection', serverId],
    queryFn: () => getConnection(serverId),
    enabled: !!serverId,
    refetchInterval: 3000,
  });

  const info = connection.data || pending.data;
  const byKey = new Map((info?.steps || []).map((s) => [s.key, s]));
  const steps = DEFAULT_STEPS.map((d, i) => {
    const got = byKey.get(d.key);
    if (got) return got;
    // The first step we have not heard about is "in progress".
    const firstMissing = DEFAULT_STEPS.findIndex((x) => !byKey.has(x.key));
    return { ...d, state: i === firstMissing ? 'current' : 'waiting' };
  });
  const connected = connection.data?.overall === 'connected';
  const problems = connection.data?.problems || [];
  const events =
    info?.events?.length && !connection.data
      ? info.events.filter((e) => e.severity !== 'info')
      : [];
  const diagnosis = info?.diagnosis;

  if (connected)
    return (
      <div className="space-y-6" role="status">
        <Alert>
          <PartyPopper className="size-4" aria-hidden="true" />
          <AlertTitle>Connected!</AlertTitle>
          <AlertDescription>
            {connection.data.server?.name || 'Your server'} is sending data. It can take a minute
            for the first charts to fill in.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="lg">
            <Link to={`/servers/${serverId}`}>Open your server</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/add-server" reloadDocument>
              Add another server
            </Link>
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-6">
      <div role="status" aria-live="polite" className="sr-only">
        {steps.find((s) => s.state === 'current')?.title || 'Waiting for your server'}
      </div>
      <ol className="space-y-3" aria-label="Connection progress">
        {steps
          .filter((s) => s.key !== 'problems')
          .map((s) => (
            <li key={s.key} className="flex items-start gap-3">
              <StepIcon state={s.state} />
              <div className="min-w-0">
                <p className="font-medium">
                  {s.title}{' '}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({STATE_WORD[s.state] || s.state})
                  </span>
                </p>
                {s.detail && s.state !== 'waiting' && (
                  <p className="text-sm text-muted-foreground">{s.detail}</p>
                )}
              </div>
            </li>
          ))}
      </ol>

      {[...problems, ...events].map((e) => (
        <Problem key={e.id || e.code} event={e} />
      ))}

      {diagnosis && (
        <Alert>
          <CircleAlert className="size-4" aria-hidden="true" />
          <AlertTitle>{diagnosis.title}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{diagnosis.explanation}</p>
            <ul className="list-disc space-y-1 pl-5">
              {diagnosis.checklist?.map((c) => (
                <li key={c.text}>
                  {c.text}
                  {c.command && <CopyField value={c.command} label="command" className="mt-1" />}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {pending.isError && (
        <p role="alert" className="text-sm text-destructive">
          We can&apos;t reach our servers right now. We will keep trying.
        </p>
      )}

      {slow && !diagnosis && (
        <Alert>
          <AlertTitle>Taking longer than a minute?</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              On your server, run this to find out what is wrong. It checks each step and says how
              to fix it.
            </p>
            <CopyField value={doctorCommand} label="doctor command" />
            <ul className="list-disc space-y-1 pl-5">
              <li>Did the install command finish without an error?</li>
              <li>Can the server reach the internet on port 443 (HTTPS)?</li>
              <li>Is the server&apos;s clock correct?</li>
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <p className="text-sm text-muted-foreground">
        This page updates by itself every few seconds. You can also leave and come back, your server
        will appear under Servers when it connects.
      </p>
    </div>
  );
}
