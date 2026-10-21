/**
 * A small Microsoft Graph client for one shared mailbox, using the client credentials flow
 * (application permissions). Only what Open ITSM needs: read the inbox by delta query, read
 * messages and attachments, and send replies.
 */

export type GraphCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
};

export type GraphEndpoints = {
  /** `https://graph.microsoft.com/v1.0`, or a stand-in in tests. */
  graphUrl: string;
  /** `https://login.microsoftonline.com`, or a stand-in in tests. */
  loginUrl: string;
  fetch: typeof fetch;
};

/** A Graph or sign-in failure, with a message an administrator can act on. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly step: 'sign_in' | 'mailbox',
    readonly status: number | null,
    readonly code: string | null,
    /** Worth trying again later: throttling, timeouts and Microsoft's own outages. */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const TIMEOUT_MS = 30_000;

/** Sign-in errors by AADSTS code, in the words the settings page shows. */
function signInMessage(description: string, tenantId: string): string {
  const code = /AADSTS(\d+)/.exec(description)?.[1];
  switch (code) {
    case '90002':
    case '900023':
      return `Microsoft does not know the directory (tenant) ID ${tenantId}. Copy it from the app registration's Overview page.`;
    case '700016':
      return 'No app with that application (client) ID is registered in this directory. Check the client ID and the tenant ID.';
    case '7000215':
      return "Microsoft refused the client secret. Copy the secret's Value, not its Secret ID, or create a new secret.";
    case '7000222':
      return 'The client secret has expired. Create a new secret in the app registration, then enter it and its expiry date here.';
    case '7000112':
      return 'The app registration is disabled in Entra ID. Enable it, then test again.';
    default: {
      const first = description.split(/\r?\n/)[0]?.replace(/^AADSTS\d+:\s*/, '') ?? '';
      return `Microsoft refused the sign-in${first ? `: ${first.slice(0, 300)}` : '.'}`;
    }
  }
}

function graphMessage(status: number, code: string | null, mailbox: string): string {
  if (status === 401) {
    return 'Microsoft refused the app. Check that the app has the Mail permissions and that admin consent was granted.';
  }
  if (status === 403 || code === 'ErrorAccessDenied') {
    return `The app is not allowed to use ${mailbox}. Give it the Application Mail.ReadWrite and Application Mail.Send roles scoped to this mailbox, as the setup steps show. Changes can take up to an hour to apply.`;
  }
  if (status === 404 || code === 'ErrorInvalidUser' || code === 'MailboxNotEnabledForRESTAPI') {
    return `Microsoft found no mailbox ${mailbox}. Check the address; a shared mailbox must exist in Exchange Online.`;
  }
  if (status === 429)
    return 'Microsoft is limiting requests from this app. It will try again shortly.';
  if (status >= 500)
    return `Microsoft's mail service returned an error (${status}). It will try again shortly.`;
  return `Microsoft Graph refused the request (${status}${code ? ` ${code}` : ''}).`;
}

type RequestOptions = {
  body?: unknown;
  /** Extra headers, such as Prefer. */
  headers?: Record<string, string>;
  /** Read the response as bytes rather than JSON. */
  binary?: boolean;
};

export class GraphClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    readonly credentials: GraphCredentials,
    private readonly endpoints: GraphEndpoints,
  ) {}

  /** `/users/<mailbox>`: every mail call goes through the one shared mailbox. */
  get mailboxPath(): string {
    return `/users/${encodeURIComponent(this.credentials.mailbox)}`;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.endpoints.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new GraphError(
        `Could not reach Microsoft (${reason}). Check the server's internet access.`,
        'sign_in',
        null,
        null,
        true,
      );
    }
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const { tenantId, clientId, clientSecret } = this.credentials;
    const res = await this.fetchWithTimeout(
      `${this.endpoints.loginUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: GRAPH_SCOPE,
          grant_type: 'client_credentials',
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new GraphError(
        signInMessage(body.error_description ?? body.error ?? '', tenantId),
        'sign_in',
        res.status,
        body.error ?? null,
        res.status >= 500,
      );
    }
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  /** Calls Graph. `path` is relative to the Graph URL, or a full nextLink/deltaLink. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.endpoints.graphUrl}${path}`;
    this.assertGraphUrl(url);
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.fetchWithTimeout(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      if (res.ok) {
        if (options.binary) return Buffer.from(await res.arrayBuffer()) as T;
        if (res.status === 202 || res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      // Throttled briefly: wait as asked, once, rather than failing the whole round.
      const retryAfter = Number(res.headers.get('retry-after'));
      if ((res.status === 429 || res.status === 503) && attempt === 0 && retryAfter <= 10) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfter, 1) * 1000));
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      const code = err.error?.code ?? null;
      throw new GraphError(
        graphMessage(res.status, code, this.credentials.mailbox),
        'mailbox',
        res.status,
        code,
        res.status === 429 || res.status >= 500,
      );
    }
  }

  /** Uploads one chunk to an attachment upload session, which takes no bearer token. */
  async uploadChunk(uploadUrl: string, chunk: Buffer, start: number, total: number) {
    const res = await this.fetchWithTimeout(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length),
        'content-range': `bytes ${start}-${start + chunk.length - 1}/${total}`,
      },
      body: chunk,
    });
    if (!res.ok) {
      throw new GraphError(
        graphMessage(res.status, null, this.credentials.mailbox),
        'mailbox',
        res.status,
        null,
        res.status === 429 || res.status >= 500,
      );
    }
  }

  /** Links Graph hands back (nextLink, deltaLink) must stay on the Graph host. */
  private assertGraphUrl(url: string) {
    if (new URL(url).origin !== new URL(this.endpoints.graphUrl).origin) {
      throw new GraphError(
        'Microsoft Graph returned a link to another host.',
        'mailbox',
        null,
        null,
        false,
      );
    }
  }
}
