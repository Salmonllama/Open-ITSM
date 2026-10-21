import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AttachmentStore } from '../src/attachments.js';
import type { MailService } from '../src/mail/service.js';
import { CLIENT_ID, FakeGraph, MAILBOX, SECRET, TENANT } from './fixtures/graph.js';
import { ticketFixtures } from './fixtures/tickets.js';
import { makeApp, makeMail } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, issueToken, signIn, withToken } from './helpers/seed.js';

type Session = Awaited<ReturnType<typeof signIn>>;
type Attachment = { id: string; name: string; size: number; skippedReason: string | null };
type Message = {
  id: number;
  kind: string;
  body: string;
  from: { name: string; email: string } | null;
  emailedAt: string | null;
  emailStatus: string | null;
  emailError: string | null;
  attachments: Attachment[];
};
type Detail = {
  id: string;
  number: number;
  subject: string;
  status: string;
  source: string;
  requester: { name: string; email: string };
  unread: boolean;
  messages: Message[];
  events: { kind: string; fromStatus: string | null; toStatus: string | null }[];
};

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;
const settingsBody = {
  tenantId: TENANT,
  clientId: CLIENT_ID,
  clientSecret: SECRET,
  secretExpiresOn: nextYear,
  mailbox: MAILBOX,
};

describe.skipIf(!testDatabaseUrl)('Microsoft 365 email', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let graph: FakeGraph;
  let mail: MailService;
  let store: AttachmentStore;
  let admin: Session;
  let tech: Session;

  function req(
    session: Session,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) {
    return session.request({
      method: method as 'POST',
      url,
      ...(payload ? { payload } : {}),
    });
  }

  async function connect(overrides: object = {}) {
    const res = await req(admin, 'PUT', '/api/settings/mail', { ...settingsBody, ...overrides });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function poll() {
    const result = await mail.poll();
    if (!result) throw new Error('the mailbox was not checked');
    return result;
  }

  async function ticketByNumber(number: number): Promise<Detail> {
    const res = await req(tech, 'GET', `/api/tickets/by-number/${number}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function newestTicket(): Promise<Detail> {
    const { rows } = await t.pool.query<{ number: number }>(
      'select number from tickets order by number desc limit 1',
    );
    if (!rows[0]) throw new Error('no tickets');
    return ticketByNumber(rows[0].number);
  }

  async function reply(ticket: Detail, body: string, extra: object = {}): Promise<Detail> {
    const res = await req(tech, 'POST', `/api/tickets/${ticket.id}/messages`, {
      kind: 'reply',
      body,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function upload(ticket: Detail, name: string, data: Buffer, type = 'application/pdf') {
    return tech.request({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/attachments?name=${encodeURIComponent(name)}`,
      payload: data,
      headers: { 'content-type': type },
    });
  }

  /** Clears tickets and mail settings between tests (bypassing the append-only triggers). */
  async function reset() {
    for (const table of ['ticket_messages', 'ticket_events', 'ticket_attachments']) {
      await t.pool.query(`alter table ${table} disable trigger user`);
    }
    await t.pool.query(
      'delete from ticket_attachments; delete from ticket_messages; delete from ticket_events; delete from ticket_assets; delete from ticket_reads; delete from tickets; delete from requesters; delete from settings',
    );
    for (const table of ['ticket_messages', 'ticket_events', 'ticket_attachments']) {
      await t.pool.query(`alter table ${table} enable trigger user`);
    }
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await createUser(t.db, 'root@example.com', 'admin');
    await createUser(t.db, 'tech@example.com', 'technician');
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });
  beforeEach(async () => {
    await reset();
    graph = new FakeGraph();
    ({ mail, store } = makeMail(t.db, { fetch: graph.fetch }));
    // The job queue, inline: checks and sends happen before the request returns.
    mail.queue = {
      poll: async () => {
        await mail.poll();
      },
      send: async (id) => {
        await mail.send(id, true);
      },
    };
    app = await makeApp({ db: t.db, mail, attachments: store });
    admin = await signIn(app, 'root@example.com');
    tech = await signIn(app, 'tech@example.com');
  });
  afterEach(async () => {
    await app.close();
  });

  describe('acceptance', () => {
    it('an email opens a ticket, the reply goes out as email, and the answer lands on the same ticket', async () => {
      await connect();
      graph.deliver({
        from: { name: 'Dana Whitfield', address: 'Dana.Whitfield@example.com' },
        subject: 'Printer on floor 2 jams',
        body: 'Since this morning the printer by the kitchen jams on every page.',
      });
      expect(await poll()).toMatchObject({ created: 1, appended: 0 });

      const ticket = await newestTicket();
      expect(ticket).toMatchObject({
        subject: 'Printer on floor 2 jams',
        source: 'email',
        status: 'new',
        unread: true,
        requester: { name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
      });
      expect(ticket.messages).toMatchObject([
        {
          kind: 'inbound',
          body: 'Since this morning the printer by the kitchen jams on every page.',
          from: { name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
        },
      ]);

      // A technician's reply arrives as email, threaded on her message, with the reference.
      const replied = await reply(ticket, 'I have ordered a new fuser. It should be fixed today.');
      expect(replied.status).toBe('in_progress');
      expect(replied.messages[1]).toMatchObject({
        kind: 'reply',
        emailStatus: 'sent',
        emailError: null,
      });
      expect(replied.messages[1]?.emailedAt).not.toBeNull();
      expect(graph.sent).toHaveLength(1);
      const sent = must(graph.sent[0]);
      expect(sent.subject).toBe(`RE: [#${ticket.number}] Printer on floor 2 jams`);
      expect(sent.to).toEqual([{ address: 'dana.whitfield@example.com', name: 'Dana Whitfield' }]);
      expect(sent.body).toBe('I have ordered a new fuser. It should be fixed today.');
      expect(sent.replyTo).toBe(graph.messages.find((m) => m.folder === 'inbox')?.id);
      expect(graph.drafts).toHaveLength(0);

      // Her answer comes back to the same ticket.
      graph.deliver({
        from: { name: 'Dana Whitfield', address: 'dana.whitfield@example.com' },
        subject: `RE: [#${ticket.number}] Printer on floor 2 jams`,
        body: 'Thank you!\n\n> I have ordered a new fuser.',
        uniqueBody: 'Thank you!',
        headers: [{ name: 'In-Reply-To', value: sent.internetMessageId }],
        conversationId: sent.conversationId,
      });
      expect(await poll()).toMatchObject({ created: 0, appended: 1 });
      const after = await ticketByNumber(ticket.number);
      expect(after.messages.map((m) => [m.kind, m.body])).toEqual([
        ['inbound', 'Since this morning the printer by the kitchen jams on every page.'],
        ['reply', 'I have ordered a new fuser. It should be fixed today.'],
        ['inbound', 'Thank you!'],
      ]);
      expect(after.unread).toBe(true);
      expect(await t.pool.query('select count(*)::int as n from tickets')).toMatchObject({
        rows: [{ n: 1 }],
      });
    });
  });

  describe('threading', () => {
    async function opened() {
      await connect();
      const first = graph.deliver({
        from: { address: 'sam.okafor@example.com', name: 'Sam Okafor' },
        subject: 'VPN drops',
        body: 'It keeps disconnecting.',
      });
      await poll();
      return { ticket: await newestTicket(), first };
    }

    it('matches by the [#N] reference first, even in a new conversation', async () => {
      const { ticket } = await opened();
      graph.deliver({
        from: { address: 'someone.else@example.com' },
        subject: `Fwd: [#${ticket.number}] VPN drops`,
        body: 'Same here.',
      });
      expect(await poll()).toMatchObject({ created: 0, appended: 1 });
    });

    it('matches by In-Reply-To or References when the subject lost the reference', async () => {
      const { ticket } = await opened();
      await reply(ticket, 'Try the new client.');
      const sent = must(graph.sent[0]);
      graph.deliver({
        from: { address: 'sam.okafor@example.com' },
        subject: 'Re: VPN drops',
        body: 'Still drops.',
        headers: [{ name: 'References', value: `<old@example.com> ${sent.internetMessageId}` }],
      });
      expect(await poll()).toMatchObject({ created: 0, appended: 1 });
      expect((await ticketByNumber(ticket.number)).messages).toHaveLength(3);
    });

    it('matches by the Graph conversation when there is nothing else', async () => {
      const { ticket, first } = await opened();
      graph.deliver({
        from: { address: 'sam.okafor@example.com' },
        subject: 'VPN drops',
        body: 'Also at the office.',
        conversationId: first.conversationId,
      });
      expect(await poll()).toMatchObject({ created: 0, appended: 1 });
      expect((await ticketByNumber(ticket.number)).messages).toHaveLength(2);
    });

    it('opens a new ticket when nothing matches, and for a [#N] that does not exist', async () => {
      await opened();
      graph.deliver({ from: { address: 'a@example.com' }, subject: 'New thing', body: 'x' });
      graph.deliver({ from: { address: 'b@example.com' }, subject: '[#9999] Old ref', body: 'y' });
      expect(await poll()).toMatchObject({ created: 2, appended: 0 });
    });

    it('puts a waiting or resolved ticket back in progress when the requester writes', async () => {
      const { ticket } = await opened();
      await req(tech, 'PATCH', `/api/tickets/${ticket.id}`, { status: 'resolved' });
      graph.deliver({
        from: { address: 'sam.okafor@example.com' },
        subject: `RE: [#${ticket.number}] VPN drops`,
        body: 'It is back.',
      });
      await poll();
      const after = await ticketByNumber(ticket.number);
      expect(after.status).toBe('in_progress');
      expect(after.events[0]).toMatchObject({
        kind: 'status',
        fromStatus: 'resolved',
        toStatus: 'in_progress',
      });
    });
  });

  describe('what is skipped', () => {
    it('ignores repeats, mail from the mailbox itself, automatic replies and bounces', async () => {
      await connect();
      const msg = graph.deliver({
        from: { address: 'dana@example.com' },
        subject: 'Hi',
        body: 'x',
      });
      await poll();
      // The same email again (moved out and back, so a new Graph ID) and a second poll.
      graph.deliver({
        from: { address: 'dana@example.com' },
        subject: 'Hi',
        body: 'x',
        internetMessageId: msg.internetMessageId,
      });
      graph.deliver({ from: { address: MAILBOX }, subject: 'Loop', body: 'mine' });
      graph.deliver({
        from: { address: 'dana@example.com' },
        subject: 'Automatic reply: Hi',
        body: 'I am out of the office.',
        headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
      });
      graph.deliver({
        from: { address: 'dana@example.com' },
        subject: 'Out of office',
        body: 'Away',
        headers: [
          { name: 'X-Auto-Response-Suppress', value: 'All' },
          { name: 'Precedence', value: 'auto_reply' },
        ],
      });
      graph.deliver({
        from: { address: 'MAILER-DAEMON@example.net' },
        subject: 'Undeliverable',
        body: 'x',
      });
      expect(await poll()).toMatchObject({ created: 0, appended: 0, skipped: 5 });
      expect(await poll()).toMatchObject({ created: 0, appended: 0, skipped: 0 });
      const { rows } = await t.pool.query('select count(*)::int as n from ticket_messages');
      expect(rows[0].n).toBe(1);
    });

    it('leaves mail that arrived before the mailbox was connected', async () => {
      graph.deliver({
        from: { address: 'old@example.com' },
        subject: 'Old',
        body: 'From last year',
        receivedDateTime: new Date(Date.now() - 86_400_000).toISOString(),
      });
      await connect();
      expect(await poll()).toMatchObject({ created: 0 });
      expect(graph.calls.filter((c) => c.includes('/messages/AAMk'))).toEqual([]);
    });

    it('keeps the rest of the inbox moving when one email keeps failing', async () => {
      await connect();
      const bad = graph.deliver({ from: { address: 'a@example.com' }, subject: 'Bad', body: 'x' });
      graph.deliver({ from: { address: 'b@example.com' }, subject: 'Good', body: 'y' });
      graph.failNext(new RegExp(`GET .*/messages/${bad.id}$`), 400, 'ErrorInvalidRequest', 3);
      expect(await mail.poll()).toBeNull();
      expect((await mail.status()).state).toBe('failing');
      expect(await mail.poll()).toBeNull();
      expect(await poll()).toMatchObject({ created: 1, skipped: 1 });
      expect((await mail.status()).state).toBe('connected');
    });
  });

  describe('attachments', () => {
    it('keeps emailed files on disk, and records why refused ones were not kept', async () => {
      await connect();
      const pdf = Buffer.from('%PDF-1.7 fake invoice');
      graph.deliver({
        from: { address: 'dana@example.com' },
        subject: 'Invoice scan',
        body: 'Attached.',
        attachments: [
          { name: 'invoice.pdf', contentType: 'application/pdf', data: pdf },
          { name: 'setup.exe', data: Buffer.from('MZ') },
          {
            name: 'Forwarded.eml',
            data: Buffer.from('x'),
            odataType: '#microsoft.graph.itemAttachment',
          },
          { name: '../../etc/passwd', contentType: 'text/plain', data: Buffer.from('root') },
        ],
      });
      await poll();
      const ticket = await newestTicket();
      const files = must(ticket.messages[0]).attachments;
      expect(files).toHaveLength(4);
      expect(files.map((f) => [f.name, f.skippedReason])).toEqual(
        expect.arrayContaining([
          ['invoice.pdf', null],
          ['setup.exe', 'Not kept: this file type can run programs.'],
          ['Forwarded.eml', 'Not kept: only files are kept, not attached emails or links.'],
          ['passwd', null],
        ]),
      );
      const kept = must(files.find((f) => f.name === 'invoice.pdf'));
      const refused = must(files.find((f) => f.name === 'setup.exe'));

      const res = await req(tech, 'GET', `/api/tickets/${ticket.id}/attachments/${kept.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(pdf)).toBe(true);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain('sandbox');

      // The database holds the name and hash, never the file.
      const { rows } = await t.pool.query(
        "select storage_key, sha256 from ticket_attachments where name = 'invoice.pdf'",
      );
      expect(rows[0].storage_key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
      expect(rows[0].sha256).toHaveLength(64);
      const skipped = await req(tech, 'GET', `/api/tickets/${ticket.id}/attachments/${refused.id}`);
      expect(skipped.statusCode).toBe(404);
    });

    it('sends uploaded files with the reply, large ones through an upload session', async () => {
      await connect();
      const res = await req(tech, 'POST', '/api/tickets', ticketFixtures.printer);
      const ticket: Detail = res.json();
      const small = await upload(ticket, 'steps.pdf', Buffer.from('%PDF small'));
      expect(small.statusCode, small.body).toBe(201);
      const bigData = Buffer.alloc(4 * 1024 * 1024 + 123, 7);
      const big = await upload(ticket, 'driver.zip', bigData, 'application/zip');
      expect(big.statusCode, big.body).toBe(201);

      const replied = await reply(ticket, 'Install this driver.', {
        attachmentIds: [small.json().id, big.json().id],
      });
      expect(replied.messages[1]).toMatchObject({ emailStatus: 'sent' });
      expect(replied.messages[1]?.attachments.map((a) => a.name)).toEqual([
        'steps.pdf',
        'driver.zip',
      ]);
      // No email of hers to reply to: a new message with the reference in the subject.
      const sent = must(graph.sent[0]);
      expect(sent.subject).toBe(`[#${ticket.number}] ${ticketFixtures.printer.subject}`);
      expect(sent.attachments.map((a) => [a.name, a.data.length])).toEqual([
        ['steps.pdf', 10],
        ['driver.zip', bigData.length],
      ]);
      expect(sent.attachments[1]?.data.equals(bigData)).toBe(true);
      expect(graph.calls.some((c) => c.endsWith('/attachments/createUploadSession'))).toBe(true);

      // A file belongs to one message only.
      const again = await reply(ticket, 'Again', { attachmentIds: [small.json().id] }).catch(
        (e: Error) => e,
      );
      expect(again).toBeInstanceOf(Error);
    });

    it('refuses programs, and removes an upload that was not sent', async () => {
      const ticket: Detail = (await req(tech, 'POST', '/api/tickets', ticketFixtures.vpn)).json();
      const exe = await upload(ticket, 'fix.ps1', Buffer.from('Remove-Item'), 'text/plain');
      expect(exe.statusCode).toBe(415);
      const ok = await upload(ticket, 'log.txt', Buffer.from('hello'), 'text/plain');
      const id = ok.json().id;
      const del = await req(tech, 'DELETE', `/api/tickets/${ticket.id}/attachments/${id}`);
      expect(del.statusCode).toBe(204);
      const gone = await req(tech, 'GET', `/api/tickets/${ticket.id}/attachments/${id}`);
      expect(gone.statusCode).toBe(404);
    });

    it('attaches files to a note without emailing anything', async () => {
      const ticket: Detail = (await req(tech, 'POST', '/api/tickets', ticketFixtures.vpn)).json();
      const file = await upload(ticket, 'trace.txt', Buffer.from('tracert'), 'text/plain');
      const res = await req(tech, 'POST', `/api/tickets/${ticket.id}/messages`, {
        kind: 'note',
        body: '',
        attachmentIds: [file.json().id],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().messages[1]).toMatchObject({
        kind: 'note',
        emailStatus: null,
        attachments: [{ name: 'trace.txt' }],
      });
    });
  });

  describe('sending', () => {
    it('saves replies without emailing them while no mailbox is connected', async () => {
      const ticket: Detail = (await req(tech, 'POST', '/api/tickets', ticketFixtures.vpn)).json();
      const replied = await reply(ticket, 'Saved only.');
      expect(replied.messages[1]).toMatchObject({ emailStatus: 'not_sent', emailedAt: null });
      await connect();
      const resend = await req(
        tech,
        'POST',
        `/api/tickets/${ticket.id}/messages/${must(replied.messages[1]).id}/resend`,
      );
      expect(resend.statusCode).toBe(409);
      expect(graph.sent).toHaveLength(0);
    });

    it('marks a reply failed with what to do, and sends it again on request', async () => {
      await connect();
      const ticket: Detail = (await req(tech, 'POST', '/api/tickets', ticketFixtures.vpn)).json();
      graph.failNext(/POST .*\/send$/, 403, 'ErrorAccessDenied');
      const replied = await reply(ticket, 'Try again later.');
      const failed = must(replied.messages[1]);
      expect(failed.emailStatus).toBe('failed');
      expect(failed.emailError).toContain('Application Mail.Send');
      expect(graph.sent).toHaveLength(0);

      const resend = await req(
        tech,
        'POST',
        `/api/tickets/${ticket.id}/messages/${failed.id}/resend`,
      );
      expect(resend.statusCode, resend.body).toBe(200);
      expect(resend.json().messages[1]).toMatchObject({ emailStatus: 'sent', emailError: null });
      expect(graph.sent).toHaveLength(1);
    });

    it('keeps a reply queued while Microsoft is unavailable, until the last attempt', async () => {
      await connect();
      const ticket: Detail = (await req(tech, 'POST', '/api/tickets', ticketFixtures.vpn)).json();
      mail.queue.send = async () => {};
      const replied = await reply(ticket, 'Later.');
      const id = must(replied.messages[1]).id;
      expect(replied.messages[1]?.emailStatus).toBe('queued');
      // Twice: the client waits once on its own before giving up on this attempt.
      graph.failNext(/POST .*\/messages$/, 503, 'ServiceUnavailable', 2);
      await expect(mail.send(id, false)).rejects.toThrow(/Microsoft's mail service/);
      let row = await t.pool.query(
        'select email_status, email_error from ticket_messages where id = $1',
        [id],
      );
      expect(row.rows[0]).toMatchObject({ email_status: 'queued' });
      expect(row.rows[0].email_error).toMatch(/Trying again/);
      expect(await mail.send(id, false)).toBe('sent');
      row = await t.pool.query('select email_status from ticket_messages where id = $1', [id]);
      expect(row.rows[0].email_status).toBe('sent');
      // A sent reply is never sent again, and its email fields are fixed.
      expect(await mail.send(id, false)).toBe('skipped');
      await expect(
        t.pool.query("update ticket_messages set email_status = 'queued' where id = $1", [id]),
      ).rejects.toThrow(/append only/);
    });
  });

  describe('settings', () => {
    it('stores the secret encrypted and never returns it', async () => {
      const saved = await connect();
      expect(saved).toMatchObject({
        configured: true,
        secretSet: true,
        mailbox: MAILBOX,
        status: { state: 'connected' },
      });
      expect(JSON.stringify(saved)).not.toContain(SECRET);
      const got = await req(admin, 'GET', '/api/settings/mail');
      expect(JSON.stringify(got.json())).not.toContain(SECRET);

      const { rows } = await t.pool.query("select value, secret from settings where key = 'mail'");
      expect(rows[0].secret).toMatch(/^v1\./);
      expect(rows[0].secret).not.toContain(SECRET);
      expect(JSON.stringify(rows[0].value)).not.toContain(SECRET);

      // A blank secret keeps the stored one.
      await connect({ clientSecret: '' });
      expect(
        (await t.pool.query("select secret from settings where key = 'mail'")).rows[0].secret,
      ).toBe(rows[0].secret);
      const audits = await t.pool.query(
        "select details from audit_log where action = 'settings.mail_updated' order by at desc limit 2",
      );
      expect(audits.rows.map((r) => r.details.changed).reverse()).toEqual([
        ['tenantId', 'clientId', 'mailbox', 'secretExpiresOn', 'enabled', 'clientSecret'],
        [],
      ]);
      expect(JSON.stringify(audits.rows)).not.toContain(SECRET);
    });

    it('refuses a first save without a secret', async () => {
      const res = await req(admin, 'PUT', '/api/settings/mail', {
        ...settingsBody,
        clientSecret: '',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('secret_required');
    });

    it('tests the connection and says which step failed', async () => {
      const test = (overrides: object) =>
        req(admin, 'POST', '/api/settings/mail/test', { ...settingsBody, ...overrides }).then((r) =>
          r.json(),
        );
      expect(await test({})).toEqual({
        ok: true,
        step: null,
        message: `Signed in to Microsoft and opened the inbox of ${MAILBOX}.`,
      });
      expect(await test({ clientSecret: 'wrong' })).toMatchObject({
        ok: false,
        step: 'sign_in',
        message: expect.stringContaining("secret's Value"),
      });
      expect(await test({ tenantId: 'contoso.onmicrosoft.com' })).toMatchObject({
        ok: false,
        step: 'sign_in',
        message: expect.stringContaining('does not know the directory'),
      });
      expect(await test({ mailbox: 'ceo@example.com' })).toMatchObject({
        ok: false,
        step: 'mailbox',
        message: expect.stringContaining('not allowed to use ceo@example.com'),
      });
      // Testing saves nothing.
      expect((await req(admin, 'GET', '/api/settings/mail')).json().configured).toBe(false);
    });

    it('warns before the secret expires and when it has', async () => {
      const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
      await connect({ secretExpiresOn: soon });
      const status = await req(tech, 'GET', '/api/mail/status');
      expect(status.json()).toMatchObject({ state: 'secret_expiring', secretExpiresOn: soon });
      await connect({ secretExpiresOn: '2020-01-01' });
      expect((await req(tech, 'GET', '/api/mail/status')).json().state).toBe('secret_expired');
      await connect({ enabled: false });
      expect((await req(tech, 'GET', '/api/mail/status')).json().state).toBe('off');
    });

    it('is for administrators only, and never for a token', async () => {
      const { token } = await issueToken(admin, [
        'assets:read',
        'assets:write',
        'tickets:read',
        'tickets:write',
      ]);
      const routes: ['GET' | 'POST' | 'PUT' | 'DELETE', string, object?][] = [
        ['GET', '/api/settings/mail'],
        ['PUT', '/api/settings/mail', settingsBody],
        ['POST', '/api/settings/mail/test', settingsBody],
        ['POST', '/api/settings/mail/check-now'],
        ['DELETE', '/api/settings/mail'],
      ];
      for (const [method, url, payload] of routes) {
        const asTech = await req(tech, method, url, payload);
        expect(asTech.statusCode, `${method} ${url}`).toBe(403);
        const asToken = await withToken(app, token, {
          method: method as 'POST',
          url,
          ...(payload ? { payload } : {}),
        });
        expect(asToken.statusCode, `${method} ${url}`).toBe(403);
      }
      const status = await withToken(app, token, { method: 'GET', url: '/api/mail/status' });
      expect(status.statusCode).toBe(403);
    });

    it('disconnecting forgets the secret and stops checking', async () => {
      await connect();
      const res = await req(admin, 'DELETE', '/api/settings/mail');
      expect(res.statusCode).toBe(204);
      expect((await t.pool.query('select count(*)::int as n from settings')).rows[0].n).toBe(0);
      expect(await mail.poll()).toBeNull();
      const audit = await t.pool.query(
        "select count(*)::int as n from audit_log where action = 'settings.mail_disconnected'",
      );
      expect(audit.rows[0].n).toBeGreaterThan(0);
    });
  });
});
