export type Tone = 'info' | 'progress' | 'success' | 'warning' | 'danger' | 'neutral';

/**
 * The 12px shape that goes with each status tone, so status never relies on colour alone.
 * Drawn in currentColor; decorative because the word beside it carries the meaning.
 */
export function StatusShape({ tone }: { tone: Tone }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {shapes[tone]}
    </svg>
  );
}

const line = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const shapes: Record<Tone, React.ReactNode> = {
  info: <circle cx="6" cy="6" r="4" fill="currentColor" />,
  progress: (
    <>
      <circle cx="6" cy="6" r="4" {...line} strokeWidth="1.5" />
      <path d="M6 2 A4 4 0 0 1 6 10 Z" fill="currentColor" />
    </>
  ),
  success: <path d="M2.5 6.2 L5 8.6 L9.5 3.6" {...line} strokeWidth="1.8" />,
  warning: (
    <>
      <circle cx="6" cy="6" r="4.2" {...line} strokeWidth="1.4" />
      <path d="M6 3.8 V6.2 L7.6 7.2" {...line} strokeWidth="1.4" />
    </>
  ),
  danger: (
    <>
      <path d="M6 2.5 V7" {...line} strokeWidth="1.8" />
      <circle cx="6" cy="9.6" r="1.1" fill="currentColor" />
    </>
  ),
  neutral: <circle cx="6" cy="6" r="3.6" {...line} strokeWidth="1.5" />,
};
