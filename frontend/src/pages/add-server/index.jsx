import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { session as orgStore } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { getReleases, saveProfile } from './api';
import { KEY_PATTERN, defaultSettings } from './model';
import StepInstall from './StepInstall';
import StepReview from './StepReview';
import StepWait from './StepWait';
import StepWhat from './StepWhat';
import StepWhere from './StepWhere';

const STEPS = [
  { title: 'Where it runs', text: 'Where does your server run?' },
  { title: 'What to monitor', text: 'What do you want to monitor?' },
  { title: 'Review', text: 'Review the settings' },
  { title: 'Install', text: 'Install the agent' },
  { title: 'Connect', text: 'Waiting for your server…' },
];

function Stepper({ step }) {
  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li
          key={s.title}
          className={cn('flex items-center gap-2', i < STEPS.length - 1 && 'flex-1')}
          aria-current={i === step ? 'step' : undefined}
        >
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium',
              i < step && 'border-primary bg-primary text-primary-foreground',
              i === step && 'border-primary text-foreground',
              i > step && 'text-muted-foreground',
            )}
          >
            {i < step ? <Check className="size-4" aria-hidden="true" /> : i + 1}
            <span className="sr-only">
              {' '}
              {s.title}
              {i < step ? ' (done)' : i === step ? ' (current step)' : ''}
            </span>
          </span>
          <span
            className={cn(
              'hidden text-sm lg:inline',
              i === step ? 'font-medium' : 'text-muted-foreground',
            )}
          >
            {s.title}
          </span>
          {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

export default function AddServer() {
  const { isAdmin, apiPublicUrl } = useSession();
  const [step, setStep] = useState(0);
  const [system, setSystem] = useState('ubuntu');
  const [docker, setDocker] = useState(false);
  const [processes, setProcesses] = useState(true);
  const [settings, setSettings] = useState(defaultSettings);
  const [setup, setSetup] = useState({ id: null, saved: '' });
  const [keyValue, setKeyValue] = useState('');
  const [saveError, setSaveError] = useState('');
  const [openedAt] = useState(() => new Date().toISOString());

  const releases = useQuery({
    queryKey: [orgStore.org, 'add-server', 'releases'],
    queryFn: getReleases,
    staleTime: 5 * 60 * 1000,
  });

  // "Specific programs" in step 2 is the processes collector in step 3.
  const effective = { ...settings, collectors: { ...settings.collectors, processes } };
  const save = useMutation({ mutationFn: saveProfile });

  async function next() {
    setSaveError('');
    if (step === 2) {
      const json = JSON.stringify(effective);
      if (setup.id && setup.saved === json) return setStep(3);
      try {
        const row = await save.mutateAsync({
          id: setup.id,
          name: `Setup ${new Date().toLocaleString()}`,
          settings: effective,
        });
        setSetup({ id: row.id, saved: json });
        setStep(3);
      } catch (error) {
        setSaveError(`We couldn't save your settings. ${error.message}`);
      }
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  const apiUrl = apiPublicUrl || '';
  const current = STEPS[step];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Add a server"
        description="Connect a server in a few minutes. You can add more later."
      />
      <Stepper step={step} />
      <Card>
        <CardHeader>
          <CardTitle className="text-xl" id="step-title" tabIndex={-1}>
            Step {step + 1} of {STEPS.length}: {current.text}
          </CardTitle>
          {step === 0 && (
            <CardDescription>
              We will tailor the install instructions to your system.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {step === 0 && <StepWhere value={system} onChange={setSystem} />}
          {step === 1 && (
            <StepWhat
              docker={docker}
              onDocker={setDocker}
              processes={processes}
              onProcesses={setProcesses}
              system={system}
            />
          )}
          {step === 2 && (
            <StepReview
              settings={effective}
              onChange={(s) => {
                setSettings(s);
                setProcesses(s.collectors.processes);
              }}
              docker={docker}
              error={saveError}
            />
          )}
          {step === 3 && (
            <StepInstall
              system={system}
              docker={docker}
              setupId={setup.id}
              keyValue={keyValue}
              onKey={setKeyValue}
              release={releases.data}
              apiUrl={apiUrl}
              isAdmin={isAdmin}
            />
          )}
          {step === 4 && <StepWait startedAt={openedAt} />}

          {step < 4 && (
            <div className="flex flex-col-reverse gap-2 border-t pt-6 sm:flex-row sm:justify-between">
              <Button
                variant="outline"
                onClick={() => setStep((s) => s - 1)}
                disabled={step === 0}
                className="sm:w-auto"
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                Back
              </Button>
              <Button onClick={next} disabled={save.isPending}>
                {save.isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                {step === 3
                  ? KEY_PATTERN.test(keyValue)
                    ? 'I ran the command'
                    : 'Skip, I already ran it'
                  : 'Continue'}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          )}
          {step === 4 && (
            <div className="border-t pt-6">
              <Button variant="outline" onClick={() => setStep(3)}>
                <ArrowLeft className="size-4" aria-hidden="true" />
                Back to the install commands
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
