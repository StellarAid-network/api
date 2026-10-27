/**
 * Indexer backfill CLI script.
 * Usage: pnpm indexer:backfill --from <ledger> [--to <ledger>]
 */

import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { fetchSorobanEvents } from "./soroban";
import { handleHelpRequestEvent } from "./handlers/help-request";
import { getHelpRequestContractId } from "./runner";
import { updateStreamCursor } from "./cursor";
import { decodeEvent } from "@stellar-aid/sdk";

export interface BackfillOptions {
  fromLedger: number;
  toLedger?: number;
  contractId?: string;
  batchLimit?: number;
}

export async function runBackfill(options: BackfillOptions): Promise<{
  processedCount: number;
  lastLedger: number;
}> {
  const contractId = options.contractId || getHelpRequestContractId();
  let currentLedger = options.fromLedger;
  const targetLedger = options.toLedger;
  const limit = options.batchLimit || 100;
  let processedCount = 0;

  logger.info(
    { fromLedger: currentLedger, toLedger: targetLedger, contractId },
    "starting indexer backfill",
  );

  while (true) {
    if (targetLedger && currentLedger > targetLedger) {
      break;
    }

    const result = await fetchSorobanEvents(contractId, currentLedger, limit);
    if (!result.events || result.events.length === 0) {
      if (result.latestLedger > currentLedger) {
        currentLedger = result.latestLedger;
      }
      break;
    }

    for (const raw of result.events) {
      if (targetLedger && raw.ledger > targetLedger) {
        break;
      }

      await prisma.$transaction(async (tx) => {
        const existing = await tx.processedEvent.findUnique({
          where: { eventId: raw.id },
        });

        if (!existing) {
          await tx.processedEvent.create({
            data: {
              eventId: raw.id,
              ledger: BigInt(raw.ledger),
            },
          });

          try {
            const decoded = decodeEvent({
              topic: raw.topic,
              value: raw.value,
              contractId: raw.contractId,
              ledger: raw.ledger,
            });
            await handleHelpRequestEvent(decoded, tx, {
              eventId: raw.id,
              ledger: raw.ledger,
            });
          } catch (decErr) {
            logger.warn({ err: decErr, eventId: raw.id }, "failed to decode event during backfill");
          }

          processedCount++;
        }

        await updateStreamCursor("soroban:help_request", raw.ledger, raw.id, tx);
      });

      currentLedger = raw.ledger;
    }

    if (result.events.length < limit) {
      break;
    }

    currentLedger++;
  }

  logger.info(
    { processedCount, finalLedger: currentLedger },
    "indexer backfill completed successfully",
  );

  return { processedCount, lastLedger: currentLedger };
}

// CLI entry point
if (process.argv[1]?.endsWith("backfill.ts") || process.argv[1]?.endsWith("backfill.js")) {
  const args = process.argv.slice(2);
  let from = 1;
  let to: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      from = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--to" && args[i + 1]) {
      to = parseInt(args[i + 1]!, 10);
      i++;
    }
  }

  runBackfill({ fromLedger: from, toLedger: to })
    .catch((err) => {
      logger.error({ err }, "backfill failed");
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
