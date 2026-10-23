import {
  TICKET_SOURCES,
  TICKET_STATUSES,
  ticketQueueSchema,
  ticketSourceSchema,
  ticketStatusSchema,
  type TicketQueue,
  type TicketStatus,
  type TicketSummary,
} from '@open-itsm/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { FilterTabs } from '@/components/filter-tabs';
import { MailNotice } from '@/components/mail-notice';
import { PageHeader } from '@/components/page-header';
import { SearchField } from '@/components/search-field';
import { NewTicketDialog } from '@/components/ticket-dialogs';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { mailCaption } from '@/lib/mail';
import { mailStatusQuery, sessionQuery, ticketAssigneesQuery, ticketsQuery } from '@/lib/queries';
import {
  formatActivity,
  requesterLabel,
  ticketRef,
  ticketSourceNames,
  ticketStatusLabels,
  ticketStatusTones,
} from '@/lib/tickets';
import { cn } from '@/lib/utils';
import { authedRoute } from './authed';

const PAGE_SIZE = 25;

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  queue: ticketQueueSchema.optional().catch(undefined),
  status: ticketStatusSchema.optional().catch(undefined),
  assignee: z
    .union([z.literal('me'), z.literal('none'), z.uuid()])
    .optional()
    .catch(undefined),
  source: ticketSourceSchema.optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
});
type TicketSearch = z.infer<typeof searchSchema>;

export const ticketsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/tickets',
  validateSearch: searchSchema,
  component: TicketsPage,
});

const queueLabels: Record<TicketQueue, string> = {
  open: 'All open',
  unassigned: 'Unassigned',
  mine: 'Mine',
  waiting: 'Waiting on user',
  closed: 'Closed',
};

/** The statuses each queue can hold, for the Status filter. */
const queueStatuses: Record<TicketQueue, readonly TicketStatus[]> = {
  open: ['new', 'in_progress', 'waiting_on_user'],
  unassigned: ['new', 'in_progress', 'waiting_on_user'],
  mine: ['new', 'in_progress', 'waiting_on_user'],
  waiting: ['waiting_on_user'],
  closed: ['resolved', 'closed'],
};

function TicketsPage() {
  const search = ticketsRoute.useSearch();
  const navigate = useNavigate({ from: '/tickets' });
  const [creating, setCreating] = useState(false);
  const page = search.page ?? 1;
  const queue = search.queue ?? 'open';
  const list = useQuery(
    ticketsQuery({
      q: search.q,
      queue,
      status: search.status,
      assignee: search.assignee,
      source: search.source,
      page,
      pageSize: PAGE_SIZE,
    }),
  );

  /** Changes a filter and goes back to the first page. */
  function setFilter(changes: Partial<TicketSearch>) {
    void navigate({ search: (prev) => ({ ...prev, ...changes, page: undefined }), replace: true });
  }

  const data = list.data;
  const mail = useQuery(mailStatusQuery);
  const filtered = !!(search.q || search.status || search.assignee || search.source);
  const first = data && data.total > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = data ? Math.min(page * PAGE_SIZE, data.total) : 0;

  return (
    <>
      <PageHeader
        title="Tickets"
        caption={
          data &&
          `${data.counts.open} open · ${data.counts.unassigned} unassigned${mail.data ? ` · ${mailCaption(mail.data)}` : ''}`
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" strokeWidth={1.75} />
            New ticket
          </Button>
        }
      />
      <MailNotice />

      <FilterTabs
        label="Queue"
        current={queue}
        onChange={(key) =>
          setFilter({
            queue: key === 'open' ? undefined : key,
            // A status the new queue cannot hold would empty the list.
            status:
              search.status && queueStatuses[key].includes(search.status)
                ? search.status
                : undefined,
          })
        }
        tabs={ticketQueueSchema.options.map((key) => ({
          key,
          label: queueLabels[key],
          count: data?.counts[key],
        }))}
      />

      <div className="flex flex-wrap items-end gap-4">
        <SearchField
          value={search.q ?? ''}
          onChange={(q) => setFilter({ q: q || undefined })}
          placeholder="Ticket number, subject, requester or asset"
          className="flex-[3_1_280px]"
        />
        <Filter
          label="Status"
          value={search.status ?? ''}
          onChange={(v) => setFilter({ status: (v || undefined) as TicketStatus | undefined })}
        >
          <option value="">{queue === 'closed' ? 'Resolved or closed' : 'Any open status'}</option>
          {TICKET_STATUSES.filter((s) => queueStatuses[queue].includes(s)).map((s) => (
            <option key={s} value={s}>
              {ticketStatusLabels[s]}
            </option>
          ))}
        </Filter>
        <AssigneeFilter value={search.assignee} onChange={(assignee) => setFilter({ assignee })} />
        <Filter
          label="Source"
          value={search.source ?? ''}
          onChange={(v) =>
            setFilter({ source: (v || undefined) as TicketSearch['source'] | undefined })
          }
        >
          <option value="">Any source</option>
          {TICKET_SOURCES.map((s) => (
            <option key={s} value={s}>
              {ticketSourceNames[s]}
            </option>
          ))}
        </Filter>
      </div>

      <ErrorMessage error={list.error} />
      {list.isPending && <p className="m-0 text-ink-muted">Loading tickets…</p>}
      {data && (
        <>
          <ul className="m-0 list-none overflow-hidden rounded-lg border border-line p-0">
            {data.items.map((ticket) => (
              <li key={ticket.id} className="border-b border-line last:border-b-0">
                <TicketRow ticket={ticket} />
              </li>
            ))}
            {data.items.length === 0 && (
              <li className="bg-surface-raised px-4 py-3 text-ink-muted">
                {filtered
                  ? 'No tickets match these filters. Clear the search or choose another filter.'
                  : queue === 'open'
                    ? 'No open tickets. Open one with New ticket.'
                    : `No tickets in ${queueLabels[queue]}.`}
              </li>
            )}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="type-caption text-ink-muted">
              {data.total > 0
                ? `Showing ${first}–${last} of ${data.total} · newest activity first`
                : 'Showing 0 tickets'}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={page <= 1}
                onClick={() =>
                  void navigate({ search: (prev) => ({ ...prev, page: page - 1 || undefined }) })
                }
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={last >= data.total}
                onClick={() => void navigate({ search: (prev) => ({ ...prev, page: page + 1 }) })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <NewTicketDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(ticket) =>
          void navigate({ to: '/tickets/$ticketId', params: { ticketId: ticket.id } })
        }
      />
    </>
  );
}

/** One ticket in the list, following the design system's TicketRow. */
function TicketRow({ ticket }: { ticket: TicketSummary }) {
  return (
    <Link
      to="/tickets/$ticketId"
      params={{ ticketId: ticket.id }}
      className={cn(
        'grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-3 bg-surface-raised px-4 py-3 text-ink no-underline',
        'sm:grid-cols-[8px_64px_minmax(0,1fr)_auto_72px]',
        'hover:bg-surface-sunken hover:text-ink focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent',
      )}
    >
      <span
        className={cn('size-2 rounded-full', ticket.unread && 'bg-pine')}
        aria-label={ticket.unread ? 'Unread' : undefined}
        role={ticket.unread ? 'img' : undefined}
      />
      <span className="hidden type-id text-ink-muted sm:inline">{ticketRef(ticket.number)}</span>
      <span className="flex min-w-0 flex-col">
        <span className={cn('truncate', ticket.unread && 'font-semibold')}>
          <span className="type-id text-ink-muted sm:hidden">{ticketRef(ticket.number)} </span>
          {ticket.subject}
        </span>
        <span className="truncate type-caption text-ink-muted">
          {requesterLabel(ticket.requester)} ·{' '}
          {ticket.assignee ? `assigned to ${ticket.assignee.name}` : 'unassigned'}
          <span className="sm:hidden"> · {formatActivity(ticket.lastActivityAt)}</span>
        </span>
      </span>
      <StatusBadge tone={ticketStatusTones[ticket.status]}>
        {ticketStatusLabels[ticket.status]}
      </StatusBadge>
      <span className="hidden text-right type-caption text-ink-muted sm:inline">
        {formatActivity(ticket.lastActivityAt)}
      </span>
    </Link>
  );
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-[1_1_160px] flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </Select>
    </div>
  );
}

function AssigneeFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: TicketSearch['assignee']) => void;
}) {
  const staff = useQuery(ticketAssigneesQuery);
  const session = useQuery(sessionQuery);
  const me = session.data?.user.id;
  return (
    <Filter
      label="Assigned to"
      value={value ?? ''}
      onChange={(v) => onChange((v || undefined) as TicketSearch['assignee'])}
    >
      <option value="">Anyone</option>
      <option value="me">Me</option>
      <option value="none">Unassigned</option>
      {staff.data
        ?.filter((u) => u.id !== me)
        .map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
    </Filter>
  );
}
