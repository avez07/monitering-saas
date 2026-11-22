import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function useCopy(value) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard can be blocked; the text stays selectable */
    }
  }
  return [copied, copy];
}

function CopyButton({ value, label, className }) {
  const [copied, copy] = useCopy(value);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={copy}
      className={className}
      aria-label={`Copy ${label}`}
    >
      {copied ? (
        <Check className="size-4" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </Button>
  );
}

/** One-line read-only value (key, URL, command) with a Copy button. */
export function CopyField({ value, label = 'value', className }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <code
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl border bg-muted px-3 py-2 font-mono text-sm"
        tabIndex={0}
      >
        {value}
      </code>
      <CopyButton value={value} label={label} className="shrink-0" />
    </div>
  );
}

/** Multi-line code or config with a Copy button. */
export function CodeBlock({ code, label = 'code', className }) {
  return (
    <div className={cn('relative rounded-xl border bg-muted', className)}>
      <pre className="overflow-x-auto p-4 pr-24 font-mono text-sm" tabIndex={0}>
        <code>{code}</code>
      </pre>
      <CopyButton value={code} label={label} className="absolute right-2 top-2" />
    </div>
  );
}
