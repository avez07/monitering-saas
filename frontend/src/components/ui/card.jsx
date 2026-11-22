import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Warm paper card. `accent` adds the signature colour strip: true (primary), 'success' | 'warning'
 * | 'danger' | 'info' | 'primary', or pass a CSS colour via style={{ '--accent-color': ... }} with
 * className="card-accent". `accent="left"` puts the strip on the left edge.
 */
const Card = React.forwardRef(({ className, accent, ...props }, ref) => {
  const variant = typeof accent === 'string' && accent !== 'left' ? `card-accent--${accent}` : null;
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-border/70 bg-card text-card-foreground shadow-sm transition-[transform,box-shadow] duration-200',
        accent && 'card-accent',
        variant,
        accent === 'left' && 'card-accent--left',
        className,
      )}
      {...props}
    />
  );
});
Card.displayName = 'Card';

const CardHeader = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-col space-y-1.5 rounded-t-2xl bg-muted/40 p-5', className)}
    {...props}
  />
));
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('font-serif text-base font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('p-5', className)} {...props} />
));
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center p-5 pt-0', className)} {...props} />
));
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
