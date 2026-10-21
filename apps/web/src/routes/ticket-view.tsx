import {
  SETTABLE_TICKET_STATUSES,
  TICKET_BODY_MAX,
  ticketDetailSchema,
  type TicketDetail,
  type TicketMessage,
  type TicketStatus,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute } from '@tanstack/react-router';
import { Link2, Unlink } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { FilterTabs } from '@/components/filter-tabs';
import { LinkAssetDialog, textareaClasses, useTicketSaved } from '@/components/ticket-dialogs';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiRequest } from '@/lib/api';
import { assetStatusLabels, assetStatusTones } from '@/lib/assets';
import { sessionQuery, ticketAssigneesQuery, ticketQuery } from '@/lib/queries';
import {
  describeTicketEvent,
  formatDateTime,
  requesterLabel,
  ticketRef,
  ticketSourceLabels,
  ticketSourceNames,
  ticketStatusLabels,
  ticketStatusTones,
} from '@/lib/tickets';
import { cn } from '@/lib/utils';
import { authedRoute } from './authed';

export const ticketViewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/tickets/$ticketId',
  component: TicketPage,
});

/** A change to the ticket that refreshes it and the lists. */
function useTicketChange(ticketId: string) {
  const saved = useTicketSaved();
  return useMutation({
    mutationFn: ({
      method,
      path,
      body,
    }: {
      method: 'POST' | 'PATCH' | 'DELETE';
      path: string;
      body?: object;
    }) =>
      apiRequest(method, `/api/tickets/${ticketId}${path}`, {
        ...(body ? { body } : {}),
        schema: ticketDetailSchema,
      }),
    onSuccess: saved,
  });
}

/** Clears the unread dot once the ticket has been seen. */
function useMarkRead(ticket: TicketDetail | undefined) {
  const queryClient = useQueryClient();
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!ticket?.unread || marked.current === ticket.lastActivityAt) return;
    marked.current = ticket.lastActivityAt;
    void apiRequest('POST', `/api/tickets/${ticket.id}/read`).then(() => {
      queryClient.setQueryData(ticketQuery(ticket.id).queryKey, (prev) =>
        prev ? { ...prev, unread: false } : prev,
      );
      return queryClient.invalidateQueries({ queryKey: ['tickets', 'list'] });
    });
  }, [ticket, queryClient]);
}

function TicketPage() {
  const { ticketId } = ticketViewRoute.useParams();
  const ticket = useQuery(ticketQuery(ticketId));
  const change = useTicketChange(ticketId);
  const [linking, setLinking] = useState(false);
  useMarkRead(ticket.data);

  if (ticket.isPending) return <p className="m-0 text-ink-muted">Loading ticket…</p>;
  if (ticket.error) return <ErrorMessage error={ticket.error} />;
  const t = ticket.data;

  return (
    <>
      <nav aria-label="Breadcrumb" className="type-caption text-ink-muted">
        <Link to="/tickets" activeOptions={{ exact: true }}>
          Tickets
        </Link>{' '}
        <span aria-hidden="true">/</span> <span className="type-id">{ticketRef(t.number)}</span>
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2">
          <p className="m-0 type-caption text-ink-muted">
            <span className="type-id">{ticketRef(t.number)}</span> · {ticketSourceLabels[t.source]}{' '}
            · opened {formatDateTime(t.createdAt)}
          </p>
          <h1 className="m-0 type-title break-words">{t.subject}</h1>
          <div>
            <StatusBadge tone={ticketStatusTones[t.status]}>
              {ticketStatusLabels[t.status]}
            </StatusBadge>
          </div>
        </div>
        <TicketControls ticket={t} change={change} />
      </header>
      <ErrorMessage error={change.error} />

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-6">
          <section aria-labelledby="conversation" className="flex flex-col gap-4">
            <h2 id="conversation" className="m-0 type-heading">
              Conversation
            </h2>
            {t.messages.map((m) => (
              <Message key={m.id} message={m} source={t.source} />
            ))}
          </section>
          <Composer ticket={t} />
        </div>
        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-6">
          <RequesterCard ticket={t} />
          <Card className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="m-0 type-heading">Linked assets</h2>
              <Button size="sm" onClick={() => setLinking(true)}>
                <Link2 aria-hidden="true" strokeWidth={1.75} />
                Link asset
              </Button>
            </div>
            {t.linkedAssets.length === 0 && (
              <p className="m-0 text-ink-muted">
                No assets linked. Link the laptop or printer this ticket is about.
              </p>
            )}
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {t.linkedAssets.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 flex-col gap-1">
                    <Link
                      to="/assets/$assetId"
                      params={{ assetId: a.id }}
                      className="type-id text-link"
                    >
                      {a.number}
                    </Link>
                    <span className="truncate">
                      {a.type} · {a.name}
                    </span>
                    <span>
                      <StatusBadge tone={assetStatusTones[a.status]}>
                        {assetStatusLabels[a.status]}
                      </StatusBadge>
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Unlink ${a.number}`}
                    title={`Unlink ${a.number}`}
                    disabled={change.isPending}
                    onClick={() => change.mutate({ method: 'DELETE', path: `/assets/${a.id}` })}
                  >
                    <Unlink aria-hidden="true" strokeWidth={1.75} />
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="m-0 type-heading">Details</h2>
            <dl className="m-0 flex flex-col gap-3">
              <Detail label="Source" value={ticketSourceNames[t.source]} />
              <Detail label="Created" value={formatDateTime(t.createdAt)} />
              <Detail
                label="First response"
                value={t.firstResponseAt ? formatDateTime(t.firstResponseAt) : 'Not yet'}
              />
              <Detail
                label="Last requester message"
                value={t.lastRequesterMessageAt ? formatDateTime(t.lastRequesterMessageAt) : '—'}
              />
            </dl>
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="m-0 type-heading">History</h2>
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {t.events.map((e) => (
                <li key={e.id} className="flex flex-col">
                  <span>{describeTicketEvent(e)}</span>
                  <span className="type-caption text-ink-muted">
                    {formatDateTime(e.at)} · {e.by?.name ?? 'System'}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>

      <LinkAssetDialog open={linking} ticket={t} onClose={() => setLinking(false)} />
    </>
  );
}

function TicketControls({
  ticket,
  change,
}: {
  ticket: TicketDetail;
  change: ReturnType<typeof useTicketChange>;
}) {
  const statusId = useId();
  const assigneeId = useId();
  const staff = useQuery(ticketAssigneesQuery);
  const session = useQuery(sessionQuery);
  const me = session.data?.user.id;
  // A disabled or removed assignee is still shown, though they cannot be chosen again.
  const people = [...(staff.data ?? [])];
  if (ticket.assignee && !people.some((p) => p.id === ticket.assignee?.id)) {
    people.unshift(ticket.assignee);
  }

  return (
    <div className="flex flex-wrap gap-4">
      <div className="flex w-48 flex-col gap-2">
        <Label htmlFor={statusId}>Status</Label>
        <Select
          id={statusId}
          value={ticket.status}
          disabled={change.isPending}
          onChange={(e) =>
            change.mutate({ method: 'PATCH', path: '', body: { status: e.target.value } })
          }
        >
          {ticket.status === 'new' && (
            <option value="new" disabled>
              New
            </option>
          )}
          {SETTABLE_TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ticketStatusLabels[s]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex w-48 flex-col gap-2">
        <Label htmlFor={assigneeId}>Assigned to</Label>
        <Select
          id={assigneeId}
          value={ticket.assignee?.id ?? ''}
          disabled={change.isPending}
          onChange={(e) =>
            change.mutate({
              method: 'PATCH',
              path: '',
              body: { assigneeId: e.target.value || null },
            })
          }
        >
          <option value="">Unassigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === me ? `${p.name} (you)` : p.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function Message({
  message: m,
  source,
}: {
  message: TicketMessage;
  source: TicketDetail['source'];
}) {
  const who =
    m.kind === 'inbound'
      ? m.from
        ? requesterLabel(m.from)
        : 'Requester'
      : (m.by?.name ?? 'System');
  const how =
    m.kind === 'inbound'
      ? source === 'email' && !m.by
        ? 'email from requester'
        : `entered by ${m.by?.name ?? 'the system'}`
      : m.kind === 'note'
        ? 'internal note, not emailed'
        : m.emailedAt
          ? 'reply sent by email'
          : 'reply, not emailed: no mailbox connected';
  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-4',
        m.kind === 'inbound' && 'border-line bg-surface-raised',
        m.kind === 'reply' && 'ml-8 border-line bg-surface-raised',
        m.kind === 'note' && 'border-dashed border-line-strong bg-surface-sunken',
      )}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <span className="font-semibold">{who}</span>{' '}
          <span className="type-caption text-ink-muted">· {how}</span>
        </span>
        <time dateTime={m.at} className="type-caption text-ink-muted">
          {formatDateTime(m.at)}
        </time>
      </header>
      <p className="m-0 break-words whitespace-pre-wrap">{m.body}</p>
    </article>
  );
}

type Mode = 'reply' | 'note';

function Composer({ ticket }: { ticket: TicketDetail }) {
  const id = useId();
  const hintId = useId();
  const [mode, setMode] = useState<Mode>('reply');
  const [body, setBody] = useState('');
  const change = useTicketChange(ticket.id);
  const to = requesterLabel(ticket.requester);

  function send(status?: TicketStatus) {
    change.mutate(
      {
        method: 'POST',
        path: '/messages',
        body: { kind: mode, body, ...(status ? { status } : {}) },
      },
      { onSuccess: () => setBody('') },
    );
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <h2 id={`${id}-heading`} className="m-0 type-heading">
        Respond
      </h2>
      <FilterTabs
        label="Respond with"
        current={mode}
        onChange={setMode}
        tabs={[
          { key: 'reply', label: 'Reply by email' },
          { key: 'note', label: 'Internal note' },
        ]}
      />
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <p id={hintId} className="m-0 type-caption text-ink-muted">
          {mode === 'reply'
            ? `To ${to} (${ticket.requester.email}). No mailbox is connected yet, so the reply is saved on the ticket but not emailed.`
            : 'Only technicians see internal notes. Nothing is emailed.'}
        </p>
        <Label htmlFor={id} className="sr-only">
          Message
        </Label>
        <textarea
          id={id}
          required
          rows={6}
          maxLength={TICKET_BODY_MAX}
          aria-describedby={hintId}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={textareaClasses}
          placeholder={mode === 'reply' ? `Write to ${to}` : 'Write a note for the team'}
        />
        <ErrorMessage error={change.error} />
        <div className="flex flex-wrap justify-end gap-2">
          {mode === 'reply' && (
            <Button
              disabled={change.isPending || body.trim() === ''}
              onClick={() => send('waiting_on_user')}
            >
              Send and set Waiting on user
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={change.isPending || body.trim() === ''}>
            {mode === 'reply' ? 'Send reply' : 'Add note'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function RequesterCard({ ticket }: { ticket: TicketDetail }) {
  const { requester } = ticket;
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="m-0 type-heading">Requester</h2>
      <p className="m-0 font-semibold">{requester.name || 'No name on file'}</p>
      <a href={`mailto:${requester.email}`} className="break-all">
        {requester.email}
      </a>
      <p className="m-0 type-caption text-ink-muted">
        {ticket.requesterOpenTickets === 0 ? (
          'No other open tickets'
        ) : (
          <Link to="/tickets" search={{ q: requester.email }}>
            {ticket.requesterOpenTickets} other open{' '}
            {ticket.requesterOpenTickets === 1 ? 'ticket' : 'tickets'}
          </Link>
        )}
      </p>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="type-caption text-ink-muted">{label}</dt>
      <dd className="m-0">{value}</dd>
    </div>
  );
}
