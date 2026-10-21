import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ticketFixtures } from './fixtures/tickets.js';
import { makeApp } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, issueToken, signIn, withToken } from './helpers/seed.js';

type Session = Awaited<ReturnType<typeof signIn>>;
type Actor = { kind: string; name: string } | null;
type Detail = {
  id: string;
  number: number;
  subject: string;
  status: string;
  source: string;
  requester: { id: string; name: string; email: string };
  unread: boolean;
  linkedAssets: { id: string; number: string }[];
  assignee: { id: string; name: string } | null;
  firstResponseAt: string | null;
  requesterOpenTickets: number;
  messages: {
    kind: string;
    body: string;
    by: Actor;
    from: { name: string; email: string } | null;
    emailedAt: string | null;
  }[];
  events: {
    kind: string;
    fromStatus: string | null;
    toStatus: string | null;
    fromAssignee: { id: string; name: string } | null;
    toAssignee: { id: string; name: string } | null;
    asset: { id: string | null; number: string } | null;
    by: Actor;
  }[];
};
type List = {
  items: { number: number; subject: string; status: string; unread: boolean }[];
  total: number;
  counts: Record<string, number>;
};

describe.skipIf(!testDatabaseUrl)('tickets', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let tech: Session;
  let admin: Session;
  let techId: string;
  let otherId: string;
  let disabledId: string;
  let typeId: string | undefined;

  function send(
    session: Session,
    method: 'POST' | 'PATCH',
    url: string,
    payload: object,
  ): ReturnType<Session['request']> {
    return session.request({ method, url, payload });
  }

  async function open(
    fixture: keyof typeof ticketFixtures = 'printer',
    session = tech,
  ): Promise<Detail> {
    const res = await send(session, 'POST', '/api/tickets', ticketFixtures[fixture]);
    if (res.statusCode !== 201) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json();
  }

  async function list(query: string, session = tech): Promise<List> {
    const res = await session.request({ method: 'GET', url: `/api/tickets?${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  /** Empties the ticket tables (bypassing the append-only triggers) for tests that count. */
  async function clearTickets() {
    await t.pool.query('alter table ticket_messages disable trigger user');
    await t.pool.query('alter table ticket_events disable trigger user');
    await t.pool.query(
      'delete from ticket_messages; delete from ticket_events; delete from ticket_assets; delete from ticket_reads; delete from tickets',
    );
    await t.pool.query('alter table ticket_messages enable trigger user');
    await t.pool.query('alter table ticket_events enable trigger user');
  }

  let assetSeq = 0;
  async function newAsset(name = 'Floor 2 printer'): Promise<string> {
    if (!typeId) {
      const type = await send(tech, 'POST', '/api/asset-types', { name: 'Printer', prefix: 'PRN' });
      typeId = type.json().id;
    }
    assetSeq += 1;
    const res = await send(tech, 'POST', '/api/assets', { typeId, name: `${name} ${assetSeq}` });
    if (res.statusCode !== 201) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json().id;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await createUser(t.db, 'root@example.com', 'admin');
    techId = (await createUser(t.db, 'tech@example.com', 'technician')).id;
    otherId = (await createUser(t.db, 'rivera@example.com', 'technician')).id;
    disabledId = (await createUser(t.db, 'gone@example.com', 'technician')).id;
    await t.pool.query('update users set disabled_at = now() where id = $1', [disabledId]);
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });
  beforeEach(async () => {
    await app?.close();
    app = await makeApp({ db: t.db });
    tech = await signIn(app, 'tech@example.com');
    admin = await signIn(app, 'root@example.com');
  });

  describe('acceptance', () => {
    it('a technician opens, replies to, assigns and closes a ticket from a fixture', async () => {
      const created = await open('printer');
      expect(created).toMatchObject({
        status: 'new',
        source: 'dashboard',
        subject: ticketFixtures.printer.subject,
        requester: { name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
        assignee: null,
      });
      expect(created.messages).toEqual([
        expect.objectContaining({
          kind: 'inbound',
          body: ticketFixtures.printer.message,
          from: { name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
          by: { kind: 'user', name: 'tech' },
        }),
      ]);

      const opened = await tech.request({ method: 'GET', url: `/api/tickets/${created.id}` });
      expect(opened.statusCode).toBe(200);
      expect(opened.json().number).toBe(created.number);

      const replied = await send(tech, 'POST', `/api/tickets/${created.id}/messages`, {
        kind: 'reply',
        body: 'Thanks Dana, I am on my way.',
      });
      expect(replied.statusCode, replied.body).toBe(200);
      const afterReply: Detail = replied.json();
      expect(afterReply.status).toBe('in_progress');
      expect(afterReply.firstResponseAt).not.toBeNull();
      expect(afterReply.messages.at(-1)).toMatchObject({
        kind: 'reply',
        emailedAt: null,
        by: { kind: 'user', name: 'tech' },
      });

      const assigned = await send(tech, 'PATCH', `/api/tickets/${created.id}`, {
        assigneeId: otherId,
      });
      expect(assigned.statusCode, assigned.body).toBe(200);
      expect(assigned.json().assignee).toEqual({ id: otherId, name: 'rivera' });

      const closed = await send(tech, 'PATCH', `/api/tickets/${created.id}`, { status: 'closed' });
      expect(closed.statusCode).toBe(200);
      const final: Detail = closed.json();
      expect(final.status).toBe('closed');
      expect(
        final.events.map((e) => [e.kind, e.fromStatus, e.toStatus, e.toAssignee?.name ?? null]),
      ).toEqual([
        ['status', 'in_progress', 'closed', null],
        ['assignee', null, null, 'rivera'],
        ['status', 'new', 'in_progress', null],
        ['created', null, 'new', null],
      ]);
      expect(final.events.every((e) => e.by?.name === 'tech')).toBe(true);
    });

    it('a tickets:write token does the same, attributed to its service account', async () => {
      const { token } = await issueToken(admin, ['tickets:read', 'tickets:write'], 'helpdesk-bot');
      const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
        withToken(app, token, { method, url, ...(payload ? { payload } : {}) });

      const created = await call('POST', '/api/tickets', ticketFixtures.vpn);
      expect(created.statusCode, created.body).toBe(201);
      const ticket: Detail = created.json();
      expect(ticket.source).toBe('api');
      expect(ticket.messages[0]?.by).toEqual({ kind: 'service_account', name: 'helpdesk-bot' });

      expect((await call('GET', `/api/tickets/${ticket.id}`)).statusCode).toBe(200);
      const byNumber = await call('GET', `/api/tickets/by-number/${ticket.number}`);
      expect(byNumber.json().id).toBe(ticket.id);

      expect(
        (
          await call('POST', `/api/tickets/${ticket.id}/messages`, {
            kind: 'reply',
            body: 'On it.',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await call('PATCH', `/api/tickets/${ticket.id}`, { assigneeId: techId })).statusCode,
      ).toBe(200);
      const closed = await call('PATCH', `/api/tickets/${ticket.id}`, { status: 'closed' });
      expect(closed.statusCode).toBe(200);

      const final: Detail = closed.json();
      expect(final.status).toBe('closed');
      expect(final.assignee?.id).toBe(techId);
      expect(final.messages.map((m) => m.by)).toEqual([
        { kind: 'service_account', name: 'helpdesk-bot' },
        { kind: 'service_account', name: 'helpdesk-bot' },
      ]);
      expect(final.events).toHaveLength(4);
      for (const e of final.events) {
        expect(e.by).toEqual({ kind: 'service_account', name: 'helpdesk-bot' });
      }
      const { rows } = await t.pool.query(
        "select count(*)::int as n from audit_log where action = 'token.request'",
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(4);
    });

    it('a token with only asset scopes is refused on every ticket endpoint', async () => {
      const ticket = await open('vpn');
      const { token } = await issueToken(admin, ['assets:read', 'assets:write']);
      const assetId = await newAsset();
      const endpoints: [
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: object,
      ][] = [
        ['GET', '/api/tickets'],
        ['GET', '/api/tickets/assignees'],
        ['GET', '/api/requesters'],
        ['POST', `/api/tickets/${ticket.id}/read`],
        ['POST', `/api/tickets/${ticket.id}/assets`, { assetId }],
        ['DELETE', `/api/tickets/${ticket.id}/assets/${assetId}`],
        ['GET', `/api/tickets/by-number/${ticket.number}`],
        ['GET', `/api/tickets/${ticket.id}`],
        ['POST', '/api/tickets', ticketFixtures.laptop],
        ['PATCH', `/api/tickets/${ticket.id}`, { status: 'closed' }],
        ['POST', `/api/tickets/${ticket.id}/messages`, { kind: 'note', body: 'x' }],
      ];

      // Every ticket route in the API document is in the list above.
      const docs = await tech.request({ method: 'GET', url: '/api/docs/json' });
      const documented = Object.entries(docs.json().paths as Record<string, object>)
        .filter(([path]) => path.startsWith('/api/tickets') || path.startsWith('/api/requesters'))
        .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
        .sort();
      const covered = endpoints
        .map(([method, url]) =>
          `${method} ${url.replace(ticket.id, '{id}').replace(assetId, '{assetId}').replace(`/${ticket.number}`, '/{number}')}`.replace(
            /\?.*/,
            '',
          ),
        )
        .sort();
      expect(covered).toEqual(documented);

      for (const [method, url, payload] of endpoints) {
        const res = await withToken(app, token, { method, url, ...(payload ? { payload } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
      const after = await tech.request({ method: 'GET', url: `/api/tickets/${ticket.id}` });
      expect(after.json().status).toBe('new');
    });
  });

  it('write does not imply read for tokens', async () => {
    const { token } = await issueToken(admin, ['tickets:write']);
    const created = await withToken(app, token, {
      method: 'POST',
      url: '/api/tickets',
      payload: ticketFixtures.laptop,
    });
    expect(created.statusCode).toBe(201);
    const read = await withToken(app, token, { method: 'GET', url: '/api/tickets' });
    expect(read.statusCode).toBe(403);
  });

  it('numbers tickets from 1 upward', async () => {
    const a = await open('printer');
    const b = await open('vpn');
    expect(a.number).toBeGreaterThanOrEqual(1);
    expect(b.number).toBe(a.number + 1);
    const { rows } = await t.pool.query('select min(number)::int as n from tickets');
    expect(rows[0].n).toBe(1);
  });

  it('assigns only active staff, and assigning a New ticket starts it', async () => {
    const ticket = await open('laptop');
    for (const assigneeId of [disabledId, '00000000-0000-4000-8000-000000000000']) {
      const res = await send(tech, 'PATCH', `/api/tickets/${ticket.id}`, { assigneeId });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('assignee_not_staff');
    }
    const assignees = await tech.request({ method: 'GET', url: '/api/tickets/assignees' });
    expect(assignees.json().map((u: { name: string }) => u.name)).toEqual([
      'rivera',
      'root',
      'tech',
    ]);

    const assigned: Detail = (
      await send(tech, 'PATCH', `/api/tickets/${ticket.id}`, { assigneeId: techId })
    ).json();
    expect(assigned.status).toBe('in_progress');

    const unassigned: Detail = (
      await send(tech, 'PATCH', `/api/tickets/${ticket.id}`, { assigneeId: null })
    ).json();
    expect(unassigned.assignee).toBeNull();
    expect(unassigned.status).toBe('in_progress');
    expect(unassigned.events[0]).toMatchObject({
      kind: 'assignee',
      fromAssignee: { id: techId, name: 'tech' },
      toAssignee: null,
    });
  });

  it('notes never change the status; a reply can set Waiting on user; closed reopens', async () => {
    const ticket = await open('printer');
    const noted: Detail = (
      await send(tech, 'POST', `/api/tickets/${ticket.id}/messages`, {
        kind: 'note',
        body: 'Probably the fuser again.',
      })
    ).json();
    expect(noted.status).toBe('new');
    expect(noted.firstResponseAt).toBeNull();

    const waiting: Detail = (
      await send(tech, 'POST', `/api/tickets/${ticket.id}/messages`, {
        kind: 'reply',
        body: 'Does it still jam after a restart?',
        status: 'waiting_on_user',
      })
    ).json();
    expect(waiting.status).toBe('waiting_on_user');
    expect(waiting.events[0]).toMatchObject({ fromStatus: 'new', toStatus: 'waiting_on_user' });

    await send(tech, 'PATCH', `/api/tickets/${ticket.id}`, { status: 'closed' });
    const reopened = await send(tech, 'PATCH', `/api/tickets/${ticket.id}`, {
      status: 'in_progress',
    });
    expect(reopened.json().status).toBe('in_progress');

    // Setting the status it already has records nothing.
    const same: Detail = (
      await send(tech, 'PATCH', `/api/tickets/${ticket.id}`, { status: 'in_progress' })
    ).json();
    expect(same.events.filter((e) => e.kind === 'status')).toHaveLength(3);

    const refused = await send(tech, 'PATCH', `/api/tickets/${ticket.id}`, { status: 'new' });
    expect(refused.statusCode).toBe(400);
    const empty = await send(tech, 'POST', `/api/tickets/${ticket.id}/messages`, {
      kind: 'reply',
      body: '   ',
    });
    expect(empty.statusCode).toBe(400);
  });

  it('lists queues with counts, searches and counts the requester’s other tickets', async () => {
    await clearTickets();

    const printer = await open('printer');
    const vpn = await open('vpn');
    const laptop = await open('laptop');
    await send(tech, 'PATCH', `/api/tickets/${vpn.id}`, { assigneeId: techId });
    await send(tech, 'PATCH', `/api/tickets/${laptop.id}`, { status: 'waiting_on_user' });
    await send(tech, 'PATCH', `/api/tickets/${printer.id}`, { status: 'resolved' });

    const all = await list('');
    expect(all.items.map((i) => i.number)).toEqual([laptop.number, vpn.number]);
    expect(all.counts).toEqual({ open: 2, unassigned: 1, mine: 1, waiting: 1, closed: 1 });
    expect((await list('queue=closed')).items.map((i) => i.number)).toEqual([printer.number]);
    expect((await list('queue=mine')).items.map((i) => i.number)).toEqual([vpn.number]);
    expect((await list('queue=unassigned')).items.map((i) => i.number)).toEqual([laptop.number]);
    expect((await list('queue=open&status=waiting_on_user')).total).toBe(1);
    expect((await list('queue=open&assignee=none')).total).toBe(1);
    expect((await list(`queue=open&assignee=${techId}`)).total).toBe(1);
    expect((await list('queue=open&source=api')).total).toBe(0);

    expect((await list(`q=%23${vpn.number}`)).items.map((i) => i.number)).toEqual([vpn.number]);
    expect((await list('q=okafor')).total).toBe(1);
    expect((await list('q=dana&queue=closed')).total).toBe(1);
    expect((await list('q=dana')).counts).toMatchObject({ open: 1, closed: 1 });

    const { token } = await issueToken(admin, ['tickets:read']);
    const mine = await withToken(app, token, { method: 'GET', url: '/api/tickets?queue=mine' });
    expect(mine.json()).toMatchObject({ total: 0, counts: { mine: 0, open: 2 } });

    const detail = await tech.request({ method: 'GET', url: `/api/tickets/${printer.id}` });
    expect(detail.json().requesterOpenTickets).toBe(1);
  });

  it('ticket history is append only', async () => {
    const ticket = await open('vpn');
    await send(tech, 'POST', `/api/tickets/${ticket.id}/messages`, { kind: 'reply', body: 'Hi' });
    const id = ticket.id;
    await expect(
      t.pool.query('update ticket_events set at = now() where ticket_id = $1', [id]),
    ).rejects.toThrow(/append only/);
    await expect(
      t.pool.query('delete from ticket_events where ticket_id = $1', [id]),
    ).rejects.toThrow(/append only/);
    await expect(t.pool.query('truncate ticket_events')).rejects.toThrow(/append only/);
    await expect(
      t.pool.query("update ticket_messages set body = 'edited' where ticket_id = $1", [id]),
    ).rejects.toThrow(/append only/);
    await expect(
      t.pool.query('delete from ticket_messages where ticket_id = $1', [id]),
    ).rejects.toThrow(/append only/);
    await expect(t.pool.query('truncate ticket_messages')).rejects.toThrow(/append only/);

    // M7 records once when a reply was emailed; nothing else about a message changes.
    const sent =
      "update ticket_messages set emailed_at = now() where ticket_id = $1 and kind = 'reply'";
    await expect(t.pool.query(sent, [id])).resolves.toMatchObject({ rowCount: 1 });
    await expect(t.pool.query(sent, [id])).rejects.toThrow(/append only/);
    await expect(
      t.pool.query(
        "update ticket_messages set emailed_at = now() where ticket_id = $1 and kind = 'inbound'",
        [id],
      ),
    ).rejects.toThrow(/ticket_messages_only_replies_emailed/);
  });

  it('tickets from the same email share one requester', async () => {
    await clearTickets();
    const printer = await open('printer');
    const laptop = await open('laptop');
    expect(laptop.requester.id).toBe(printer.requester.id);
    expect(laptop.requester.email).toBe('dana.whitfield@example.com');
    expect(laptop.requesterOpenTickets).toBe(1);

    const found = await tech.request({ method: 'GET', url: '/api/requesters?q=whitfield' });
    expect(found.json()).toEqual([
      { id: printer.requester.id, name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
    ]);

    // A blank name is filled in later; a known name is kept.
    const blank = await send(tech, 'POST', '/api/tickets', {
      ...ticketFixtures.vpn,
      requester: { email: 'new.person@example.com' },
    });
    expect(blank.json().requester.name).toBe('');
    const named = await send(tech, 'POST', '/api/tickets', {
      ...ticketFixtures.vpn,
      requester: { name: 'New Person', email: 'NEW.person@example.com' },
    });
    expect(named.json().requester).toMatchObject({
      id: blank.json().requester.id,
      name: 'New Person',
    });
    const renamed = await send(tech, 'POST', '/api/tickets', {
      ...ticketFixtures.vpn,
      requester: { name: 'Someone Else', email: 'new.person@example.com' },
    });
    expect(renamed.json().requester.name).toBe('New Person');
    const unnamed = await send(tech, 'POST', '/api/tickets', {
      ...ticketFixtures.vpn,
      requester: { email: 'new.person@example.com' },
    });
    // The first message takes the name on file when none was given.
    expect(unnamed.json().messages[0].from).toEqual({
      name: 'New Person',
      email: 'new.person@example.com',
    });
  });

  it('links and unlinks assets, keeping a record and finding tickets by asset number', async () => {
    const first = await newAsset();
    const second = await newAsset();
    const ticket: Detail = (
      await send(tech, 'POST', '/api/tickets', { ...ticketFixtures.printer, assetIds: [first] })
    ).json();
    expect(ticket.linkedAssets.map((a) => a.id)).toEqual([first]);

    const missing = await send(tech, 'POST', '/api/tickets', {
      ...ticketFixtures.printer,
      assetIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toBe('asset_not_found');

    const linked: Detail = (
      await send(tech, 'POST', `/api/tickets/${ticket.id}/assets`, { assetId: second })
    ).json();
    expect(linked.linkedAssets.map((a) => a.id)).toEqual([first, second]);
    const again: Detail = (
      await send(tech, 'POST', `/api/tickets/${ticket.id}/assets`, { assetId: second })
    ).json();
    expect(again.events.filter((e) => e.kind === 'asset_linked')).toHaveLength(2);

    const number = linked.linkedAssets[1]?.number ?? '';
    expect((await list(`q=${encodeURIComponent(number)}`)).items.map((i) => i.number)).toContain(
      ticket.number,
    );

    const unlinked = await tech.request({
      method: 'DELETE',
      url: `/api/tickets/${ticket.id}/assets/${second}`,
    });
    expect(unlinked.statusCode).toBe(200);
    const after: Detail = unlinked.json();
    expect(after.linkedAssets.map((a) => a.id)).toEqual([first]);
    expect(after.events[0]).toMatchObject({
      kind: 'asset_unlinked',
      asset: { id: second, number },
      by: { kind: 'user', name: 'tech' },
    });

    // Deleting an asset entered by mistake unlinks it; the history keeps its number.
    expect((await tech.request({ method: 'DELETE', url: `/api/assets/${first}` })).statusCode).toBe(
      204,
    );
    const final: Detail = (
      await tech.request({ method: 'GET', url: `/api/tickets/${ticket.id}` })
    ).json();
    expect(final.linkedAssets).toEqual([]);
    expect(
      final.events.find((e) => e.kind === 'asset_linked' && e.asset?.id === null),
    ).toBeTruthy();
  });

  it('shows a ticket as unread until you open it or work on it', async () => {
    await clearTickets();
    const mine = await open('printer');
    const theirs = await open('vpn', admin);
    expect(mine.unread).toBe(false);

    const unread = async () => (await list('')).items.filter((i) => i.unread).map((i) => i.number);
    expect(await unread()).toEqual([theirs.number]);

    const read = await tech.request({ method: 'POST', url: `/api/tickets/${theirs.id}/read` });
    expect(read.statusCode).toBe(204);
    expect(await unread()).toEqual([]);

    // A requester message after you last opened it makes it unread again (M7 adds these).
    await t.pool.query(
      "update tickets set last_requester_message_at = now() + interval '1 second' where id = $1",
      [theirs.id],
    );
    expect(await unread()).toEqual([theirs.number]);
    await send(tech, 'POST', `/api/tickets/${theirs.id}/messages`, { kind: 'note', body: 'Seen' });
    // Working on it marks it read only up to now, so the future-dated message still counts.
    expect(await unread()).toEqual([theirs.number]);

    const { token } = await issueToken(admin, ['tickets:read']);
    const viaToken = await withToken(app, token, { method: 'GET', url: '/api/tickets' });
    expect(viaToken.json().items.every((i: { unread: boolean }) => !i.unread)).toBe(true);
  });
});
