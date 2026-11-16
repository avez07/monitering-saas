import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { CodeBlock, CopyField, PageHeader } from '@/components/app';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSession } from '@/lib/session';
import { createTelemetryKey, getConnection, useCall } from './api';
import {
  COLLECTOR_RUN,
  DEFAULT_ENDPOINT,
  LANGUAGES,
  collectorConfig,
  connectionHints,
  customiseExamples,
  envExports,
  envVars,
  installSteps,
} from './model';
import { SelectField } from './shared';

function Step({ number, title, description, children }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-lg">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm text-primary-foreground" aria-hidden="true">
            {number}
          </span>
          <span>
            <span className="sr-only">Step {number}: </span>
            {title}
          </span>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function KeyStep({ connection, fresh, onCreated }) {
  const { isAdmin } = useSession();
  const client = useQueryClient();
  const [name, setName] = useState('production');
  const create = useMutation({
    mutationFn: () => createTelemetryKey(name.trim() || 'production'),
    onSuccess: (r) => {
      onCreated(r.key);
      client.invalidateQueries();
    },
    onError: (e) => toast.error(e.message),
  });
  const keys = connection?.keys ?? [];

  return (
    <Step
      number={1}
      title="Create a telemetry key"
      description="The key is the password your app uses to send data. It can only send data, never read it. Make one per environment."
    >
      {fresh && (
        <Alert role="status">
          <TriangleAlert className="size-4" aria-hidden="true" />
          <AlertTitle>Copy your key now</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>This is the only time it is shown. The snippets below already contain it.</p>
            <CopyField value={fresh} label="telemetry key" />
          </AlertDescription>
        </Alert>
      )}
      {keys.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Your telemetry keys">
          {keys.map((k) => (
            <li key={k.id}>
              <span className="font-medium">{k.name}</span>{' '}
              <span className="font-mono text-muted-foreground">{k.prefix}…</span>
            </li>
          ))}
        </ul>
      )}
      {isAdmin ? (
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1.5 sm:w-64">
            <Label htmlFor="key-name">Key name</Label>
            <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </div>
          <Button type="submit" disabled={create.isPending}>
            <KeyRound className="size-4" aria-hidden="true" />
            {keys.length ? 'Create another key' : 'Create key'}
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground">Ask an owner or admin to create a telemetry key.</p>
      )}
      {!fresh && keys.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Existing keys are not shown again. Paste yours where the snippets say{' '}
          <code>yk_otel_PASTE_YOUR_KEY</code>, or create a new one.
        </p>
      )}
    </Step>
  );
}

function Waiting({ connection }) {
  const info = connectionHints(connection);
  const done = info.state === 'connected';
  return (
    <Step
      number={4}
      title="Check the connection"
      description="Run your app and send a few requests. This page checks every few seconds."
    >
      <div role="status" aria-live="polite" className="flex items-start gap-3">
        {done ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-chart-2" aria-hidden="true" />
        ) : (
          <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
        )}
        <p className="font-medium">{info.title}</p>
      </div>
      {done ? (
        <Button asChild>
          <Link to="/apps">See your app</Link>
        </Button>
      ) : (
        info.hints.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Nothing yet? Check these:</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {info.hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
        )
      )}
    </Step>
  );
}

export default function Connect() {
  const connectionQuery = useCall(['connection'], getConnection, { refetchInterval: 3000 });
  const connection = connectionQuery.data;
  const endpoint = connection?.otlpEndpoint || DEFAULT_ENDPOINT;
  const [fresh, setFresh] = useState(null);
  const [lang, setLang] = useState('node');
  const [service, setService] = useState('my-app');
  const [environment, setEnvironment] = useState('production');
  const key = fresh || undefined;
  const opts = { service, endpoint, key, environment };
  const steps = installSteps(lang, opts);
  const examples = customiseExamples(lang);
  const isCollector = lang === 'collector';

  return (
    <>
      <PageHeader
        title="Connect your app"
        description="Send traces and logs with the standard OpenTelemetry tools. Most apps need only a few settings and no code changes."
        breadcrumbs={[{ label: 'Apps', to: '/apps' }, { label: 'Connect' }]}
      />
      {connectionQuery.isError && (
        <Alert className="mb-4" role="alert">
          <AlertDescription>
            {connectionQuery.error?.message || 'We could not check the connection.'} The setup steps
            below still work.
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-6">
        <KeyStep connection={connection} fresh={fresh} onCreated={setFresh} />

        <Step number={2} title="Choose your language">
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField id="lang" label="Language" value={lang} onChange={setLang} options={LANGUAGES.map((l) => ({ value: l.id, label: l.id === 'collector' ? 'OpenTelemetry Collector' : l.label }))} />
            <div className="space-y-1.5">
              <Label htmlFor="svc">App name</Label>
              <Input id="svc" value={service} onChange={(e) => setService(e.target.value)} maxLength={60} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="env">Environment</Label>
              <Input id="env" value={environment} onChange={(e) => setEnvironment(e.target.value)} maxLength={40} />
            </div>
          </div>
        </Step>

        <Step
          number={3}
          title={isCollector ? 'Run the Collector' : 'Add the settings and start your app'}
        >
          <Tabs defaultValue="setup">
            <TabsList>
              <TabsTrigger value="setup">Set up</TabsTrigger>
              <TabsTrigger value="customise">Customise</TabsTrigger>
            </TabsList>

            <TabsContent value="setup" className="space-y-4">
              {isCollector ? (
                <>
                  <p className="text-base text-muted-foreground">
                    Save this as <code>otel-config.yaml</code>. It receives data from your apps on
                    this machine, ships your log files, and forwards everything to YuktiOps. Change
                    the log path to where your app writes logs.
                  </p>
                  <CodeBlock code={collectorConfig({ endpoint, key })} label="Collector config" />
                  <p className="text-base text-muted-foreground">
                    Then run it, and point your apps at <code>http://127.0.0.1:4318</code>.
                  </p>
                  <CodeBlock code={COLLECTOR_RUN} label="Collector command" />
                </>
              ) : (
                <>
                  <section className="space-y-2">
                    <h3 className="font-semibold">A. Settings (environment variables)</h3>
                    <CodeBlock code={envVars(opts)} label="environment variables" />
                    <details className="text-sm">
                      <summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        Shell version (export lines)
                      </summary>
                      <CodeBlock code={envExports(opts)} label="export lines" className="mt-2" />
                    </details>
                  </section>
                  <section className="space-y-2">
                    <h3 className="font-semibold">B. Install</h3>
                    <CodeBlock code={steps.install} label="install command" />
                  </section>
                  <section className="space-y-2">
                    <h3 className="font-semibold">C. Start your app</h3>
                    <CodeBlock code={steps.run} label="start command" />
                    <p className="text-sm text-muted-foreground">{steps.note}</p>
                    {steps.code && <CodeBlock code={steps.code} label="setup code" />}
                  </section>
                </>
              )}
            </TabsContent>

            <TabsContent value="customise" className="space-y-6">
              {isCollector ? (
                <p className="text-base text-muted-foreground">
                  Customising happens in your app. Pick a language above to see examples for custom
                  spans, ids, errors and sampling.
                </p>
              ) : (
                examples.map((ex) => (
                  <section key={ex.id} className="space-y-2">
                    <h3 className="font-semibold">{ex.title}</h3>
                    <p className="text-sm text-muted-foreground">{ex.text}</p>
                    <CodeBlock code={ex.code} label={ex.title} />
                  </section>
                ))
              )}
            </TabsContent>
          </Tabs>
        </Step>

        <Waiting connection={connection} />
      </div>
    </>
  );
}
