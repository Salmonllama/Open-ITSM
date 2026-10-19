import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** A table on a raised card that scrolls sideways on narrow screens. */
export function Table({ className, children, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface-raised shadow-raised">
      <table className={cn('w-full border-collapse type-body', className)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'bg-surface-sunken px-4 py-3 text-left align-middle type-label whitespace-nowrap text-ink-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-t border-line px-4 py-3 align-middle', className)} {...props} />;
}
