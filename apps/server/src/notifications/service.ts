import { randomUUID } from 'node:crypto';
import {
  shouldPostLowStock,
  type ChannelTestResult,
  type createChannelRequestSchema,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationSettings,
  type TicketSource,
  type updateChannelRequestSchema,
} from '@open-itsm/shared';
import { and, arrayContains, asc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { decryptSecret, encryptSecret, SecretDecryptError } from '../crypto.js';
import type { Db } from '../db/client.js';
import { consumables, notificationChannels, tickets, users } from '../db/schema.js';
import { isUniqueViolation } from '../routes/deps.js';
import { DeliveryError, post, webhookHint, type Notice } from './messages.js';

type ChannelRow = typeof notificationChannels.$inferSelect;
type CreateInput = z.output<typeof createChannelRequestSchema>;
type UpdateInput = z.output<typeof updateChannelRequestSchema>;

/** One message to one channel, as a job. */
export type Delivery = { channelId: string; notice: Notice };

/** How the job queue (or a test) is asked to post a message soon. */
export type NotifyQueue = { send(delivery: Delivery): Promise<void> };

export type NotificationOptions = {
  secretKey: Buffer;
  /** `https://<APP_HOSTNAME>`; null leaves links out. */
  siteUrl: string | null;
  /** Tests pass a stand-in for Slack and Teams. */
  fetch?: typeof fetch | undefined;
};

/** Bound to the ciphertext, so one channel's URL cannot be moved to another. */
const urlContext = (id: string) => `notification_channel.webhook_url:${id}`;

const SOURCE_DETAIL: Record<TicketSource, string> = {
  email: 'Came in by email',
  dashboard: 'Opened on the dashboard',
  api: 'Opened through the API',
};

const NAME_KEY = 'notification_channels_name_key';

export class ChannelNameTakenError extends Error {}

/**
 * Slack and Teams channels: their settings (each webhook URL encrypted, never returned), and
 * the messages they get about new tickets, assignments and low stock. Telling channels never
 * fails the change that caused it: each message is a job of its own, retried with backoff.
 */
export class NotificationService {
  /** Set by the server to the job queue; until then (and in tests) messages go out inline. */
  queue: NotifyQueue = {
    send: async (delivery) => {
      await this.deliver(delivery, true);
    },
  };

  constructor(
    private readonly db: Db,
    private readonly options: NotificationOptions,
    private readonly log: Logger,
  ) {}

  get siteUrl(): string | null {
    return this.options.siteUrl;
  }

  private view(row: ChannelRow): NotificationChannel {
    const failing =
      row.lastErrorAt !== null && (row.lastSentAt === null || row.lastErrorAt > row.lastSentAt);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      webhookHint: row.webhookHint,
      events: row.events,
      lowStockMode: row.lowStockMode,
      enabled: row.enabled,
      lastSentAt: row.lastSentAt?.toISOString() ?? null,
      lastError: failing ? row.lastError : null,
      lastErrorAt: failing ? (row.lastErrorAt?.toISOString() ?? null) : null,
    };
  }

  async settings(): Promise<NotificationSettings> {
    const rows = await this.db
      .select()
      .from(notificationChannels)
      .orderBy(asc(sql`lower(${notificationChannels.name})`));
    return { channels: rows.map((r) => this.view(r)), siteUrl: this.options.siteUrl };
  }

  async channel(id: string): Promise<NotificationChannel | undefined> {
    const [row] = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id));
    return row ? this.view(row) : undefined;
  }

  private sealed(id: string, url: string) {
    return {
      webhookUrl: encryptSecret(this.options.secretKey, url, urlContext(id)),
      webhookHint: webhookHint(url),
    };
  }

  async create(input: CreateInput): Promise<NotificationChannel> {
    const id = randomUUID();
    try {
      const [row] = await this.db
        .insert(notificationChannels)
        .values({
          id,
          name: input.name,
          kind: input.kind,
          events: [...new Set(input.events)],
          lowStockMode: input.lowStockMode,
          enabled: input.enabled,
          ...this.sealed(id, input.webhookUrl),
        })
        .returning();
      if (!row) throw new Error('channel insert returned nothing');
      return this.view(row);
    } catch (err) {
      throw isUniqueViolation(err, NAME_KEY) ? new ChannelNameTakenError() : err;
    }
  }

  /**
   * Saves a channel; a blank URL keeps the stored one. Returns the names of what changed, for
   * the audit log (never the URL), or undefined when there is no such channel.
   */
  async update(
    id: string,
    input: UpdateInput,
  ): Promise<{ channel: NotificationChannel; changed: string[] } | undefined> {
    const [before] = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id));
    if (!before) return undefined;
    const events = [...new Set(input.events)];
    try {
      const [row] = await this.db
        .update(notificationChannels)
        .set({
          name: input.name,
          events,
          lowStockMode: input.lowStockMode,
          enabled: input.enabled,
          updatedAt: new Date(),
          // A new URL starts with a clean record.
          ...(input.webhookUrl
            ? { ...this.sealed(id, input.webhookUrl), lastError: null, lastErrorAt: null }
            : {}),
        })
        .where(eq(notificationChannels.id, id))
        .returning();
      if (!row) return undefined;
      const changed: string[] = [];
      if (before.name !== row.name) changed.push('name');
      if ([...before.events].sort().join() !== [...row.events].sort().join()) {
        changed.push('events');
      }
      if (before.lowStockMode !== row.lowStockMode) changed.push('lowStockMode');
      if (before.enabled !== row.enabled) changed.push('enabled');
      if (input.webhookUrl) changed.push('webhookUrl');
      return { channel: this.view(row), changed };
    } catch (err) {
      throw isUniqueViolation(err, NAME_KEY) ? new ChannelNameTakenError() : err;
    }
  }

  async remove(id: string): Promise<{ name: string; kind: string } | undefined> {
    const [row] = await this.db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .returning({ name: notificationChannels.name, kind: notificationChannels.kind });
    return row;
  }

  /** Posts a test message to a channel now, whether or not it is switched on. */
  async test(id: string): Promise<ChannelTestResult | undefined> {
    const [row] = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id));
    if (!row) return undefined;
    const notice: Notice = {
      title: 'Test message from Open ITSM',
      detail: `This channel will be told about: ${describeEvents(row.events)}.`,
      link: this.link('Open Open ITSM', '/'),
    };
    try {
      await this.postTo(row, notice);
      return { ok: true, message: `Sent a test message to ${row.name}.` };
    } catch (err) {
      if (err instanceof DeliveryError) return { ok: false, message: err.message };
      throw err;
    }
  }

  private link(label: string, path: string): Notice['link'] {
    return this.options.siteUrl ? { label, url: `${this.options.siteUrl}${path}` } : undefined;
  }

  /** Posts to a channel and records the outcome on it. */
  private async postTo(row: ChannelRow, notice: Notice): Promise<void> {
    try {
      let url: string;
      try {
        url = decryptSecret(this.options.secretKey, row.webhookUrl, urlContext(row.id));
      } catch (err) {
        if (!(err instanceof SecretDecryptError)) throw err;
        throw new DeliveryError(
          'The stored webhook URL cannot be read (was APP_SECRET_KEY changed?). Paste the URL again.',
          false,
        );
      }
      await post(this.options.fetch ?? fetch, row.kind, url, notice);
    } catch (err) {
      if (err instanceof DeliveryError) {
        await this.db
          .update(notificationChannels)
          .set({ lastError: err.message, lastErrorAt: new Date() })
          .where(eq(notificationChannels.id, row.id));
      }
      throw err;
    }
    await this.db
      .update(notificationChannels)
      .set({ lastSentAt: new Date() })
      .where(eq(notificationChannels.id, row.id));
  }

  /**
   * Sends one queued message. A temporary failure throws, so the job is tried again, unless
   * this is the last attempt; a channel switched off or removed since is passed over.
   */
  async deliver(delivery: Delivery, last: boolean): Promise<void> {
    const [row] = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, delivery.channelId));
    if (!row?.enabled) return;
    try {
      await this.postTo(row, delivery.notice);
    } catch (err) {
      if (err instanceof DeliveryError) {
        this.log.warn(
          { channelId: row.id, kind: row.kind, temporary: err.temporary, reason: err.message },
          'a notification did not go through',
        );
        if (err.temporary && !last) throw err;
        return;
      }
      throw err;
    }
  }

  /** Queues a message for every switched-on channel that wants this event. */
  private async announce(
    event: NotificationEvent,
    build: () => Promise<Notice | undefined>,
    wants: (row: ChannelRow) => boolean = () => true,
  ): Promise<void> {
    try {
      const rows = (
        await this.db
          .select()
          .from(notificationChannels)
          .where(
            and(
              eq(notificationChannels.enabled, true),
              arrayContains(notificationChannels.events, [event]),
            ),
          )
      ).filter(wants);
      if (rows.length === 0) return;
      const notice = await build();
      if (!notice) return;
      for (const row of rows) await this.queue.send({ channelId: row.id, notice });
    } catch (err) {
      // A notification is never worth failing the change that caused it.
      this.log.error({ err, event }, 'could not queue a notification');
    }
  }

  async ticketCreated(ticketId: string): Promise<void> {
    await this.announce('ticket_created', async () => {
      const [t] = await this.db
        .select({ number: tickets.number, subject: tickets.subject, source: tickets.source })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!t) return undefined;
      return {
        title: `New ticket #${t.number}: ${t.subject}`,
        detail: SOURCE_DETAIL[t.source],
        link: this.link('Open ticket', `/tickets/${ticketId}`),
      };
    });
  }

  async ticketAssigned(ticketId: string): Promise<void> {
    await this.announce('ticket_assigned', async () => {
      const [t] = await this.db
        .select({ number: tickets.number, subject: tickets.subject, assignee: users.name })
        .from(tickets)
        .innerJoin(users, eq(users.id, tickets.assigneeId))
        .where(eq(tickets.id, ticketId));
      if (!t) return undefined;
      return {
        title: `Ticket #${t.number} assigned: ${t.subject}`,
        detail: `Assigned to ${t.assignee}`,
        link: this.link('Open ticket', `/tickets/${ticketId}`),
      };
    });
  }

  /** After stock changed from `before` to `after`; each channel's rule decides whether to post. */
  async stockChanged(consumableId: string, before: number, after: number): Promise<void> {
    if (after >= before) return;
    const [item] = await this.db
      .select({ name: consumables.name, threshold: consumables.lowStockThreshold })
      .from(consumables)
      .where(eq(consumables.id, consumableId))
      .catch((err: unknown) => {
        this.log.error({ err }, 'could not read a consumable for a notification');
        return [];
      });
    if (!item) return;
    const change = { before, after, threshold: item.threshold };
    await this.announce(
      'low_stock',
      async () => ({
        title: `Low stock: ${item.name}`,
        detail: `${after} left (low at ${item.threshold} or fewer)`,
        link: this.link('Open item', `/consumables/${consumableId}`),
      }),
      (row) => shouldPostLowStock(row.lowStockMode, change),
    );
  }
}

const EVENT_WORDS: Record<NotificationEvent, string> = {
  ticket_created: 'new tickets',
  ticket_assigned: 'assigned tickets',
  low_stock: 'low stock',
};

function describeEvents(events: NotificationEvent[]): string {
  return events.length === 0 ? 'nothing yet' : events.map((e) => EVENT_WORDS[e]).join(', ');
}
