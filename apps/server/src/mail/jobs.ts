import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { AttachmentStore } from '../attachments.js';
import type { Db } from '../db/client.js';
import { removeAbandonedUploads } from '../routes/ticket-attachments.js';
import { queuedReplies } from './outbound.js';
import type { MailService } from './service.js';

const POLL = 'mail-poll';
const SEND = 'mail-send';
const HOUSEKEEPING = 'mail-housekeeping';

/** A queued reply with no job this long (a restart lost it) is queued again. */
const LOST_AFTER_MS = 15 * 60 * 1000;
/** Send attempts after the first; with backoff from 30 s this spans about an hour. */
const SEND_RETRIES = 6;

/**
 * The background work: check the inbox every minute, send each reply as its own job (retried
 * with backoff when Microsoft is unavailable), and tidy up hourly.
 */
export async function startMailJobs(
  boss: PgBoss,
  deps: { db: Db; mail: MailService; store: AttachmentStore; log: Logger },
): Promise<void> {
  const { db, mail, store, log } = deps;
  // One check at a time, and never a backlog of them.
  await boss.createQueue(POLL, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 600 });
  // One job per reply at a time; retried for about an hour before it is marked failed.
  await boss.createQueue(SEND, {
    policy: 'stately',
    retryLimit: SEND_RETRIES,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 1200,
    expireInSeconds: 900,
  });
  await boss.createQueue(HOUSEKEEPING, { policy: 'exclusive', retryLimit: 0 });

  mail.queue = {
    poll: async () => {
      await boss.send(POLL, {});
    },
    send: async (messageId) => {
      await boss.send(SEND, { messageId }, { singletonKey: String(messageId) });
    },
  };

  await boss.work(POLL, async () => {
    await mail.poll();
  });
  await boss.work<{ messageId: number }>(SEND, async ([job]) => {
    if (!job) return;
    await mail.send(job.data.messageId, job.retryCount >= SEND_RETRIES);
  });
  await boss.work(HOUSEKEEPING, async () => {
    await removeAbandonedUploads(db, store, log);
    if (await mail.canSend()) {
      for (const id of await queuedReplies(db, new Date(Date.now() - LOST_AFTER_MS))) {
        await mail.queue.send(id);
      }
    }
  });

  await boss.schedule(POLL, '* * * * *');
  await boss.schedule(HOUSEKEEPING, '17 * * * *');
}
