import { AlertTriangle, CheckCircle2, Circle, Info, Loader2, XCircle } from 'lucide-react';
import { CopyField, ErrorState, LoadingState, RelativeTime } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

export const FALLBACK_COMMANDS = {
  status: 'yuktiops-agent status',
  restart: 'sudo systemctl restart yuktiops-agent',
  logs: 'sudo journalctl -u yuktiops-agent -f',
  doctor: 'sudo yuktiops-agent doctor',
  uninstall: 'sudo yuktiops-agent uninstall',
};

const STEP = {
  done: { icon: CheckCircle2, word: 'Done', className: 'text-chart-2' },
  current: { icon: Loader2, word: 'In progress', className: 'animate-spin text-foreground' },
  waiting: { icon: Circle, word: 'Waiting', className: 'text-muted-foreground' },
  failed: { icon: XCircle, word: 'Problem', className: 'text-destructive' },
};

const SEVERITY = {
  error: { icon: XCircle, word: 'Needs fixing', className: 'text-destructive' },
  warning: { icon: AlertTriangle, word: 'Warning', className: 'text-chart-4' },
  info: { icon: Info, word: 'Note', className: 'text-muted-foreground' },
};

const SUMMARY = {
  connected: { title: 'Connected', text: 'Your server is sending data normally.' },
  problem: {
    title: 'There is a problem',
    text: 'We found something that needs fixing. The steps below explain what to do.',
  },
  waiting: {
    title: 'Waiting for the agent',
    text: 'The install is still in progress. This page updates by itself.',
  },
  silent: {
    title: "We can't hear from this server",
    text: 'It registered, but nothing has arrived for a while.',
  },
};

function lastData(connection) {
  const s = connection.lastDataSecondsAgo;
  if (s === null || s === undefined) return 'No data received yet';
  if (s < 5) return 'Last data just now';
  return `Last data ${formatDuration(s)} ago`;
}

function Steps({ steps }) {
  return (
    <ol className="space-y-4">
      {steps.map((step, i) => {
        const meta = STEP[step.state] || STEP.waiting;
        const Icon = meta.icon;
        return (
          <li key={step.key} className="flex gap-3">
            <Icon className={cn('mt-0.5 size-5 shrink-0', meta.className)} aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium">
                {i + 1}. {step.title}{' '}
                <span className="text-sm font-normal text-muted-foreground">({meta.word})</span>
              </p>
              {step.detail && <p className="text-sm text-muted-foreground">{step.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Problem({ event }) {
  const meta = SEVERITY[event.severity] || SEVERITY.info;
  const Icon = meta.icon;
  return (
    <li className="surface p-4">
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 size-5 shrink-0', meta.className)} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="font-semibold">
              {event.title || 'Something went wrong'}{' '}
              <Badge variant="outline" className="ml-1 align-middle">
                {meta.word}
              </Badge>
            </h3>
            {event.explanation && <p className="mt-1">{event.explanation}</p>}
            <p className="mt-1 text-sm text-muted-foreground">
              Reported <RelativeTime value={event.at} />
            </p>
          </div>
          {event.fix && (
            <div className="space-y-2">
              <p className="text-sm font-medium">How to fix it</p>
              {event.fix.summary && <p className="text-sm">{event.fix.summary}</p>}
              {event.fix.commands?.map((c) => (
                <CopyField key={c} value={c} label="command" />
              ))}
            </div>
          )}
          {event.message && (
            <Collapsible>
              <CollapsibleTrigger className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
                Show the technical message
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {event.message}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </li>
  );
}

export default function ConnectionTab({ server, connection: query }) {
  const { data, isLoading, error, refetch } = query;
  if (isLoading) return <LoadingState label="Checking the connection…" />;
  if (error)
    return <ErrorState title="We couldn't check the connection" error={error} onRetry={refetch} />;

  const commands = { ...FALLBACK_COMMANDS, ...(data.commands || {}) };
  const summary = SUMMARY[data.overall] || SUMMARY.waiting;
  const connected = data.overall === 'connected';
  const SummaryIcon = connected
    ? CheckCircle2
    : data.overall === 'waiting'
      ? Loader2
      : AlertTriangle;
  const olderEvents = (data.events || []).slice(0, 10);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex items-start gap-4 p-4">
          <SummaryIcon
            className={cn(
              'mt-1 size-8 shrink-0',
              connected && 'text-chart-2',
              data.overall === 'waiting' && 'animate-spin text-muted-foreground',
              (data.overall === 'problem' || data.overall === 'silent') && 'text-chart-4',
            )}
            aria-hidden="true"
          />
          <div>
            <h2 className="font-serif text-base font-semibold tracking-tight">{summary.title}</h2>
            <p className="text-muted-foreground">{summary.text}</p>
            <p className="mt-2 font-medium" aria-live="polite">
              {lastData(data)}
            </p>
            {!connected && (
              <p className="mt-1 text-sm text-muted-foreground">
                Checking again every few seconds. You don't need to refresh.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base font-semibold tracking-tight">Connection steps</CardTitle>
        </CardHeader>
        <CardContent>
          <Steps steps={data.steps || []} />
        </CardContent>
      </Card>

      {data.problems?.length > 0 && (
        <section aria-labelledby="problems-title" className="space-y-3">
          <h2 id="problems-title" className="font-serif text-base font-semibold tracking-tight">
            Problems to fix
          </h2>
          <ul className="space-y-3">
            {data.problems.map((p) => (
              <Problem key={p.id} event={p} />
            ))}
          </ul>
        </section>
      )}

      {data.diagnosis && (
        <Card className="border-chart-4/60">
          <CardHeader>
            <CardTitle className="font-serif text-base font-semibold tracking-tight">{data.diagnosis.title}</CardTitle>
            <CardDescription className="text-sm">{data.diagnosis.explanation}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-2 font-medium">Run this on the server first</p>
              <CopyField
                value={data.diagnosis.doctorCommand || commands.doctor}
                label="doctor command"
              />
              <p className="mt-2 text-sm text-muted-foreground">
                It tests everything on the server itself and prints the fix in plain words.
              </p>
            </div>
            {data.diagnosis.checklist?.length > 0 && (
              <div>
                <p className="mb-2 font-medium">Then check these, most likely first</p>
                <ul className="space-y-3">
                  {data.diagnosis.checklist.map((item) => (
                    <li key={item.text} className="space-y-1.5">
                      <p className="text-sm">{item.text}</p>
                      {item.command && <CopyField value={item.command} label="command" />}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base font-semibold tracking-tight">Useful commands</CardTitle>
          <CardDescription>
            Run these on {server.name} in a terminal. The agent runs in the background.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            ['Check the agent', commands.status],
            ['Find and fix problems', commands.doctor],
            ['Restart the agent', commands.restart],
            ['Watch live logs', commands.logs],
          ].map(([label, value]) => (
            <div key={label} className="space-y-1.5">
              <p className="text-sm font-medium">{label}</p>
              <CopyField value={value} label={label.toLowerCase()} />
            </div>
          ))}
        </CardContent>
      </Card>

      {olderEvents.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="text-sm font-medium underline underline-offset-4">
            Show recent activity ({olderEvents.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-3 divide-y surface">
              {olderEvents.map((e) => (
                <li key={e.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm">
                  <span>{e.title || e.code}</span>
                  <RelativeTime value={e.at} className="text-muted-foreground" />
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
