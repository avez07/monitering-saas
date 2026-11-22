import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/components/app';
import { COLLECTORS, SAMPLE_INTERVALS, SEND_INTERVALS, fromYaml, toYaml } from './model';

const every = (s) => (s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`);

export default function StepReview({ settings, onChange, docker, error }) {
  const [showYaml, setShowYaml] = useState(false);
  const [draft, setDraft] = useState(null); // text while typing; null = show the generated YAML
  const [yamlError, setYamlError] = useState('');

  const set = (patch) => onChange({ ...settings, ...patch });
  const setCollector = (key, on) => set({ collectors: { ...settings.collectors, [key]: on } });

  function typed(text) {
    setDraft(text);
    const parsed = fromYaml(text);
    if (parsed.error) setYamlError(parsed.error);
    else {
      setYamlError('');
      onChange(parsed.settings);
    }
  }

  const sample = SAMPLE_INTERVALS.filter((s) => s <= settings.sendIntervalSeconds);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Send a report every" hint="How often the agent sends data to us.">
          {(p) => (
            <Select
              value={String(settings.sendIntervalSeconds)}
              onValueChange={(v) => {
                const send = Number(v);
                set({
                  sendIntervalSeconds: send,
                  sampleIntervalSeconds: Math.min(settings.sampleIntervalSeconds, send),
                });
              }}
            >
              <SelectTrigger {...p}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEND_INTERVALS.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {every(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField label="Measure every" hint="Shorter catches brief spikes, longer is lighter.">
          {(p) => (
            <Select
              value={String(settings.sampleIntervalSeconds)}
              onValueChange={(v) => set({ sampleIntervalSeconds: Number(v) })}
            >
              <SelectTrigger {...p}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sample.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {every(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">What the agent measures</legend>
        <ul className="grid gap-2 sm:grid-cols-2">
          {COLLECTORS.map((c) => (
            <li
              key={c.key}
              className="flex items-center justify-between gap-3 surface p-3"
            >
              <div className="min-w-0">
                <Label htmlFor={`col-${c.key}`} className="font-medium">
                  {c.label}
                </Label>
                <p className="text-sm text-muted-foreground">{c.hint}</p>
              </div>
              <Switch
                id={`col-${c.key}`}
                checked={settings.collectors[c.key]}
                onCheckedChange={(on) => setCollector(c.key, on)}
              />
            </li>
          ))}
        </ul>
        {docker && (
          <p className="mt-3 text-sm text-muted-foreground">
            Docker containers will also be monitored. That is set when you install.
          </p>
        )}
      </fieldset>

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Switch id="show-yaml" checked={showYaml} onCheckedChange={setShowYaml} />
          <Label htmlFor="show-yaml">Show config file</Label>
        </div>
        {showYaml && (
          <div className="space-y-2">
            <Label htmlFor="yaml" className="sr-only">
              Setup profile as a config file
            </Label>
            <Textarea
              id="yaml"
              value={draft ?? toYaml(settings)}
              onChange={(e) => typed(e.target.value)}
              onBlur={() => !yamlError && setDraft(null)}
              spellCheck={false}
              rows={16}
              className="font-mono text-sm"
              aria-invalid={yamlError ? true : undefined}
              aria-describedby="yaml-help"
            />
            <p id="yaml-help" className="text-sm text-muted-foreground">
              Edit here or above, they stay in sync. You can change all of this later without
              logging in to your server.
            </p>
            {yamlError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {yamlError}
              </p>
            )}
          </div>
        )}
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
