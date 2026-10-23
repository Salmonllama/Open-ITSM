import type { ChannelKind } from '@open-itsm/shared';

/** What a message says, whichever service it goes to. Never a ticket's body. */
export type Notice = {
  title: string;
  detail: string;
  /** The button under the message; left out when the site address is not set. */
  link?: { label: string; url: string } | undefined;
};

const TITLE_MAX = 300;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Slack reads `&`, `<` and `>` as markup (links, mentions such as <!channel>); these stop that. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An incoming webhook message: the title in bold, the detail, and a button. */
function slackPayload(notice: Notice) {
  const title = slackEscape(clip(notice.title, TITLE_MAX));
  const detail = slackEscape(clip(notice.detail, TITLE_MAX));
  return {
    text: `${title}\n${detail}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${detail}` } },
      ...(notice.link
        ? [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: notice.link.label },
                  url: notice.link.url,
                },
              ],
            },
          ]
        : []),
    ],
  };
}

/**
 * The body the Teams "Send webhook alerts to a channel" workflow expects: a message whose
 * attachments are Adaptive Cards. Text goes in TextRuns, which Teams never reads as markdown,
 * so a subject cannot turn into a link.
 */
function teamsPayload(notice: Notice) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'RichTextBlock',
              inlines: [
                {
                  type: 'TextRun',
                  text: clip(notice.title, TITLE_MAX),
                  weight: 'Bolder',
                  size: 'Medium',
                },
              ],
            },
            {
              type: 'RichTextBlock',
              inlines: [{ type: 'TextRun', text: clip(notice.detail, TITLE_MAX), isSubtle: true }],
            },
          ],
          ...(notice.link
            ? {
                actions: [
                  { type: 'Action.OpenUrl', title: notice.link.label, url: notice.link.url },
                ],
              }
            : {}),
        },
      },
    ],
  };
}

export function payloadFor(kind: ChannelKind, notice: Notice): unknown {
  return kind === 'slack' ? slackPayload(notice) : teamsPayload(notice);
}

const SERVICE: Record<ChannelKind, string> = { slack: 'Slack', teams: 'Teams' };

/** A failed post: `temporary` ones are tried again later. The message never holds the URL. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly temporary: boolean,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** Short service error codes (Slack answers `no_service`, `invalid_payload` and the like). */
function reasonIn(body: string): string {
  const text = body.trim();
  return /^[a-z0-9_ .-]{1,60}$/i.test(text) ? ` (${text})` : '';
}

/** What a failed response means, in words an admin can act on. */
export function deliveryError(kind: ChannelKind, status: number, body: string): DeliveryError {
  const service = SERVICE[kind];
  if (status === 429) {
    return new DeliveryError(
      `${service} is limiting messages right now. It will be tried again.`,
      true,
    );
  }
  if (status >= 500) {
    return new DeliveryError(
      `${service} is not available right now (status ${status}). It will be tried again.`,
      true,
    );
  }
  if (status === 404 || status === 410) {
    return new DeliveryError(
      kind === 'slack'
        ? 'Slack says this webhook no longer exists. Create a new incoming webhook and paste its URL.'
        : 'Teams says this workflow no longer exists. Create the workflow again and paste its URL.',
      false,
    );
  }
  if (status === 401 || status === 403) {
    return new DeliveryError(
      kind === 'slack'
        ? `Slack refused the message${reasonIn(body)}. Check the app is still installed and the channel still exists.`
        : 'Teams refused the message. Check the workflow is switched on and its owner can still post to the channel.',
      false,
    );
  }
  return new DeliveryError(
    `${service} refused the message (status ${status})${reasonIn(body)}. Check the webhook URL.`,
    false,
  );
}

/** Posts one message; throws DeliveryError when it did not go through. */
export async function post(
  fetcher: typeof fetch,
  kind: ChannelKind,
  url: string,
  notice: Notice,
): Promise<void> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payloadFor(kind, notice)),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Never the error itself: it can carry the URL, which is a credential.
    throw new DeliveryError(
      `Could not reach ${SERVICE[kind]}. Check this server can make outbound https connections. It will be tried again.`,
      true,
    );
  }
  if (res.ok) {
    await res.body?.cancel();
    return;
  }
  const body = await res.text().catch(() => '');
  throw deliveryError(kind, res.status, body);
}

/** Enough of a webhook URL to tell channels apart: its host and last four characters. */
export function webhookHint(value: string): string {
  const url = new URL(value);
  // Teams URLs all end in /invoke; their signature is what differs.
  const tail = (url.searchParams.get('sig') ?? url.pathname.replace(/\/+$/, '')).slice(-4);
  // Teams hosts are long (default….environment.api.powerplatform.com); the end is enough.
  const host = url.hostname.split('.').slice(-3).join('.');
  return `${host} …${tail}`;
}
