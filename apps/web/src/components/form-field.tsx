import { useId, type InputHTMLAttributes } from 'react';
import { StatusShape } from './ui/status-shape';
import { Input, Label } from './ui/input';

/**
 * Design-system TextField: a visible label, the input, and a hint linked by aria-describedby.
 * An error replaces the hint, turns it danger and marks the input invalid.
 */
export function FormField({
  label,
  hint,
  error,
  mono,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
  mono?: boolean;
}) {
  const id = useId();
  const message = error ?? hint;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        mono={mono}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? `${id}-hint` : undefined}
        {...props}
      />
      {message && (
        <p
          id={`${id}-hint`}
          className={
            error
              ? 'flex items-center gap-1 type-caption text-danger'
              : 'type-caption text-ink-muted'
          }
        >
          {error && <StatusShape tone="danger" />}
          {message}
        </p>
      )}
    </div>
  );
}
