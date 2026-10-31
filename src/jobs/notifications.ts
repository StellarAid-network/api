/**
 * BullMQ notifications queue and worker (in-app records only; no email or SMS).
 *
 * Supported notification kinds:
 * - `contribution_received`
 * - `goal_reached`
 * - `goal_failed`
 * - `milestone_approved`
 * - `comment_on_post`
 */

import { Queue, Worker, type Job } from "bullmq";
import { config } from "../config";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { setNotificationsQueueDepth } from "../indexer/metrics";

export type NotificationKind =
  | "contribution_received"
  | "goal_reached"
  | "goal_failed"
  | "milestone_approved"
  | "comment_on_post";

export interface NotificationJobPayload {
  recipient: string;
  kind: NotificationKind;
  title: string;
  body: string;
  refId?: string;
}

export const NOTIFICATIONS_QUEUE_NAME = "stellaraid-notifications";

let notificationsQueue: Queue<NotificationJobPayload> | null = null;
let notificationsWorker: Worker<NotificationJobPayload> | null = null;

function parseRedisConnection(redisUrl: string): {
  host: string;
  port: number;
  password?: string;
  maxRetriesPerRequest: null;
  enableOfflineQueue: false;
} {
  try {
    const parsed = new URL(redisUrl);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: 6379,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    };
  }
}

/**
 * Persist an in-app notification record into PostgreSQL via Prisma.
 */
export async function processNotificationJob(payload: NotificationJobPayload): Promise<void> {
  if (!payload.recipient) return;

  const notificationDelegate = (
    prisma as unknown as {
      notification?: {
        create?: (args: {
          data: {
            recipient: string;
            kind: string;
            title: string;
            body: string;
            refId: string | null;
          };
        }) => Promise<unknown>;
      };
    }
  ).notification;

  if (!notificationDelegate?.create) return;

  try {
    await notificationDelegate.create({
      data: {
        recipient: payload.recipient,
        kind: payload.kind,
        title: payload.title,
        body: payload.body,
        refId: payload.refId ?? null,
      },
    });
  } catch (err) {
    logger.warn(
      { err, kind: payload.kind, recipient: payload.recipient },
      "failed to persist notification",
    );
  }
}

function getOrCreateQueue(): Queue<NotificationJobPayload> | null {
  if (config.nodeEnv === "test") {
    return null;
  }
  if (!notificationsQueue) {
    notificationsQueue = new Queue<NotificationJobPayload>(NOTIFICATIONS_QUEUE_NAME, {
      connection: parseRedisConnection(config.redisUrl),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 500,
        removeOnFail: 1_000,
      },
    });
  }
  return notificationsQueue;
}

/**
 * Enqueue an in-app notification job via BullMQ (falls back to direct processing in `test`
 * or when Redis is temporarily unreachable so notifications are never silently dropped).
 */
export async function enqueueNotification(payload: NotificationJobPayload): Promise<void> {
  if (!payload.recipient) return;

  const queue = getOrCreateQueue();
  if (queue) {
    try {
      await queue.add(payload.kind, payload);
      const waiting = await queue.getWaitingCount().catch(() => 0);
      setNotificationsQueueDepth(waiting);
      return;
    } catch (err) {
      logger.warn(
        { err, kind: payload.kind },
        "BullMQ enqueue failed; falling back to inline notification persistence",
      );
    }
  }

  await processNotificationJob(payload);
}

/**
 * Start the BullMQ notifications worker (called by server/worker bootstrap in non-test environments).
 */
export function startNotificationsWorker(): Worker<NotificationJobPayload> {
  if (notificationsWorker) {
    return notificationsWorker;
  }

  notificationsWorker = new Worker<NotificationJobPayload>(
    NOTIFICATIONS_QUEUE_NAME,
    async (job: Job<NotificationJobPayload>) => {
      await processNotificationJob(job.data);
      const queue = getOrCreateQueue();
      if (queue) {
        const waiting = await queue.getWaitingCount().catch(() => 0);
        setNotificationsQueueDepth(waiting);
      }
    },
    {
      connection: parseRedisConnection(config.redisUrl),
      concurrency: 5,
    },
  );

  notificationsWorker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id, kind: job?.name }, "notification job failed");
  });

  return notificationsWorker;
}

/**
 * Gracefully close the BullMQ worker and queue connections.
 */
export async function stopNotificationsWorker(): Promise<void> {
  if (notificationsWorker) {
    await notificationsWorker.close();
    notificationsWorker = null;
  }
  if (notificationsQueue) {
    await notificationsQueue.close();
    notificationsQueue = null;
  }
}
