import type { PgBoss } from 'pg-boss';
import type { Delivery, NotificationService } from './service.js';

const SEND = 'notify-send';
/** Attempts after the first; with backoff from 30 s this spans about half an hour. */
const SEND_RETRIES = 5;

/** Each Slack or Teams message is a job of its own, retried with backoff when the service is down. */
export async function startNotificationJobs(
  boss: PgBoss,
  notifications: NotificationService,
): Promise<void> {
  await boss.createQueue(SEND, {
    retryLimit: SEND_RETRIES,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 120,
  });
  notifications.queue = {
    send: async (delivery) => {
      await boss.send(SEND, delivery);
    },
  };
  await boss.work<Delivery>(SEND, async ([job]) => {
    if (!job) return;
    await notifications.deliver(job.data, job.retryCount >= SEND_RETRIES);
  });
}
