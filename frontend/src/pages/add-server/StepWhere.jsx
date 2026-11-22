import { Link } from 'react-router-dom';
import { Globe } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { SYSTEMS } from './model';

const SOON = [
  { id: 'windows', label: 'Windows Server' },
  { id: 'macos', label: 'macOS' },
];

const card = 'flex items-start gap-3 surface card-accent p-4 text-left transition-colors';

export default function StepWhere({ value, onChange }) {
  return (
    <div className="space-y-6">
      <RadioGroup
        value={value}
        onValueChange={onChange}
        aria-label="Where does your server run?"
        className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4"
      >
        {SYSTEMS.map((s) => (
          <label
            key={s.id}
            htmlFor={`os-${s.id}`}
            className={cn(
              card,
              'cursor-pointer hover:bg-accent',
              value === s.id && 'border-primary ring-1 ring-primary',
            )}
          >
            <RadioGroupItem id={`os-${s.id}`} value={s.id} className="mt-1" />
            <span>
              <span className="block font-medium">{s.label}</span>
              <span className="block text-sm text-muted-foreground">{s.hint}</span>
            </span>
          </label>
        ))}
      </RadioGroup>

      <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
        {SOON.map((s) => (
          <div key={s.id} className={cn(card, 'opacity-70')} aria-disabled="true">
            <span className="flex-1 font-medium">{s.label}</span>
            <Badge variant="secondary">Coming soon</Badge>
          </div>
        ))}
      </div>

      <Link
        to="/websites"
        className={cn(
          card,
          'items-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Globe className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>
          <span className="block font-medium">I only have shared hosting</span>
          <span className="block text-sm text-muted-foreground">
            You can&apos;t install software there, but we can still watch your website from outside.
          </span>
        </span>
      </Link>
    </div>
  );
}
