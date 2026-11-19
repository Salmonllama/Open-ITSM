import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OIDC_COOKIE } from '../src/auth/entra.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../src/auth/http.js';
import { FakeEntra } from './fixtures/entra.js';
import { CLIENT_ID, FakeGraph, MAILBOX, TENANT } from './fixtures/graph.js';
import { makeApp, makeEntra, makeMail, sessionCookie, TEST_SETUP_TOKEN } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('End-user portal (M10)', () => {
  let tdb: TestDatabase;
  let graph: FakeGraph;
  let fakeEntra: FakeEntra;
  let app: FastifyInstance;
  let adminCookie: string;
  let adminCsrf: string;

  let nextIp = 1;
  const freshIp = () => `10.1.0.${nextIp++}`;

  async function setPortal(enabled: boolean) {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/portal',
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: { enabled },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function createTicket(requesterEmail: string, requesterName: string, subject: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: {
        subject,
        requester: { email: requesterEmail, name: requesterName },
        message: `Help with ${subject}`,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; number: number };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    graph = new FakeGraph();
    fakeEntra = new FakeEntra();
    const { mail, store } = makeMail(tdb.db, { fetch: graph.fetch });
    const entra = makeEntra(tdb.db, { fetch: fakeEntra.fetch });
    app = await makeApp({ db: tdb.db, mail, attachments: store, entra });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        token: TEST_SETUP_TOKEN,
        name: 'Admin',
        email: 'admin@example.com',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(setup.statusCode).toBe(201);
    adminCookie = sessionCookie(setup);
    adminCsrf = setup.json().csrfToken;

    // Connect mailbox so one-time sign-in links can be sent.
    const mailRes = await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: {
        tenantId: TENANT,
        clientId: CLIENT_ID,
        clientSecret: graph.secret,
        secretExpiresOn: '2028-06-01',
        mailbox: MAILBOX,
        enabled: true,
      },
    });
    expect(mailRes.statusCode).toBe(200);

    // Connect Entra ID SSO so non-group end-user sign-in can be tested too.
    const ssoRes = await app.inject({
      method: 'PUT',
      url: '/api/settings/sso',
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: {
        tenantId: fakeEntra.tenantId,
        clientId: fakeEntra.clientId,
        clientSecret: fakeEntra.clientSecret,
        technicianGroupId: fakeEntra.techGroupId,
        enabled: true,
      },
    });
    expect(ssoRes.statusCode).toBe(200);
  });

  beforeEach(async () => {
    graph.messages = graph.messages.filter((m) => m.folder !== 'sent');
  });

  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  it('is off by default and refuses email-link sign-in until enabled', async () => {
    const settings = await app.inject({
      method: 'GET',
      url: '/api/settings/portal',
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({
      enabled: false,
      entraEnabled: true,
      mailConnected: true,
    });

    const methods = await app.inject({ method: 'GET', url: '/api/auth/methods' });
    expect(methods.json().emailLink.enabled).toBe(false);

    const reqLink = await app.inject({
      method: 'POST',
      url: '/api/auth/email-link',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { email: 'alice@example.com' },
    });
    expect(reqLink.statusCode).toBe(403);
    expect(reqLink.json().error).toBe('portal_disabled');
  });

  it('acceptance: end user signs in by emailed one-time link, sees only their own open tickets (no internal notes), and can reply', async () => {
    await setPortal(true);

    // Auth methods now advertises email links.
    const methods = await app.inject({ method: 'GET', url: '/api/auth/methods' });
    expect(methods.json().emailLink.enabled).toBe(true);

    // Seed tickets for Alice (1 open, 1 closed) and Bob (1 open).
    const aliceOpen = await createTicket(
      'alice@example.com',
      'Alice Requester',
      'VPN will not connect',
    );
    const aliceClosed = await createTicket(
      'alice@example.com',
      'Alice Requester',
      'Old mouse issue',
    );
    const bobOpen = await createTicket('bob@example.com', 'Bob Other', 'Payroll laptop broken');

    // Add a technician reply (set waiting_on_user) AND an internal note on Alice's open ticket.
    const replyRes = await app.inject({
      method: 'POST',
      url: `/api/tickets/${aliceOpen.id}/messages`,
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: {
        kind: 'reply',
        body: 'Can you try rebooting and reconnecting?',
        status: 'waiting_on_user',
      },
    });
    expect(replyRes.statusCode).toBe(200);

    const noteRes = await app.inject({
      method: 'POST',
      url: `/api/tickets/${aliceOpen.id}/messages`,
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: { kind: 'note', body: 'SECRET INTERNAL NOTE: check firewall rule 42' },
    });
    expect(noteRes.statusCode).toBe(200);

    // Close Alice's second ticket.
    const closeRes = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${aliceClosed.id}`,
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: { status: 'closed' },
    });
    expect(closeRes.statusCode).toBe(200);

    // Staff account email does NOT get a magic link email (stays neutral 200).
    const staffLinkReq = await app.inject({
      method: 'POST',
      url: '/api/auth/email-link',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { email: 'admin@example.com' },
    });
    expect(staffLinkReq.statusCode).toBe(200);
    expect(graph.sent).toHaveLength(0);

    // Alice requests a one-time sign-in link.
    const linkReq = await app.inject({
      method: 'POST',
      url: '/api/auth/email-link',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { email: 'alice@example.com' },
    });
    expect(linkReq.statusCode).toBe(200);
    expect(graph.sent).toHaveLength(1);
    const emailBody = graph.sent[0]?.body ?? '';
    const match = /\/login\/link\?token=([A-Za-z0-9_-]+)/.exec(emailBody);
    expect(match).not.toBeNull();
    const token = match?.[1] ?? '';

    // Alice redeems the one-time token.
    const redeem = await app.inject({
      method: 'POST',
      url: '/api/auth/email-link/redeem',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { token },
    });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json().user).toMatchObject({
      email: 'alice@example.com',
      role: 'end_user',
    });
    const aliceCookie = sessionCookie(redeem);
    const aliceCsrf = redeem.json().csrfToken;

    // Reusing the same link is refused (one-time only).
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/auth/email-link/redeem',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { token },
    });
    expect(reuse.statusCode).toBe(401);

    // Alice sees ONLY her own open ticket (not her closed ticket, not Bob's ticket).
    const list = await app.inject({
      method: 'GET',
      url: '/api/portal/tickets',
      cookies: { [SESSION_COOKIE]: aliceCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((t: { id: string }) => t.id)).toEqual([aliceOpen.id]);

    // Alice cannot read or reply to Bob's ticket (enforced in SQL -> 404).
    const bobRead = await app.inject({
      method: 'GET',
      url: `/api/portal/tickets/${bobOpen.id}`,
      cookies: { [SESSION_COOKIE]: aliceCookie },
    });
    expect(bobRead.statusCode).toBe(404);

    const bobReply = await app.inject({
      method: 'POST',
      url: `/api/portal/tickets/${bobOpen.id}/messages`,
      cookies: { [SESSION_COOKIE]: aliceCookie },
      headers: { [CSRF_HEADER]: aliceCsrf },
      payload: { body: 'Sneaking onto another ticket' },
    });
    expect(bobReply.statusCode).toBe(404);

    // Alice reads her own open ticket: sees requester message and technician reply, NEVER internal note.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/portal/tickets/${aliceOpen.id}`,
      cookies: { [SESSION_COOKIE]: aliceCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toContain('SECRET INTERNAL NOTE');
    expect(detail.json().messages).toHaveLength(2);

    // Alice replies to her open ticket -> moves from waiting_on_user to in_progress.
    const aliceReply = await app.inject({
      method: 'POST',
      url: `/api/portal/tickets/${aliceOpen.id}/messages`,
      cookies: { [SESSION_COOKIE]: aliceCookie },
      headers: { [CSRF_HEADER]: aliceCsrf },
      payload: { body: 'Rebooted and still seeing error 619.' },
    });
    expect(aliceReply.statusCode).toBe(201);
    expect(aliceReply.json().status).toBe('in_progress');
    expect(aliceReply.json().messages).toHaveLength(3);

    // Alice cannot reply to her closed ticket (409).
    const closedReply = await app.inject({
      method: 'POST',
      url: `/api/portal/tickets/${aliceClosed.id}/messages`,
      cookies: { [SESSION_COOKIE]: aliceCookie },
      headers: { [CSRF_HEADER]: aliceCsrf },
      payload: { body: 'Reopening closed ticket' },
    });
    expect(closedReply.statusCode).toBe(409);

    // Alice cannot reach any staff or admin endpoints.
    for (const url of ['/api/tickets', '/api/assets', '/api/settings/portal', '/api/docs']) {
      const denied = await app.inject({
        method: 'GET',
        url,
        cookies: { [SESSION_COOKIE]: aliceCookie },
      });
      expect(denied.statusCode, url).toBe(403);
    }

    // Switching portal off immediately revokes Alice's session.
    await setPortal(false);
    const afterOff = await app.inject({
      method: 'GET',
      url: '/api/portal/tickets',
      cookies: { [SESSION_COOKIE]: aliceCookie },
    });
    expect(afterOff.statusCode).toBe(401);
  });

  it('lets non-group Entra ID users sign in as end users when the portal is enabled', async () => {
    await setPortal(true);
    const ip = freshIp();
    const start = await app.inject({
      method: 'GET',
      url: '/api/auth/entra/start',
      headers: { 'x-forwarded-for': ip },
    });
    expect(start.statusCode).toBe(302);
    const oidc = start.cookies.find((c) => c.name === OIDC_COOKIE);
    if (!oidc) throw new Error('expected OIDC cookie');
    const callbackPath = fakeEntra.authorize(start.headers.location as string, {
      oid: 'oid-end-user-1',
      email: 'carol@example.com',
      name: 'Carol EndUser',
      groups: [],
    });
    const cb = await app.inject({
      method: 'GET',
      url: callbackPath,
      headers: { 'x-forwarded-for': ip },
      cookies: { [OIDC_COOKIE]: oidc.value },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/portal');
    const carolCookie = sessionCookie(cb);

    const sess = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: { [SESSION_COOKIE]: carolCookie },
    });
    expect(sess.json().user).toMatchObject({
      email: 'carol@example.com',
      role: 'end_user',
    });

    await setPortal(false);
  });
});
