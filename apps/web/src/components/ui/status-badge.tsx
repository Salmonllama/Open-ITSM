import { cn } from '@/lib/utils';
import { StatusShape, type Tone } from './status-shape';

const tones: Record<Tone, string> = {
  info: 'bg-info-soft text-info',
  progress: 'bg-progress-soft text-progress',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-neutral-soft text-neutral',
};

/** A status shown as word, shape and colour together. */
export function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm py-0 pr-2 pl-1.5 text-[12px] leading-5 font-semibold whitespace-nowrap',
        tones[tone],
      )}
    >
      <StatusShape tone={tone} />
      {children}
    </span>
  );
}
