import type { ReactNode } from 'react';

/** The page title (display style, one per screen), an optional caption and actions on the right. */
export function PageHeader({
  title,
  caption,
  actions,
}: {
  title: string;
  caption?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 type-display">{title}</h1>
        {caption && <p className="m-0 type-caption text-ink-muted">{caption}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
