import type { InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const field = cn(
  'h-9 w-full rounded-md border border-line-strong bg-surface-raised px-3 type-body text-ink',
  'placeholder:text-ink-muted disabled:cursor-not-allowed disabled:opacity-50',
  'focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent',
  'aria-invalid:border-2 aria-invalid:border-danger aria-invalid:px-[11px]',
);

export function Input({
  className,
  mono,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={cn(field, mono && 'font-mono font-medium', className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(field, 'cursor-pointer pr-8', className)} {...props} />;
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('type-label text-ink', className)} {...props} />;
}
