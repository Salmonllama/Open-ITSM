import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'sm';

const variants: Record<Variant, string> = {
  primary: 'border-pine bg-pine text-on-pine hover:border-pine-strong hover:bg-pine-strong',
  secondary: 'border-line-strong bg-surface-raised text-ink hover:bg-surface-sunken',
  ghost: 'border-transparent bg-transparent text-pine hover:bg-pine-soft',
  danger: 'border-danger bg-danger text-on-danger hover:brightness-[.92]',
};

const sizes: Record<Size, string> = {
  md: 'h-9 px-4',
  sm: 'h-7 px-3',
};

/** Button styling, also used for links that look like buttons (a link must not wrap a button). */
export function buttonClasses(variant: Variant = 'secondary', size: Size = 'md') {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border type-label whitespace-nowrap no-underline',
    'focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent',
    'disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
    variants[variant],
    sizes[size],
  );
}

/**
 * Design-system button. One primary per view; a danger button needs a confirmation that names
 * the thing it acts on. Icons inside are 16px Lucide icons.
 */
export function Button({
  className,
  variant = 'secondary',
  size = 'md',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={cn(buttonClasses(variant, size), className)} {...props} />;
}
