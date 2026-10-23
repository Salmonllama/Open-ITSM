import { z } from 'zod';

/** Where a channel posts: a Slack incoming webhook or a Teams Workflows webhook. */
export const CHANNEL_KINDS = ['slack', 'teams'] as const;
export const channelKindSchema = z.enum(CHANNEL_KINDS);
export type ChannelKind = z.infer<typeof channelKindSchema>;

/** What a channel can be told about. */
export const NOTIFICATION_EVENTS = ['ticket_created', 'ticket_assigned', 'low_stock'] as const;
export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

/**
 * When low stock is posted: `first` once an item drops to its threshold (again only after it
 * was restocked above it), `every` on each use or count that leaves it at or below.
 */
export const LOW_STOCK_MODES = ['first', 'every'] as const;
export const lowStockModeSchema = z.enum(LOW_STOCK_MODES);
export type LowStockMode = z.infer<typeof lowStockModeSchema>;

/** Hosts a webhook URL may point at, per kind; anything else is refused. */
const SLACK_HOSTS = ['hooks.slack.com', 'hooks.slack-gov.com'];
/** Teams Workflows webhooks (Power Automate); `.us` is the US government cloud. */
const TEAMS_HOST_SUFFIXES = ['.powerplatform.com', '.powerplatform.us'];

/**
 * Why a webhook URL cannot be used for a channel of this kind, or null when it can. Only
 * https URLs on the service's own hosts are accepted, so a channel cannot be pointed at a
 * machine inside the network.
 */
export function webhookUrlProblem(kind: ChannelKind, value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Paste the whole webhook URL, starting with https://';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return 'Paste the whole webhook URL, starting with https://';
  }
  const host = url.hostname.toLowerCase();
  if (kind === 'slack') {
    return SLACK_HOSTS.includes(host) && url.pathname.startsWith('/services/')
      ? null
      : 'That is not a Slack incoming webhook URL. It starts with https://hooks.slack.com/services/';
  }
  if (host.endsWith('.webhook.office.com') || host.endsWith('.logic.azure.com')) {
    return 'Microsoft has retired that kind of Teams webhook. Create a workflow from the "Send webhook alerts to a channel" template and paste its URL.';
  }
  return TEAMS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    ? null
    : 'That is not a Teams workflow URL. Copy it from the "When a Teams webhook request is received" step of the workflow.';
}

const channelFields = {
  name: z.string().trim().min(1, 'Enter a name').max(100),
  events: z.array(notificationEventSchema).max(NOTIFICATION_EVENTS.length),
  lowStockMode: lowStockModeSchema.default('first'),
  enabled: z.boolean().default(true),
};

export const createChannelRequestSchema = z
  .object({
    ...channelFields,
    kind: channelKindSchema,
    webhookUrl: z.string().trim().min(1, 'Paste the webhook URL').max(2048),
  })
  .superRefine((value, ctx) => {
    const problem = webhookUrlProblem(value.kind, value.webhookUrl);
    if (problem) ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: problem });
  });
export type CreateChannelRequest = z.input<typeof createChannelRequestSchema>;

/** The kind never changes; a blank `webhookUrl` keeps the stored one. */
export const updateChannelRequestSchema = z.object({
  ...channelFields,
  webhookUrl: z.string().trim().max(2048).default(''),
});
export type UpdateChannelRequest = z.input<typeof updateChannelRequestSchema>;

export const notificationChannelSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: channelKindSchema,
  /** Enough of the webhook URL to recognise it; the URL itself is never returned. */
  webhookHint: z.string(),
  events: z.array(notificationEventSchema),
  lowStockMode: lowStockModeSchema,
  enabled: z.boolean(),
  lastSentAt: z.iso.datetime().nullable(),
  /** The last failure, until a later message goes through. */
  lastError: z.string().nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
});
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationSettingsSchema = z.object({
  channels: z.array(notificationChannelSchema),
  /** The address links in messages point to (from APP_HOSTNAME), or null when it is not set. */
  siteUrl: z.string().nullable(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const channelTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type ChannelTestResult = z.infer<typeof channelTestResultSchema>;

/** Whether a stock change is posted under a channel's low-stock rule. */
export function shouldPostLowStock(
  mode: LowStockMode,
  change: { before: number; after: number; threshold: number },
): boolean {
  const { before, after, threshold } = change;
  // A threshold of 0 never flags an item; only a drop can make it low.
  if (threshold <= 0 || after >= before || after > threshold) return false;
  return mode === 'every' || before > threshold;
}
