import { useState } from 'react';
import { Check, ChevronDown, Copy, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import Command from './Command';
import { stepsToText } from './guide';

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Opens a plain page with the guide and the print dialog (print or save as PDF). */
function printGuide(title, steps) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(
    `<!doctype html><title>${escapeHtml(title)}</title><body style="font:14px/1.5 system-ui;max-width:48rem;margin:2rem auto;padding:0 1rem"><pre style="white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace">${escapeHtml(stepsToText(title, steps))}</pre></body>`,
  );
  win.document.close();
  win.focus();
  win.print();
}

/** Numbered steps: what it does, the command, what you should see, and what to do if it fails. */
export default function GuideSteps({ title, steps }) {
  const [copied, setCopied] = useState(false);
  async function copyAll() {
    try {
      await navigator.clipboard.writeText(stepsToText(title, steps));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard can be blocked */
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copyAll}>
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy all steps'}</span>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => printGuide(title, steps)}>
          <Printer className="size-4" aria-hidden="true" />
          Print or save as PDF
        </Button>
      </div>
      <ol className="space-y-6" aria-label={title}>
        {steps.map((s, i) => (
          <li key={`${i}-${s.title}`} className="space-y-2">
            <p className="font-medium">
              <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-muted text-sm">
                {i + 1}
              </span>
              {s.title}
            </p>
            <p className="text-sm text-muted-foreground">{s.what}</p>
            {s.commands && <Command code={s.commands} label={s.label || `${s.title} command`} />}
            {s.expect && (
              <p className="text-sm">
                <span className="font-medium">You should see: </span>
                {s.expect}
              </p>
            )}
            {s.trouble?.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="-ml-2">
                    Something went wrong?
                    <ChevronDown className="size-4" aria-hidden="true" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {s.trouble.map(([problem, fix]) => (
                      <li key={problem}>
                        <span className="font-medium">{problem}.</span> {fix}
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
