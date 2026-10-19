import { cn } from '@/lib/utils';

/**
 * The Open ITSM lockup. The name is part of the artwork, so never set it in text beside the
 * logo. The light and reversed files swap with the theme in index.css.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/brand/open-itsm-lockup.svg"
        alt="Open ITSM"
        className={cn('logo-light h-7 w-auto', className)}
      />
      <img
        src="/brand/open-itsm-lockup-reversed.svg"
        alt="Open ITSM"
        className={cn('logo-reversed h-7 w-auto', className)}
      />
    </>
  );
}
