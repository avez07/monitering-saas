import { ChevronDown } from 'lucide-react';
import { CodeBlock } from '@/components/app';
import { guideFor } from './local-test-guides';

/** Collapsible "Test it locally" help for one service type. Renders nothing for unknown types. */
export default function LocalTestGuide({ type, className }) {
  const guide = guideFor(type);
  if (!guide) return null;
  return (
    <details className={`group surface card-accent p-4 transition-colors hover:border-foreground/20 ${className || ''}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
        Test it locally ({guide.title})
        <ChevronDown
          className="size-4 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-3 space-y-4 text-sm">
        <p className="text-muted-foreground">{guide.intro}</p>
        <ol className="space-y-4">
          {guide.steps.map((step, i) => (
            <li key={step.title} className="space-y-2">
              <p className="font-medium">
                {i + 1}. {step.title}
              </p>
              <CodeBlock code={step.code} label="command" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Healthy: </span>
                {step.healthy}
              </p>
            </li>
          ))}
        </ol>
        {guide.windows && <p className="text-muted-foreground">{guide.windows}</p>}
      </div>
    </details>
  );
}
