import { cn } from '@/lib/utils';

export type FilterTab<K extends string> = { key: K; label: string; count?: number };

/** A row of toggle buttons that pick one view of a list, each with its count. */
export function FilterTabs<K extends string>({
  label,
  tabs,
  current,
  onChange,
}: {
  label: string;
  tabs: FilterTab<K>[];
  current: K;
  onChange: (key: K) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1 border-b border-line">
      {tabs.map((tab) => {
        const on = tab.key === current;
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(tab.key)}
            className={cn(
              '-mb-px h-10 cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-3 type-label text-ink',
              'focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent',
              on && 'border-pine font-semibold text-pine',
            )}
          >
            {tab.label}{' '}
            {tab.count !== undefined && (
              <span className="font-normal text-ink-muted">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
