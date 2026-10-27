/**
 * Indexer stream cursor helpers.
 */

import { prisma } from "../lib/db";
import type { Prisma } from "@prisma/client";

export async function getStreamCursor(
  stream: string,
  tx?: Prisma.TransactionClient,
): Promise<{ lastLedger: number; lastCursor: string | null }> {
  const client = tx ?? prisma;
  const entry = await client.indexerCursor.findUnique({
    where: { stream },
  });

  if (!entry) {
    return { lastLedger: 0, lastCursor: null };
  }

  return {
    lastLedger: Number(entry.lastLedger),
    lastCursor: entry.lastCursor,
  };
}

export async function updateStreamCursor(
  stream: string,
  lastLedger: number,
  lastCursor: string | null,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? prisma;
  await client.indexerCursor.upsert({
    where: { stream },
    update: {
      lastLedger: BigInt(lastLedger),
      lastCursor,
    },
    create: {
      stream,
      lastLedger: BigInt(lastLedger),
      lastCursor,
    },
  });
}
