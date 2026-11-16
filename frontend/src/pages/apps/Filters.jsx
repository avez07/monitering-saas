import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getServices, useCall } from './api';
import { parseAttribute } from './model';
import { SelectField } from './shared';

/** Service dropdown fed by the services list. */
export function ServiceSelect({ value, onChange, id = 'f-service' }) {
  const query = useCall(['services', '30d'], () => getServices('30d'), { staleTime: 60000 });
  const names = (query.data?.items ?? []).map((s) => s.name);
  if (value && !names.includes(value)) names.push(value);
  return (
    <SelectField
      id={id}
      label="Service"
      value={value}
      onChange={onChange}
      options={[{ value: '', label: 'All services' }, ...names.map((n) => ({ value: n, label: n }))]}
    />
  );
}

/** Adds `key=value` attribute filters (max 5) shown as removable chips. */
export function AttributeFilter({ attributes, onChange }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const full = attributes.length >= 5;

  function add(e) {
    e.preventDefault();
    const parsed = parseAttribute(text);
    if (!parsed) return setError('Write it as name=value, for example order.id=42.');
    setError('');
    setText('');
    onChange([...attributes, parsed]);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="f-attr">Attribute</Label>
      <form onSubmit={add} className="flex gap-2">
        <Input
          id="f-attr"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="order.id=42"
          disabled={full}
          aria-describedby="f-attr-help"
          autoComplete="off"
        />
        <Button type="submit" variant="outline" disabled={full || !text.trim()}>
          Add
        </Button>
      </form>
      <p id="f-attr-help" role={error ? 'alert' : undefined} className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
        {error || (full ? 'You can filter on up to 5 attributes.' : 'Press Add to filter on name=value.')}
      </p>
      {attributes.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Active attribute filters">
          {attributes.map((a, i) => (
            <li key={`${a.key}-${i}`}>
              <button
                type="button"
                onClick={() => onChange(attributes.filter((_, j) => j !== i))}
                className="inline-flex items-center gap-1 rounded-full border bg-muted px-3 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove filter ${a.key}=${a.value}`}
              >
                {a.key}={a.value}
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Reads the filter state from URL search params (so views can be shared and linked). */
export function readFilters(params) {
  const attributes = params
    .getAll('attribute')
    .map(parseAttribute)
    .filter(Boolean);
  return {
    service: params.get('service') || '',
    endpoint: params.get('endpoint') || '',
    status: params.get('status') || '',
    minDurationMs: params.get('minDurationMs') || '',
    severity: params.get('severity') || '',
    traceId: params.get('traceId') || '',
    q: params.get('q') || '',
    range: params.get('range') || '1h',
    attributes,
  };
}

export function writeFilters(f) {
  const p = new URLSearchParams();
  for (const k of ['service', 'endpoint', 'status', 'minDurationMs', 'severity', 'traceId', 'q', 'range'])
    if (f[k]) p.set(k, f[k]);
  for (const a of f.attributes ?? []) p.append('attribute', `${a.key}=${a.value}`);
  return p;
}
