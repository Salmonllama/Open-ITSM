import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { Button } from './ui/button';
import { ErrorMessage } from './ui/card';

/**
 * A modal form on the native <dialog> element, like ConfirmDialog but with inputs, so the
 * browser checks required fields before `onSubmit` runs. The form data is passed to `onSubmit`.
 */
export function FormDialog({
  open,
  title,
  children,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  submitLabel: string;
  pending?: boolean;
  error?: unknown;
  onSubmit: (form: FormData) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onCancel}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface-raised p-0 text-ink shadow-overlay backdrop:bg-ink/40"
    >
      {/* Remount the form each time it opens so it starts empty. */}
      {open && (
        <form className="flex flex-col gap-4 p-6" onSubmit={submit}>
          <h2 id={titleId} className="m-0 type-title">
            {title}
          </h2>
          {children}
          <ErrorMessage error={error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {submitLabel}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
