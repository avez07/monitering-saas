import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

const TONES = {
  primary: 'hsl(var(--primary))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  danger: 'hsl(var(--destructive))',
  info: 'hsl(var(--chart-4))',
};

/**
 * Big Fraunces number with a label, optional hint and a tinted corner blob holding the icon.
 * Pass to= to make the whole card a link. Optional tone= (primary | success | warning | danger | info,
 * or any CSS colour) sets the accent strip and blob.
 */
export function StatCard({ label, value, hint, icon: Icon, to, tone = 'primary', className }) {
  const style = { '--accent-color': TONES[tone] || tone };
  const body = (
    <>
      {Icon && (
        <span className="stat-blob" aria-hidden="true">
          <Icon className="size-5" />
        </span>
      )}
      <p className="stat-label">{label}</p>
      <p className="stat-value mt-2">{value}</p>
      {hint && <p className="stat-hint mt-2">{hint}</p>}
    </>
  );
  if (to) {
    return (
      <Link
        to={to}
        style={style}
        className={cn('stat-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      >
        {body}
      </Link>
    );
  }
  return (
    <div style={style} className={cn('stat-card', className)}>
      {body}
    </div>
  );
}
