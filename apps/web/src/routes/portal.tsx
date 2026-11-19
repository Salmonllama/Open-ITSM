import {
  isOpenTicketStatus,
  portalTicketDetailSchema,
  TICKET_BODY_MAX,
  type PortalTicketDetail,
  type PortalTicketMessage,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { Download, LogOut } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Logo } from '@/components/logo';
import { ThemeSelect } from '@/components/theme-select';
import { textareaClasses } from '@/components/ticket-dialogs';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Label } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiRequest } from '@/lib/api';
import { formatBytes } from '@/lib/mail';
import {
  portalTicketQuery,
  portalTicketsQuery,
  sessionQuery,
  setupStatusQuery,
  storeSession,
} from '@/lib/queries';
import { formatDateTime, ticketRef, ticketStatusLabels, ticketStatusTones } from '@/lib/tickets';
import { rootRoute } from './root';

export const portalLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal',
  beforeLoad: async ({ context, location }) => {
    const setup = await context.queryClient.ensureQueryData(setupStatusQuery);
    if (setup.required) throw redirect({ to: '/setup' });
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session)
      throw redirect({ to: '/login', search: { redirect: location.href, ssoError: undefined } });
    if (session.user.role !== 'end_user') throw redirect({ to: '/tickets' });
    return { session };
  },
  component: PortalLayout,
});

export const portalTicketsRoute = createRoute({
  getParentRoute: () => portalLayoutRoute,
  path: '/',
  component: PortalTicketList,
});

export const portalTicketViewRoute = createRoute({
  getParentRoute: () => portalLayoutRoute,
  path: '/tickets/$ticketId',
  component: PortalTicketView,
});

function PortalLayout() {
  const { data: session } = useSuspenseQuery(sessionQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => apiRequest('POST', '/api/auth/logout'),
    onSettled: async () => {
      storeSession(queryClient, null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      await navigate({ to: '/login', search: { redirect: undefined, ssoError: undefined } });
    },
  });

  if (!session) return null;

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="border-b border-line bg-surface-sunken">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/portal" className="no-underline">
            <Logo />
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <span className="type-caption text-ink-muted">{session.user.email}</span>
            <ThemeSelect />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut aria-hidden="true" strokeWidth={1.75} />
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}

function PortalTicketList() {
  const list = useQuery(portalTicketsQuery);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">Your open tickets</h1>
        <p className="m-0 type-caption text-ink-muted">
          Open a ticket to read updates or send a reply.
        </p>
      </header>
      {list.isPending && <p className="m-0 text-ink-muted">Loading your tickets…</p>}
      <ErrorMessage error={list.error} />
      {list.data && list.data.items.length === 0 && (
        <Card>
          <p className="m-0 text-ink-muted">
            You have no open tickets right now. Send an email to IT support whenever you need help.
          </p>
        </Card>
      )}
      {list.data && list.data.items.length > 0 && (
        <div className="flex flex-col gap-3">
          {list.data.items.map((t) => (
            <Link
              key={t.id}
              to="/portal/tickets/$ticketId"
              params={{ ticketId: t.id }}
              className="block rounded-lg border border-line bg-surface-raised p-4 text-ink no-underline hover:border-line-strong"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="type-id text-ink-muted">{ticketRef(t.number)}</span>
                  <span className="type-heading break-words">{t.subject}</span>
                </div>
                <StatusBadge tone={ticketStatusTones[t.status]}>
                  {ticketStatusLabels[t.status]}
                </StatusBadge>
              </div>
              <p className="m-0 mt-2 type-caption text-ink-muted">
                Updated {formatDateTime(t.lastActivityAt)}
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function PortalTicketView() {
  const { ticketId } = portalTicketViewRoute.useParams();
  const ticket = useQuery(portalTicketQuery(ticketId));

  if (ticket.isPending) return <p className="m-0 text-ink-muted">Loading ticket…</p>;
  if (ticket.error) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/portal" className="type-label">
          Back to your tickets
        </Link>
        <ErrorMessage error={ticket.error} />
      </div>
    );
  }
  const t = ticket.data;

  return (
    <>
      <nav aria-label="Breadcrumb" className="type-caption text-ink-muted">
        <Link to="/portal">Your tickets</Link> <span aria-hidden="true">/</span>{' '}
        <span className="type-id">{ticketRef(t.number)}</span>
      </nav>
      <header className="flex flex-col gap-2">
        <p className="m-0 type-caption text-ink-muted">
          <span className="type-id">{ticketRef(t.number)}</span> · opened{' '}
          {formatDateTime(t.createdAt)}
        </p>
        <h1 className="m-0 type-title break-words">{t.subject}</h1>
        <div>
          <StatusBadge tone={ticketStatusTones[t.status]}>
            {ticketStatusLabels[t.status]}
          </StatusBadge>
        </div>
      </header>

      <section aria-labelledby="conversation" className="flex flex-col gap-4">
        <h2 id="conversation" className="m-0 type-heading">
          Conversation
        </h2>
        {t.messages.map((m) => (
          <PortalMessageCard key={m.id} message={m} ticketId={t.id} />
        ))}
      </section>

      {isOpenTicketStatus(t.status) ? (
        <PortalReplyComposer ticket={t} />
      ) : (
        <Card>
          <p className="m-0 text-ink-muted">
            This ticket is closed. Email IT support if you need more help.
          </p>
        </Card>
      )}
    </>
  );
}

function PortalMessageCard({
  message,
  ticketId,
}: {
  message: PortalTicketMessage;
  ticketId: string;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 type-label">
          {message.fromName}{' '}
          <span className="type-caption text-ink-muted">
            {message.kind === 'reply' ? '· IT support' : '· You'}
          </span>
        </p>
        <span className="type-caption text-ink-muted">{formatDateTime(message.at)}</span>
      </div>
      <p className="m-0 whitespace-pre-wrap break-words type-body">{message.body}</p>
      {message.attachments.length > 0 && (
        <ul className="m-0 flex flex-wrap gap-2 pl-0 list-none">
          {message.attachments.map((file) =>
            file.skippedReason ? (
              <li
                key={file.id}
                className="rounded-sm border border-line bg-surface-sunken px-2 py-1 type-caption text-ink-muted"
              >
                {file.name} ({file.skippedReason})
              </li>
            ) : (
              <li key={file.id}>
                <a
                  href={`/api/portal/tickets/${ticketId}/attachments/${file.id}`}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-sunken px-2 py-1 type-caption text-ink no-underline hover:border-line-strong"
                >
                  <Download aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                  <span>{file.name}</span>
                  <span className="text-ink-muted">{formatBytes(file.size)}</span>
                </a>
              </li>
            ),
          )}
        </ul>
      )}
    </Card>
  );
}

function PortalReplyComposer({ ticket }: { ticket: PortalTicketDetail }) {
  const [body, setBody] = useState('');
  const queryClient = useQueryClient();

  const send = useMutation({
    mutationFn: (text: string) =>
      apiRequest('POST', `/api/portal/tickets/${ticket.id}/messages`, {
        body: { body: text },
        schema: portalTicketDetailSchema,
      }),
    onSuccess: async (updated) => {
      setBody('');
      queryClient.setQueryData(portalTicketQuery(ticket.id).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: ['portal', 'tickets'] });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    send.mutate(trimmed);
  }

  return (
    <Card>
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Label htmlFor="portal-reply">Add a reply</Label>
        <textarea
          id="portal-reply"
          name="body"
          rows={4}
          required
          maxLength={TICKET_BODY_MAX}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your reply to IT support…"
          className={textareaClasses}
        />
        <ErrorMessage error={send.error} />
        <div>
          <Button type="submit" variant="primary" disabled={send.isPending || !body.trim()}>
            {send.isPending ? 'Sending…' : 'Send reply'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
