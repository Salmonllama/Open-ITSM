import {
  ticketDetailSchema,
  TICKET_BODY_MAX,
  TICKET_SUBJECT_MAX,
  type TicketDetail,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { assetStatusLabels } from '@/lib/assets';
import { assetsQuery, requestersQuery, ticketQuery } from '@/lib/queries';
import { FormDialog } from './form-dialog';
import { FormField } from './form-field';
import { SearchField } from './search-field';
import { Button } from './ui/button';
import { ErrorMessage } from './ui/card';
import { Label } from './ui/input';

export const textareaClasses =
  'w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 type-body text-ink focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent';

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

/** Stores a changed ticket and refreshes the lists and counts that show it. */
export function useTicketSaved() {
  const queryClient = useQueryClient();
  return async (saved: TicketDetail) => {
    queryClient.setQueryData(ticketQuery(saved.id).queryKey, saved);
    await queryClient.invalidateQueries({ queryKey: ['tickets', 'list'] });
  };
}

/** Opens a ticket for a requester, with what they asked as its first message. */
export function NewTicketDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (ticket: TicketDetail) => void;
}) {
  const bodyId = useId();
  const listId = useId();
  const [email, setEmail] = useState('');
  const requesters = useQuery({ ...requestersQuery(email.trim()), enabled: open });
  const saved = useTicketSaved();
  const create = useMutation({
    mutationFn: (body: object) =>
      apiRequest('POST', '/api/tickets', { body, schema: ticketDetailSchema }),
    onSuccess: async (ticket) => {
      await saved(ticket);
      setEmail('');
      onClose();
      onCreated(ticket);
    },
  });
  const known = requesters.data?.find((r) => r.email === email.trim().toLowerCase());

  return (
    <FormDialog
      open={open}
      title="New ticket"
      submitLabel="Open ticket"
      pending={create.isPending}
      error={create.error}
      onCancel={() => {
        create.reset();
        onClose();
      }}
      onSubmit={(form) =>
        create.mutate({
          subject: text(form, 'subject'),
          requester: { email: text(form, 'email'), name: text(form, 'name') },
          message: text(form, 'message'),
        })
      }
    >
      <FormField
        label="Requester email"
        name="email"
        type="email"
        required
        autoComplete="off"
        maxLength={254}
        list={listId}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        hint={
          known
            ? `${known.name || 'No name on file'}. Their earlier tickets stay linked.`
            : 'Who asked for help.'
        }
      />
      <datalist id={listId}>
        {requesters.data?.map((r) => (
          <option key={r.id} value={r.email}>
            {r.name}
          </option>
        ))}
      </datalist>
      <FormField
        label="Requester name (optional)"
        name="name"
        autoComplete="off"
        maxLength={200}
        hint="A name already on file is kept."
      />
      <FormField
        label="Subject"
        name="subject"
        required
        autoComplete="off"
        maxLength={TICKET_SUBJECT_MAX}
        hint="A short summary, like Printer on floor 2 jams."
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor={bodyId}>What they asked</Label>
        <textarea
          id={bodyId}
          name="message"
          required
          rows={5}
          maxLength={TICKET_BODY_MAX}
          className={textareaClasses}
        />
      </div>
    </FormDialog>
  );
}

/** Finds an asset by number or name and links it to the ticket. */
export function LinkAssetDialog({
  open,
  ticket,
  onClose,
}: {
  open: boolean;
  ticket: TicketDetail;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const results = useQuery({ ...assetsQuery({ q, pageSize: 8 }), enabled: open && q !== '' });
  const saved = useTicketSaved();
  const link = useMutation({
    mutationFn: (assetId: string) =>
      apiRequest('POST', `/api/tickets/${ticket.id}/assets`, {
        body: { assetId },
        schema: ticketDetailSchema,
      }),
    onSuccess: async (result) => {
      await saved(result);
      setQ('');
      onClose();
    },
  });
  const linked = new Set(ticket.linkedAssets.map((a) => a.id));
  const items = results.data?.items ?? [];

  return (
    <FormDialog
      open={open}
      title={`Link an asset to #${ticket.number}`}
      submitLabel="Done"
      onCancel={() => {
        link.reset();
        setQ('');
        onClose();
      }}
      onSubmit={() => {
        setQ('');
        onClose();
      }}
    >
      <SearchField value={q} onChange={setQ} placeholder="Asset number or name" />
      <ErrorMessage error={results.error ?? link.error} />
      {q !== '' && results.data && items.length === 0 && (
        <p className="m-0 text-ink-muted">No assets match. Try the number on its tag.</p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((asset) => (
          <li key={asset.id} className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="type-id">{asset.number}</span> {asset.name}
              <span className="block type-caption text-ink-muted">
                {asset.type.name} · {assetStatusLabels[asset.status]}
              </span>
            </span>
            <Button
              size="sm"
              disabled={linked.has(asset.id) || link.isPending}
              onClick={() => link.mutate(asset.id)}
            >
              {linked.has(asset.id) ? 'Linked' : 'Link'}
            </Button>
          </li>
        ))}
      </ul>
    </FormDialog>
  );
}
