import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** A command that wraps so it can be read in full, with a Copy button underneath. */
export default function Command({ code, label = 'command' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard can be blocked; the text stays selectable */
    }
  }
  return (
    <div className="rounded-md border bg-muted">
      <pre
        className="whitespace-pre-wrap break-all p-3 font-mono text-sm"
        tabIndex={0}
        aria-label={label}
      >
        <code>{code}</code>
      </pre>
      <div className="flex justify-end border-t px-2 py-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label={`Copy ${label}`}
        >
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </Button>
      </div>
    </div>
  );
}
