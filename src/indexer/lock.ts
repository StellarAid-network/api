/**
 * PostgreSQL advisory lock to ensure a single active indexer instance.
 */

import { prisma } from "../lib/db";
import { logger } from "../lib/logger";

export const INDEXER_ADVISORY_LOCK_ID = 884_209_111;

/**
 * Attempts to acquire the exclusive advisory lock. Returns true if acquired.
 */
export async function tryAcquireIndexerLock(lockId: number = INDEXER_ADVISORY_LOCK_ID): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<[{ locked: boolean }]>`
      SELECT pg_try_advisory_lock(${lockId}) as locked;
    `;
    const locked = Boolean(result[0]?.locked);
    if (locked) {
      logger.info({ lockId }, "acquired indexer advisory lock");
    } else {
      logger.warn({ lockId }, "failed to acquire indexer advisory lock; another instance is running");
    }
    return locked;
  } catch (err) {
    logger.error({ err, lockId }, "error acquiring indexer advisory lock");
    return false;
  }
}

/**
 * Releases the advisory lock.
 */
export async function releaseIndexerLock(lockId: number = INDEXER_ADVISORY_LOCK_ID): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<[{ unlocked: boolean }]>`
      SELECT pg_advisory_unlock(${lockId}) as unlocked;
    `;
    const unlocked = Boolean(result[0]?.unlocked);
    logger.info({ lockId, unlocked }, "released indexer advisory lock");
    return unlocked;
  } catch (err) {
    logger.error({ err, lockId }, "error releasing indexer advisory lock");
    return false;
  }
}
