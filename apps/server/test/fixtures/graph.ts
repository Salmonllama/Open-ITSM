import { randomUUID } from 'node:crypto';
import { TEST_GRAPH_URL, TEST_LOGIN_URL } from '../helpers/app.js';

/**
 * A stand-in for Microsoft sign-in and Graph mail, enough for one shared mailbox: the inbox by
 * delta query, messages, attachments, reply drafts, upload sessions and send. It answers the
 * way Microsoft documents (status codes, error bodies, link shapes), so the client is tested
 * against the same behaviour without a tenant.
 */

export const TENANT = '11111111-2222-3333-4444-555555555555';
export const CLIENT_ID = '66666666-7777-8888-9999-000000000000';
export const SECRET = 'test~client~secret~value';
export const MAILBOX = 'support@example.com';

type Address = { name?: string; address: string };
type Attachment = {
  id: string;
  odataType: string;
  name: string;
  contentType: string;
  data: Buffer;
};

export type FakeMessage = {
  id: string;
  folder: 'inbox' | 'drafts' | 'sent';
  subject: string;
  from: Address;
  to: Address[];
  body: string;
  uniqueBody: string;
  receivedDateTime: string;
  internetMessageId: string;
  conversationId: string;
  headers: { name: string; value: string }[];
  attachments: Attachment[];
  isDraft: boolean;
  /** For a reply draft: the message it answers. */
  replyTo?: string;
  /** Change counter for the delta query. */
  seq: number;
};

export type InboundMail = {
  from: Address;
  subject: string;
  body: string;
  /** The new part only, as Graph's uniqueBody gives it; defaults to `body`. */
  uniqueBody?: string;
  headers?: { name: string; value: string }[];
  conversationId?: string;
  internetMessageId?: string;
  receivedDateTime?: string;
  attachments?: {
    name: string;
    contentType?: string;
    data: Buffer;
    /** Defaults to a file attachment. */
    odataType?: string;
  }[];
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function graphError(status: number, code: string, message = code) {
  return json(status, { error: { code, message } });
}

export class FakeGraph {
  messages: FakeMessage[] = [];
  /** Every request, as `METHOD path`, for asserting what was called. */
  calls: string[] = [];
  secret = SECRET;
  /** Mailboxes the app may use; others get 403 ErrorAccessDenied as RBAC scoping returns. */
  allowed = new Set([MAILBOX]);
  /** Fail the next requests matching a pattern with a status, for error paths. */
  failures: { pattern: RegExp; status: number; code: string; times: number }[] = [];
  private seq = 0;
  private tokens = new Set<string>();
  private uploads = new Map<
    string,
    { draft: string; name: string; size: number; parts: Buffer[] }
  >();

  /** An email arriving in the shared mailbox's inbox. */
  deliver(mail: InboundMail): FakeMessage {
    const id = `AAMk-${randomUUID()}`;
    const msg: FakeMessage = {
      id,
      folder: 'inbox',
      subject: mail.subject,
      from: mail.from,
      to: [{ address: MAILBOX }],
      body: mail.body,
      uniqueBody: mail.uniqueBody ?? mail.body,
      receivedDateTime: mail.receivedDateTime ?? new Date().toISOString(),
      internetMessageId: mail.internetMessageId ?? `<${randomUUID()}@mail.example.com>`,
      conversationId: mail.conversationId ?? `AAQk-${randomUUID()}`,
      headers: [
        { name: 'Message-ID', value: mail.internetMessageId ?? '' },
        ...(mail.headers ?? []),
      ],
      attachments: (mail.attachments ?? []).map((a) => ({
        id: `AAMkAtt-${randomUUID()}`,
        odataType: a.odataType ?? '#microsoft.graph.fileAttachment',
        name: a.name,
        contentType: a.contentType ?? 'application/octet-stream',
        data: a.data,
      })),
      isDraft: false,
      seq: ++this.seq,
    };
    this.messages.push(msg);
    return msg;
  }

  get sent(): FakeMessage[] {
    return this.messages.filter((m) => m.folder === 'sent');
  }

  get drafts(): FakeMessage[] {
    return this.messages.filter((m) => m.folder === 'drafts');
  }

  failNext(pattern: RegExp, status: number, code: string, times = 1) {
    this.failures.push({ pattern, status, code, times });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = decodeURIComponent(url.pathname);
    this.calls.push(`${method} ${path}`);

    const failure = this.failures.find((f) => f.times > 0 && f.pattern.test(`${method} ${path}`));
    if (failure) {
      failure.times -= 1;
      return graphError(failure.status, failure.code);
    }

    if (url.origin === new URL(TEST_LOGIN_URL).origin) return this.signIn(path, init);
    if (url.origin === 'https://upload.test') return this.uploadPart(path, init);
    if (url.origin !== new URL(TEST_GRAPH_URL).origin) throw new TypeError('fetch failed');

    const auth = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
    if (!auth || !this.tokens.has(auth)) {
      return graphError(401, 'InvalidAuthenticationToken', 'Access token is empty.');
    }
    const prefix = '/v1.0/users/';
    if (!path.startsWith(prefix)) return graphError(400, 'BadRequest');
    const [mailbox, ...rest] = path.slice(prefix.length).split('/');
    if (!mailbox || !this.allowed.has(mailbox.toLowerCase())) {
      return graphError(
        403,
        'ErrorAccessDenied',
        'Access is denied. Check credentials and try again.',
      );
    }
    return this.mail(method, rest, url, init);
  };

  private async signIn(path: string, init: RequestInit | undefined) {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (path !== `/${TENANT}/oauth2/v2.0/token`) {
      return json(400, {
        error: 'invalid_request',
        error_description: `AADSTS90002: Tenant '${path.split('/')[1]}' not found.`,
      });
    }
    if (form.get('client_id') !== CLIENT_ID) {
      return json(400, {
        error: 'unauthorized_client',
        error_description: `AADSTS700016: Application with identifier '${form.get('client_id')}' was not found in the directory.`,
      });
    }
    if (form.get('client_secret') !== this.secret) {
      return json(401, {
        error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret provided.',
      });
    }
    if (form.get('scope') !== 'https://graph.microsoft.com/.default') {
      return json(400, { error: 'invalid_scope', error_description: 'AADSTS70011: bad scope' });
    }
    const token = randomUUID();
    this.tokens.add(token);
    return json(200, { token_type: 'Bearer', expires_in: 3599, access_token: token });
  }

  private async mail(method: string, rest: string[], url: URL, init: RequestInit | undefined) {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = rest.join('/');

    if (method === 'GET' && route === 'mailFolders/inbox') return json(200, { id: 'inbox-id' });

    if (method === 'GET' && route === 'mailFolders/inbox/messages/delta') {
      const since = Number(url.searchParams.get('$deltatoken') ?? 0);
      const filter = url.searchParams.get('$filter');
      const from = filter ? /receivedDateTime ge (\S+)/.exec(filter)?.[1] : undefined;
      const changed = this.messages.filter(
        (m) =>
          m.folder === 'inbox' &&
          m.seq > since &&
          (since > 0 || !from || m.receivedDateTime >= from),
      );
      return json(200, {
        value: changed.map((m) => ({
          id: m.id,
          receivedDateTime: m.receivedDateTime,
          isDraft: m.isDraft,
        })),
        '@odata.deltaLink': `${TEST_GRAPH_URL}/users/${MAILBOX}/mailFolders/inbox/messages/delta?$deltatoken=${this.seq}`,
      });
    }

    if (method === 'POST' && route === 'messages') {
      return json(201, this.draft({ subject: '', to: [] }));
    }

    const [, id, sub, attId, value] = ['', ...rest.slice(1)];
    if (rest[0] !== 'messages' || !id) return graphError(400, 'BadRequest');
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return graphError(404, 'ErrorItemNotFound', 'The specified object was not found.');

    if (!sub) {
      if (method === 'GET') return json(200, this.view(msg));
      if (method === 'PATCH') {
        if (!msg.isDraft) return graphError(400, 'ErrorInvalidRequest');
        if (body.subject !== undefined) msg.subject = body.subject;
        if (body.body) msg.body = body.body.content;
        if (body.toRecipients) {
          msg.to = body.toRecipients.map((r: { emailAddress: Address }) => r.emailAddress);
        }
        return json(200, this.view(msg));
      }
      if (method === 'DELETE') {
        this.messages = this.messages.filter((m) => m !== msg);
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'POST' && sub === 'createReply') {
      return json(
        201,
        this.draft({
          subject: `RE: ${msg.subject}`,
          to: [msg.from],
          replyTo: msg.id,
          conversationId: msg.conversationId,
        }),
      );
    }
    if (method === 'POST' && sub === 'send') {
      if (!msg.isDraft) return graphError(400, 'ErrorInvalidRequest');
      if (msg.to.length === 0) return graphError(400, 'ErrorInvalidRecipients');
      msg.isDraft = false;
      msg.folder = 'sent';
      return new Response(null, { status: 202 });
    }
    if (sub === 'attachments') {
      if (method === 'GET' && !attId) {
        return json(200, {
          value: msg.attachments.map((a) => ({
            '@odata.type': a.odataType,
            id: a.id,
            name: a.name,
            contentType: a.contentType,
            size: a.data.length,
          })),
        });
      }
      if (method === 'GET' && attId && value === '$value') {
        const att = msg.attachments.find((a) => a.id === attId);
        if (!att) return graphError(404, 'ErrorItemNotFound');
        return new Response(new Uint8Array(att.data), { status: 200 });
      }
      if (method === 'POST' && !attId) {
        const data = Buffer.from(body.contentBytes, 'base64');
        if (data.length > 3 * 1024 * 1024) return graphError(413, 'ErrorRequestEntityTooLarge');
        msg.attachments.push({
          id: randomUUID(),
          odataType: body['@odata.type'],
          name: body.name,
          contentType: body.contentType,
          data,
        });
        return json(201, { id: randomUUID() });
      }
      if (method === 'POST' && attId === 'createUploadSession') {
        const key = randomUUID();
        this.uploads.set(key, {
          draft: msg.id,
          name: body.AttachmentItem.name,
          size: body.AttachmentItem.size,
          parts: [],
        });
        return json(201, { uploadUrl: `https://upload.test/${key}` });
      }
    }
    return graphError(400, 'BadRequest');
  }

  private async uploadPart(path: string, init: RequestInit | undefined) {
    const upload = this.uploads.get(path.slice(1));
    if (!upload) return graphError(404, 'ErrorItemNotFound');
    const range = new Headers(init?.headers).get('content-range') ?? '';
    const [, start, end, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range) ?? [];
    const chunk = Buffer.from(init?.body as Uint8Array);
    const received = upload.parts.reduce((n, p) => n + p.length, 0);
    if (Number(start) !== received || Number(end) - Number(start) + 1 !== chunk.length) {
      return graphError(416, 'InvalidRange');
    }
    if (Number(total) !== upload.size) return graphError(400, 'InvalidSize');
    if (chunk.length % 327_680 !== 0 && Number(end) + 1 !== upload.size) {
      return graphError(400, 'InvalidChunkSize');
    }
    upload.parts.push(chunk);
    if (received + chunk.length < upload.size) {
      return json(200, { nextExpectedRanges: [`${received + chunk.length}-`] });
    }
    const draft = this.messages.find((m) => m.id === upload.draft);
    draft?.attachments.push({
      id: randomUUID(),
      odataType: '#microsoft.graph.fileAttachment',
      name: upload.name,
      contentType: 'application/octet-stream',
      data: Buffer.concat(upload.parts),
    });
    return new Response(null, { status: 201 });
  }

  private draft(init: {
    subject: string;
    to: Address[];
    replyTo?: string;
    conversationId?: string;
  }): ReturnType<FakeGraph['view']> {
    const msg: FakeMessage = {
      id: `AAMkDraft-${randomUUID()}`,
      folder: 'drafts',
      subject: init.subject,
      from: { address: MAILBOX },
      to: init.to,
      body: '',
      uniqueBody: '',
      receivedDateTime: new Date().toISOString(),
      internetMessageId: `<${randomUUID()}@example.prod.outlook.com>`,
      conversationId: init.conversationId ?? `AAQk-${randomUUID()}`,
      headers: [],
      attachments: [],
      isDraft: true,
      seq: ++this.seq,
      ...(init.replyTo ? { replyTo: init.replyTo } : {}),
    };
    this.messages.push(msg);
    return this.view(msg);
  }

  private view(m: FakeMessage) {
    return {
      id: m.id,
      subject: m.subject,
      from: { emailAddress: m.from },
      sender: { emailAddress: m.from },
      toRecipients: m.to.map((emailAddress) => ({ emailAddress })),
      receivedDateTime: m.receivedDateTime,
      isDraft: m.isDraft,
      internetMessageId: m.internetMessageId,
      conversationId: m.conversationId,
      internetMessageHeaders: m.headers,
      body: { contentType: 'text', content: m.body },
      uniqueBody: { contentType: 'text', content: m.uniqueBody },
      hasAttachments: m.attachments.length > 0,
    };
  }
}
