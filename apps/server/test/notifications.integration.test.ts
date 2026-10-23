import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationService } from '../src/notifications/service.js';
import { FakeGraph, MAILBOX, CLIENT_ID, SECRET, TENANT } from './fixtures/graph.js';
import { makeApp, makeMail, makeNotifications, TEST_SITE_URL } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, issueToken, signIn, withToken } from './helpers/seed.js';

type Session = Awaited<ReturnType<typeof signIn>>;

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/slacksecretvalue';
const TEAMS_URL =
  'https://default1234.ab.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=teamssecretvalue';

type Post = { url: string; body: Record<string, unknown> };

/** Slack and Teams, as far as a webhook can see them: records posts and answers as told. */
class FakeHooks {
  posts: Post[] = [];
  /** Status codes to answer with, in turn; 200 once they run out. */
  answers: number[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    this.posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const status = this.answers.shift() ?? 200;
    return new Response(status === 404 ? 'no_service' : 'ok', { status });
  };

  slackText(i = 0): string {
    const blocks = this.posts[i]?.body.blocks as { text?: { text: string } }[];
    return blocks[0]?.text?.text ?? '';
  }
}

describe.skipIf(!testDatabaseUrl)('Slack and Teams notifications', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let hooks: FakeHooks;
  let notifications: NotificationService;
  let admin: Session;
  let tech: Session;
  let techId: string;

  function req(
    session: Session,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) {
    return session.request({ method: method as 'POST', url, ...(payload ? { payload } : {}) });
  }

  async function addChannel(body: object) {
    const res = await req(admin, 'POST', '/api/settings/notifications', {
      name: 'IT team',
      kind: 'slack',
      webhookUrl: SLACK_URL,
      events: ['ticket_created', 'ticket_assigned', 'low_stock'],
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; webhookHint: string };
  }

  async function openTicket(subject = 'Laptop will not start') {
    const res = await req(tech, 'POST', '/api/tickets', {
      subject,
      requester: { name: 'Dana Whitfield', email: 'dana@example.com' },
      message: 'The secret words of the requester stay in Open ITSM.',
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; number: number };
  }

  async function addItem(quantity: number, lowStockThreshold: number) {
    const res = await req(tech, 'POST', '/api/consumables', {
      name: `Toner ${Math.random().toString(36).slice(2, 6)}`,
      quantity,
      lowStockThreshold,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; name: string };
  }

  async function use(id: string, amount: number) {
    const res = await req(tech, 'POST', `/api/consumables/${id}/adjustments`, {
      kind: 'use',
      amount,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await createUser(t.db, 'root@example.com', 'admin');
    techId = (await createUser(t.db, 'tech@example.com', 'technician')).id;
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });
  beforeEach(async () => {
    await t.pool.query('delete from notification_channels');
    hooks = new FakeHooks();
    notifications = makeNotifications(t.db, { fetch: hooks.fetch });
    app = await makeApp({ db: t.db, notifications });
    admin = await signIn(app, 'root@example.com');
    tech = await signIn(app, 'tech@example.com');
  });
  afterEach(async () => {
    await app.close();
  });

  describe('acceptance', () => {
    it('a new ticket posts to a configured channel; with nothing configured, nothing is sent', async () => {
      await openTicket('Nobody is told about this one');
      expect(hooks.posts).toHaveLength(0);

      await addChannel({ name: 'Helpdesk' });
      const ticket = await openTicket('Laptop will not start');
      expect(hooks.posts).toHaveLength(1);
      const post = hooks.posts[0];
      expect(post?.url).toBe(SLACK_URL);
      expect(hooks.slackText()).toBe(
        `*New ticket #${ticket.number}: Laptop will not start*\nOpened on the dashboard`,
      );
      expect(JSON.stringify(post?.body)).toContain(`${TEST_SITE_URL}/tickets/${ticket.id}`);
      // The subject and a link, never what the requester wrote.
      expect(JSON.stringify(post?.body)).not.toContain('secret words');
    });
  });

  it('posts an Adaptive Card to Teams when a ticket is assigned', async () => {
    await addChannel({
      name: 'Teams desk',
      kind: 'teams',
      webhookUrl: TEAMS_URL,
      events: ['ticket_assigned'],
    });
    const ticket = await openTicket('VPN drops <!channel> [click](https://evil.test)');
    expect(hooks.posts).toHaveLength(0); // not subscribed to new tickets

    const res = await req(tech, 'PATCH', `/api/tickets/${ticket.id}`, { assigneeId: techId });
    expect(res.statusCode, res.body).toBe(200);
    expect(hooks.posts).toHaveLength(1);
    const body = hooks.posts[0]?.body as {
      type: string;
      attachments: { contentType: string; content: Record<string, unknown> }[];
    };
    expect(body.type).toBe('message');
    expect(body.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = body.attachments[0]?.content as {
      body: { inlines: { type: string; text: string }[] }[];
      actions: { type: string; url: string }[];
    };
    expect(card.body[0]?.inlines[0]).toMatchObject({
      type: 'TextRun',
      text: `Ticket #${ticket.number} assigned: VPN drops <!channel> [click](https://evil.test)`,
    });
    expect(card.body[1]?.inlines[0]?.text).toBe('Assigned to tech');
    expect(card.actions).toEqual([
      {
        type: 'Action.OpenUrl',
        title: 'Open ticket',
        url: `${TEST_SITE_URL}/tickets/${ticket.id}`,
      },
    ]);

    // The same assignee again, and unassigning, say nothing.
    await req(tech, 'PATCH', `/api/tickets/${ticket.id}`, { assigneeId: techId });
    await req(tech, 'PATCH', `/api/tickets/${ticket.id}`, { assigneeId: null });
    expect(hooks.posts).toHaveLength(1);
  });

  it('escapes Slack markup in subjects', async () => {
    await addChannel({ events: ['ticket_created'] });
    await openTicket('Help <!channel> & <https://evil.test|click>');
    expect(hooks.slackText()).toContain(
      'Help &lt;!channel&gt; &amp; &lt;https://evil.test|click&gt;',
    );
  });

  it('tells channels about tickets that arrive by email', async () => {
    await addChannel({ events: ['ticket_created'] });
    const graph = new FakeGraph();
    const { mail, store } = makeMail(t.db, { fetch: graph.fetch });
    mail.onTicketCreated = (id) => notifications.ticketCreated(id);
    await app.close();
    app = await makeApp({ db: t.db, mail, notifications, attachments: store });
    admin = await signIn(app, 'root@example.com');
    const saved = await req(admin, 'PUT', '/api/settings/mail', {
      tenantId: TENANT,
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      secretExpiresOn: `${new Date().getUTCFullYear() + 1}-06-30`,
      mailbox: MAILBOX,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    graph.deliver({
      from: { name: 'Sam', address: 'sam@example.com' },
      subject: 'Monitor flickers',
      body: 'It flickers.',
    });
    expect(await mail.poll()).toMatchObject({ created: 1 });
    expect(hooks.posts).toHaveLength(1);
    expect(hooks.slackText()).toMatch(/^\*New ticket #\d+: Monitor flickers\*\nCame in by email$/);
  });

  it('posts low stock once per drop, or on every use, as each channel chooses', async () => {
    const first = await addChannel({ name: 'Once', events: ['low_stock'], lowStockMode: 'first' });
    await addChannel({ name: 'Every', events: ['low_stock'], lowStockMode: 'every' });
    const item = await addItem(6, 5);

    await use(item.id, 1); // 6 -> 5: both
    expect(hooks.posts).toHaveLength(2);
    await use(item.id, 1); // 5 -> 4: only Every
    expect(hooks.posts).toHaveLength(3);
    expect(hooks.slackText(2)).toBe(`*Low stock: ${item.name}*\n4 left (low at 5 or fewer)`);
    expect(JSON.stringify(hooks.posts[2]?.body)).toContain(
      `${TEST_SITE_URL}/consumables/${item.id}`,
    );

    // Restocked above the threshold, then low again: both once more.
    const add = await req(tech, 'POST', `/api/consumables/${item.id}/adjustments`, {
      kind: 'add',
      amount: 10,
    });
    expect(add.statusCode).toBe(200);
    expect(hooks.posts).toHaveLength(3);
    const count = await req(tech, 'POST', `/api/consumables/${item.id}/adjustments`, {
      kind: 'count',
      quantity: 2,
      reason: 'Shelf count',
    });
    expect(count.statusCode).toBe(200);
    expect(hooks.posts).toHaveLength(5);

    // A threshold of 0 never posts; a switched-off channel never posts.
    const never = await addItem(3, 0);
    await use(never.id, 3);
    expect(hooks.posts).toHaveLength(5);
    const off = await req(admin, 'PUT', `/api/settings/notifications/${first.id}`, {
      name: 'Once',
      events: ['low_stock'],
      lowStockMode: 'every',
      enabled: false,
    });
    expect(off.statusCode, off.body).toBe(200);
    await use(item.id, 1);
    expect(hooks.posts).toHaveLength(6);
  });

  it('keeps the webhook URL secret and checks it', async () => {
    const channel = await addChannel({});
    expect(channel.webhookHint).toBe('hooks.slack.com …alue');
    const list = await req(admin, 'GET', '/api/settings/notifications');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('slacksecretvalue');
    expect(list.json()).toMatchObject({ siteUrl: TEST_SITE_URL, channels: [{ name: 'IT team' }] });
    const { rows } = await t.pool.query<{ webhook_url: string }>(
      'select webhook_url from notification_channels',
    );
    expect(rows[0]?.webhook_url).toMatch(/^v1\./);
    expect(rows[0]?.webhook_url).not.toContain('slacksecretvalue');

    const wrongKind = await req(admin, 'POST', '/api/settings/notifications', {
      name: 'Wrong',
      kind: 'slack',
      webhookUrl: TEAMS_URL,
      events: [],
    });
    expect(wrongKind.statusCode).toBe(400);
    const internal = await req(admin, 'POST', '/api/settings/notifications', {
      name: 'Inside',
      kind: 'teams',
      webhookUrl: 'https://10.0.0.5/hook',
      events: [],
    });
    expect(internal.statusCode).toBe(400);
    const retired = await req(admin, 'PUT', `/api/settings/notifications/${channel.id}`, {
      name: 'IT team',
      events: [],
      webhookUrl: 'https://hooks.slack.com/nope',
    });
    expect(retired.statusCode).toBe(400);
    const taken = await req(admin, 'POST', '/api/settings/notifications', {
      name: 'it TEAM',
      kind: 'slack',
      webhookUrl: SLACK_URL,
      events: [],
    });
    expect(taken.statusCode).toBe(409);

    // A blank URL keeps the stored one.
    const renamed = await req(admin, 'PUT', `/api/settings/notifications/${channel.id}`, {
      name: 'Desk',
      events: ['ticket_created'],
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    await openTicket();
    expect(hooks.posts.at(-1)?.url).toBe(SLACK_URL);

    const audit = await t.pool.query<{ action: string; details: object }>(
      "select action, details from audit_log where action like 'settings.channel%' order by id",
    );
    expect(audit.rows.slice(-2).map((r) => r.action)).toEqual([
      'settings.channel_created',
      'settings.channel_updated',
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('slacksecretvalue');

    const removed = await req(admin, 'DELETE', `/api/settings/notifications/${channel.id}`);
    expect(removed.statusCode).toBe(204);
    expect((await req(admin, 'GET', '/api/settings/notifications')).json().channels).toEqual([]);
  });

  it('is for administrators only', async () => {
    expect((await req(tech, 'GET', '/api/settings/notifications')).statusCode).toBe(403);
    expect(
      (
        await req(tech, 'POST', '/api/settings/notifications', {
          name: 'x',
          kind: 'slack',
          webhookUrl: SLACK_URL,
          events: [],
        })
      ).statusCode,
    ).toBe(403);
    const { token } = await issueToken(admin, ['tickets:read', 'tickets:write']);
    const res = await withToken(app, token, { method: 'GET', url: '/api/settings/notifications' });
    expect(res.statusCode).toBe(403);
  });

  it('sends a test message and shows the last failure until a message goes through', async () => {
    const channel = await addChannel({});
    const ok = await req(admin, 'POST', `/api/settings/notifications/${channel.id}/test`);
    expect(ok.json()).toEqual({ ok: true, message: 'Sent a test message to IT team.' });
    expect(hooks.slackText()).toContain('Test message from Open ITSM');

    hooks.answers = [404];
    const gone = await req(admin, 'POST', `/api/settings/notifications/${channel.id}/test`);
    expect(gone.json()).toEqual({
      ok: false,
      message:
        'Slack says this webhook no longer exists. Create a new incoming webhook and paste its URL.',
    });
    const listed = (await req(admin, 'GET', '/api/settings/notifications')).json();
    expect(listed.channels[0].lastError).toMatch(/no longer exists/);

    // A message that goes through clears it.
    await openTicket();
    const after = (await req(admin, 'GET', '/api/settings/notifications')).json();
    expect(after.channels[0]).toMatchObject({ lastError: null, lastErrorAt: null });
  });

  it('retries temporary failures and never fails the change that caused the message', async () => {
    const channel = await addChannel({ events: ['ticket_created'] });
    hooks.answers = [503, 503];
    // Inline delivery gives up at once, but the ticket is still opened.
    const ticket = await openTicket();
    expect(ticket.number).toBeGreaterThan(0);
    const listed = (await req(admin, 'GET', '/api/settings/notifications')).json();
    expect(listed.channels[0].lastError).toBe(
      'Slack is not available right now (status 503). It will be tried again.',
    );

    // As a job: a temporary failure throws so it is tried again; the last attempt does not.
    const delivery = { channelId: channel.id, notice: { title: 'x', detail: 'y' } };
    hooks.answers = [503];
    await expect(notifications.deliver(delivery, false)).rejects.toThrow(/not available/);
    hooks.answers = [503];
    await expect(notifications.deliver(delivery, true)).resolves.toBeUndefined();
    hooks.answers = [400];
    await expect(notifications.deliver(delivery, false)).resolves.toBeUndefined();
    await expect(notifications.deliver(delivery, false)).resolves.toBeUndefined(); // 200
    // A channel removed since the message was queued is passed over.
    await req(admin, 'DELETE', `/api/settings/notifications/${channel.id}`);
    const before = hooks.posts.length;
    await notifications.deliver(delivery, false);
    expect(hooks.posts).toHaveLength(before);
  });
});
