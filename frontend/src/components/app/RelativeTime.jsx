import { useEffect, useState } from 'react';
import { formatDateTime, formatRelative } from '@/lib/format';

/** "5 minutes ago" with the exact time as a tooltip. Re-renders every 30 s. */
export function RelativeTime({ value, className }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);
  if (!value) return <span className={className}>never</span>;
  return (
    <time
      dateTime={new Date(value).toISOString()}
      title={formatDateTime(value)}
      className={className}
    >
      {formatRelative(value)}
    </time>
  );
}
