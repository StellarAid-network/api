/**
 * Indexer backfill CLI script for historical ledger ranges.
 * Usage: pnpm indexer:backfill --from <ledger> [--to <ledger>] [--stream help_request|reputation|attestation|all]
 */

import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { fetchSorobanEvents } from "./soroban";
import { dispatchSorobanEvent } from "./handlers";
import { SOROBAN_STREAMS, getContractIdForKey } from "./runner";
import { updateStreamCursor } from "./cursor";
import { decodeEvent } from "@stellar-aid/sdk";

export type BackfillStreamFilter = "help_request" | "reputation" | "attestation" | "all";

export interface BackfillOptions {
  fromLedger: number;
  toLedger?: number;
  stream?: BackfillStreamFilter;
  contractId?: string;
  batchLimit?: number;
}

export async function runBackfill(options: BackfillOptions): Promise<{
  processedCount: number;
  lastLedger: number;
}> {
  const streamFilter = options.stream ?? "all";
  const selectedStreams =
    streamFilter === "all"
      ? SOROBAN_STREAMS
      : SOROBAN_STREAMS.filter((s) => s.contractKey === streamFilter);

  const limit = options.batchLimit || 100;
  let processedCount = 0;
  let maxFinalLedger = options.fromLedger;

  for (const def of selectedStreams) {
    const contractId =
      options.contractId || getContractIdForKey(def.contractKey, def.fallbackContractId);
    let currentLedger = options.fromLedger;
    const targetLedger = options.toLedger;

    logger.info(
      { stream: def.stream, fromLedger: currentLedger, toLedger: targetLedger, contractId },
      "starting indexer backfill for stream",
    );

    while (true) {
      if (targetLedger && currentLedger > targetLedger) {
        break;
      }

      const result = await fetchSorobanEvents(contractId, currentLedger, limit);
      if (!result.events || result.events.length === 0) {
        if (result.latestLedger > currentLedger) {
          currentLedger = targetLedger
            ? Math.min(result.latestLedger, targetLedger)
            : result.latestLedger;
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
              await dispatchSorobanEvent(decoded, tx, {
                eventId: raw.id,
                ledger: raw.ledger,
              });
            } catch (decErr) {
              logger.warn(
                { err: decErr, eventId: raw.id, stream: def.stream },
                "failed to decode event during backfill",
              );
            }

            processedCount++;
          }

          await updateStreamCursor(def.stream, raw.ledger, raw.id, tx);
        });

        currentLedger = raw.ledger;
      }

      if (result.events.length < limit) {
        break;
      }

      currentLedger++;
    }

    if (currentLedger > maxFinalLedger) {
      maxFinalLedger = currentLedger;
    }
  }

  logger.info(
    { processedCount, finalLedger: maxFinalLedger },
    "indexer backfill completed successfully",
  );

  return { processedCount, lastLedger: maxFinalLedger };
}

// CLI entry point
if (process.argv[1]?.endsWith("backfill.ts") || process.argv[1]?.endsWith("backfill.js")) {
  const args = process.argv.slice(2);
  let from = 1;
  let to: number | undefined;
  let stream: BackfillStreamFilter = "all";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      from = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--to" && args[i + 1]) {
      to = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--stream" && args[i + 1]) {
      const candidate = args[i + 1]!;
      if (
        candidate === "help_request" ||
        candidate === "reputation" ||
        candidate === "attestation" ||
        candidate === "all"
      ) {
        stream = candidate;
      }
      i++;
    }
  }

  runBackfill({
    fromLedger: from,
    ...(to !== undefined ? { toLedger: to } : {}),
    stream,
  })
    .catch((err) => {
      logger.error({ err }, "backfill failed");
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
