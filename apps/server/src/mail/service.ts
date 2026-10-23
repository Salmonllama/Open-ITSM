import {
  daysUntil,
  MAIL_SECRET_WARN_DAYS,
  type mailSettingsRequestSchema,
  type MailSettings,
  type MailState,
  type MailStatus,
  type MailTestResult,
} from '@open-itsm/shared';
import { and, count, eq, gte } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { AttachmentStore } from '../attachments.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Db } from '../db/client.js';
import { settings, tickets } from '../db/schema.js';
import { GraphClient, GraphError } from './graph.js';
import { pollInbox, type PollResult, type PollState } from './inbound.js';
import { sendReply, type SendOutcome } from './outbound.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const CONFIG_KEY = 'mail';
const STATE_KEY = 'mail.state';
/** Bound to the ciphertext, so the stored secret cannot be moved to another setting. */
const SECRET_CONTEXT = 'mail.client_secret';

type MailInput = z.output<typeof mailSettingsRequestSchema>;

type StoredConfig = {
  tenantId: string;
  clientId: string;
  mailbox: string;
  secretExpiresOn: string;
  enabled: boolean;
  /** Mail received before this is never turned into tickets. */
  connectedAt: string;
};

type StoredState = PollState & {
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string | null;
  lastErrorAt?: string | null;
};

export type MailOptions = {
  secretKey: Buffer;
  graphUrl: string;
  loginUrl: string;
  store: AttachmentStore;
  /** Tests pass a Graph stand-in. */
  fetch?: typeof fetch | undefined;
};

/** How the job queue (or a test) is asked to check the inbox or send a reply soon. */
export type MailQueue = {
  poll(): Promise<void>;
  send(messageId: number): Promise<void>;
};

export class NoSecretError extends Error {}

/**
 * The shared mailbox: its settings (the client secret encrypted, never returned), checking
 * the inbox and sending replies. Every Graph call goes through here.
 */
export class MailService {
  /** Set by the server to the job queue; tests run the work inline. */
  queue: MailQueue = { poll: async () => {}, send: async () => {} };
  /** Told about each ticket an email opens (notifications); set by the server. */
  onTicketCreated: (ticketId: string) => Promise<void> = async () => {};
  private cached: { key: string; client: GraphClient } | null = null;

  constructor(
    readonly db: Db,
    private readonly options: MailOptions,
    private readonly log: Logger,
  ) {}

  private async load(): Promise<{ config: StoredConfig; secret: string | null } | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, CONFIG_KEY));
    if (!row) return null;
    return { config: row.value as StoredConfig, secret: row.secret };
  }

  private async loadState(executor: Pick<Db, 'select'> = this.db): Promise<StoredState> {
    const [row] = await executor.select().from(settings).where(eq(settings.key, STATE_KEY));
    return (row?.value ?? {}) as StoredState;
  }

  private decrypt(stored: string): string {
    return decryptSecret(this.options.secretKey, stored, SECRET_CONTEXT);
  }

  private makeClient(
    input: { tenantId: string; clientId: string; mailbox: string },
    secret: string,
  ) {
    return new GraphClient(
      {
        tenantId: input.tenantId,
        clientId: input.clientId,
        clientSecret: secret,
        mailbox: input.mailbox,
      },
      {
        graphUrl: this.options.graphUrl,
        loginUrl: this.options.loginUrl,
        fetch: this.options.fetch ?? fetch,
      },
    );
  }

  /** One client per saved configuration, so its access token is reused between rounds. */
  private client(config: StoredConfig, storedSecret: string): GraphClient {
    const key = [config.tenantId, config.clientId, config.mailbox, storedSecret].join('|');
    if (this.cached?.key !== key) {
      this.cached = { key, client: this.makeClient(config, this.decrypt(storedSecret)) };
    }
    return this.cached.client;
  }

  /** Checking and sending happen only with a complete, switched-on configuration. */
  async active(): Promise<{ config: StoredConfig; client: GraphClient } | null> {
    const loaded = await this.load();
    if (!loaded?.secret || !loaded.config.enabled) return null;
    return { config: loaded.config, client: this.client(loaded.config, loaded.secret) };
  }

  async status(now = new Date()): Promise<MailStatus> {
    const loaded = await this.load();
    if (!loaded) {
      return {
        state: 'not_configured',
        mailbox: null,
        secretExpiresOn: null,
        lastCheckedAt: null,
        lastError: null,
      };
    }
    const { config } = loaded;
    const state = await this.loadState();
    const failing =
      state.lastError != null &&
      (state.lastSuccessAt === undefined ||
        (state.lastErrorAt != null && state.lastErrorAt > state.lastSuccessAt));
    const days = daysUntil(config.secretExpiresOn, now);
    let value: MailState;
    if (!loaded.secret) value = 'not_configured';
    else if (!config.enabled) value = 'off';
    else if (days < 0) value = 'secret_expired';
    else if (failing) value = 'failing';
    else if (days <= MAIL_SECRET_WARN_DAYS) value = 'secret_expiring';
    else value = 'connected';
    return {
      state: value,
      mailbox: config.mailbox,
      secretExpiresOn: config.secretExpiresOn,
      lastCheckedAt: state.lastCheckedAt ?? null,
      lastError: failing ? (state.lastError ?? null) : null,
    };
  }

  async settings(): Promise<MailSettings> {
    const loaded = await this.load();
    const status = await this.status();
    if (!loaded) {
      return {
        configured: false,
        tenantId: '',
        clientId: '',
        mailbox: '',
        secretExpiresOn: null,
        secretSet: false,
        enabled: false,
        connectedAt: null,
        status,
        ticketsFromEmail: 0,
      };
    }
    const { config } = loaded;
    const [fromEmail] = await this.db
      .select({ n: count() })
      .from(tickets)
      .where(
        and(eq(tickets.source, 'email'), gte(tickets.createdAt, new Date(config.connectedAt))),
      );
    return {
      configured: loaded.secret !== null,
      tenantId: config.tenantId,
      clientId: config.clientId,
      mailbox: config.mailbox,
      secretExpiresOn: config.secretExpiresOn,
      secretSet: loaded.secret !== null,
      enabled: config.enabled,
      connectedAt: config.connectedAt,
      status,
      ticketsFromEmail: fromEmail?.n ?? 0,
    };
  }

  /**
   * Saves the settings. A blank secret keeps the stored one. A new mailbox starts afresh: only
   * mail that arrives from now on becomes tickets. Returns the names of what changed, for the
   * audit log (never the secret itself).
   */
  async save(input: MailInput, actorUserId: string): Promise<string[]> {
    return this.db.transaction(async (tx: Tx) => {
      const [row] = await tx
        .select()
        .from(settings)
        .where(eq(settings.key, CONFIG_KEY))
        .for('update');
      const before = row?.value as StoredConfig | undefined;
      if (!input.clientSecret && !row?.secret) throw new NoSecretError();
      const now = new Date();
      const newMailbox = before?.mailbox.toLowerCase() !== input.mailbox.toLowerCase();
      const config: StoredConfig = {
        tenantId: input.tenantId,
        clientId: input.clientId,
        mailbox: input.mailbox.toLowerCase(),
        secretExpiresOn: input.secretExpiresOn,
        enabled: input.enabled,
        connectedAt: !before || newMailbox ? now.toISOString() : before.connectedAt,
      };
      const secret = input.clientSecret
        ? encryptSecret(this.options.secretKey, input.clientSecret, SECRET_CONTEXT)
        : (row?.secret ?? null);
      await tx
        .insert(settings)
        .values({ key: CONFIG_KEY, value: config, secret, updatedAt: now, updatedBy: actorUserId })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: config, secret, updatedAt: now, updatedBy: actorUserId },
        });
      const changed = (['tenantId', 'clientId', 'mailbox', 'secretExpiresOn', 'enabled'] as const)
        .filter((k) => before?.[k] !== config[k])
        .map(String);
      if (input.clientSecret) changed.push('clientSecret');
      // A different mailbox or app, or new credentials, clears the old errors and sync state.
      if (newMailbox || changed.length > 0) {
        const state = newMailbox ? {} : await this.loadState(tx);
        const fresh: StoredState = newMailbox
          ? {}
          : { ...state, lastError: null, lastErrorAt: null, failures: {} };
        await tx
          .insert(settings)
          .values({ key: STATE_KEY, value: fresh, updatedAt: now })
          .onConflictDoUpdate({ target: settings.key, set: { value: fresh, updatedAt: now } });
      }
      this.cached = null;
      return changed;
    });
  }

  /** Forgets the mailbox and its secret. Tickets and messages stay. */
  async disconnect(): Promise<boolean> {
    const removed = await this.db
      .delete(settings)
      .where(eq(settings.key, CONFIG_KEY))
      .returning({ key: settings.key });
    await this.db.delete(settings).where(eq(settings.key, STATE_KEY));
    this.cached = null;
    return removed.length > 0;
  }

  /**
   * Signs in and opens the mailbox's inbox, without saving anything. A blank secret tests the
   * stored one.
   */
  async test(input: MailInput): Promise<MailTestResult> {
    let secret = input.clientSecret;
    if (!secret) {
      const loaded = await this.load();
      if (!loaded?.secret) throw new NoSecretError();
      secret = this.decrypt(loaded.secret);
    }
    const client = this.makeClient(input, secret);
    try {
      await client.accessToken();
    } catch (err) {
      if (err instanceof GraphError) return { ok: false, step: 'sign_in', message: err.message };
      throw err;
    }
    try {
      await client.request('GET', `${client.mailboxPath}/mailFolders/inbox?$select=id`);
    } catch (err) {
      if (err instanceof GraphError) return { ok: false, step: 'mailbox', message: err.message };
      throw err;
    }
    return {
      ok: true,
      step: null,
      message: `Signed in to Microsoft and opened the inbox of ${input.mailbox}.`,
    };
  }

  /**
   * One round of checking the inbox. The state row is locked for the round, so two rounds never
   * run at once; a second caller returns straight away with null.
   */
  async poll(): Promise<PollResult | null> {
    const active = await this.active();
    if (!active) return null;
    const { config, client } = active;
    return this.db.transaction(async (tx: Tx) => {
      const now = new Date();
      await tx
        .insert(settings)
        .values({ key: STATE_KEY, value: {}, updatedAt: now })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(settings)
        .where(eq(settings.key, STATE_KEY))
        .for('update', { skipLocked: true });
      if (!row) return null;
      const state = row.value as StoredState;
      let result: PollResult | null = null;
      let next: StoredState;
      try {
        result = await pollInbox(
          {
            db: this.db,
            client,
            store: this.options.store,
            log: this.log,
            mailbox: config.mailbox,
            connectedAt: new Date(config.connectedAt),
            onTicketCreated: (id) => this.onTicketCreated(id),
          },
          state,
        );
        next = {
          ...state,
          ...result.state,
          lastCheckedAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          lastError: null,
          lastErrorAt: null,
        };
        if (result.created + result.appended > 0) {
          this.log.info(
            { created: result.created, appended: result.appended },
            'emails turned into tickets',
          );
        }
      } catch (err) {
        const message =
          err instanceof GraphError
            ? err.message
            : 'Checking the mailbox failed. See the app log for details.';
        if (!(err instanceof GraphError)) this.log.error({ err }, 'checking the mailbox failed');
        else this.log.warn({ status: err.status, code: err.code }, 'checking the mailbox failed');
        next = {
          ...state,
          lastCheckedAt: now.toISOString(),
          lastError: message,
          lastErrorAt: now.toISOString(),
        };
      }
      await tx
        .update(settings)
        .set({ value: next, updatedAt: new Date() })
        .where(eq(settings.key, STATE_KEY));
      return result;
    });
  }

  /** Emails one reply; see sendReply. Replies wait while the mailbox is off or not set up. */
  async send(messageId: number, finalAttempt: boolean): Promise<SendOutcome> {
    const active = await this.active();
    if (!active) return 'skipped';
    return sendReply(
      { db: this.db, client: active.client, store: this.options.store, log: this.log },
      messageId,
      { finalAttempt },
    );
  }

  /** Whether a reply saved now will be emailed. */
  async canSend(): Promise<boolean> {
    return (await this.active()) !== null;
  }
}
