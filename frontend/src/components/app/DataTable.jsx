import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Simple responsive table. columns: [{ key, header, cell?(row), className?, headerClassName? }].
 * Wide tables scroll sideways inside their card on phones. Pass `onRowClick` for clickable rows
 * (rows are keyboard-focusable). Show `empty` (an <EmptyState/>) when there are no rows.
 */
export function DataTable({
  columns,
  rows,
  getKey = (row) => row.id,
  onRowClick,
  empty,
  className,
}) {
  if (!rows?.length && empty) return empty;
  return (
    <div className={cn('overflow-x-auto rounded-2xl border bg-card', className)}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} className={col.headerClassName}>
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={getKey(row)}
              className={cn(onRowClick && 'cursor-pointer')}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <TableCell key={col.key} className={col.className}>
                  {col.cell ? col.cell(row) : row[col.key]}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
