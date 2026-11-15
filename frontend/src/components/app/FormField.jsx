import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Label + control + hint + error. `children` is a render function receiving props for the
 * control ({ id, 'aria-describedby', 'aria-invalid' }) or a single element that gets them.
 * Usage: <FormField label="Email" error={err}>{(p) => <Input {...p} name="email" />}</FormField>
 */
export function FormField({ label, hint, error, children, className }) {
  const id = useId();
  const describedBy =
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  const props = { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined };
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      {children(props)}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
