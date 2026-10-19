import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { StatusShape } from './status-shape';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface-raised p-4 text-ink shadow-raised',
        className,
      )}
      {...props}
    />
  );
}

/** A danger alert for a failed request: what happened, then what to do. */
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 type-body text-danger"
    >
      <span className="mt-[5px]">
        <StatusShape tone="danger" />
      </span>
      {message}
    </p>
  );
}
