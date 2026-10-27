import { config } from "../config";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { tryAcquireIndexerLock, releaseIndexerLock } from "./lock";
import { getStreamCursor, updateStreamCursor } from "./cursor";
import { fetchSorobanEvents } from "./soroban";
import { fetchHorizonClaimableBalances } from "./horizon";
import { handleHelpRequestEvent } from "./handlers/help-request";
import { handleGiveawayRecord } from "./handlers/giveaway";
import { NETWORK_DEFAULTS, decodeEvent } from "@stellar-aid/sdk";

const SOROBAN_STREAM = "soroban:help_request";
const HORIZON_STREAM = "horizon:giveaways";

let isRunning = false;
let hasLock = false;
let pollTimer: NodeJS.Timeout | null = null;

export function getHelpRequestContractId(): string {
  const networkDefaults =
    NETWORK_DEFAULTS[config.stellarNetwork as keyof typeof NETWORK_DEFAULTS];
  return (
    networkDefaults?.contracts?.help_request ||
    "CBPW3FPPKPT4YWT7NSWM2EZ5AMONGQQQBPAEYZBSBWSOUGY5B26A7RLL"
  );
}

/**
 * Executes a single indexing iteration across Soroban RPC and Horizon streams.
 * Atomic transaction per event/record guarantees cursor persistence and idempotency.
 */
export async function pollOnce(): Promise<{
  sorobanEventsCount: number;
  horizonRecordsCount: number;
}> {
  let sorobanEventsCount = 0;
  let horizonRecordsCount = 0;

  // 1. Process Soroban RPC events for Help Request contract
  try {
    const contractId = getHelpRequestContractId();
    const cursor = await getStreamCursor(SOROBAN_STREAM);
    const startLedger =
      cursor.lastLedger > 0
        ? cursor.lastLedger + 1
        : config.indexerStartLedger || 1;

    const result = await fetchSorobanEvents(contractId, startLedger);

    for (const raw of result.events) {
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
            logger.warn(
              { err: decErr, eventId: raw.id },
              "failed to decode or handle Soroban event; recording as processed",
            );
          }
        }

        await updateStreamCursor(SOROBAN_STREAM, raw.ledger, raw.id, tx);
      });
      sorobanEventsCount++;
    }

    if (result.events.length === 0 && result.latestLedger > cursor.lastLedger) {
      // Advance cursor to latest ledger if no events were returned
      await updateStreamCursor(
        SOROBAN_STREAM,
        result.latestLedger,
        cursor.lastCursor,
      );
    }
  } catch (err) {
    logger.error({ err }, "error during Soroban poll iteration");
  }

  // 2. Process Horizon Claimable Balances for Giveaways
  try {
    const cursor = await getStreamCursor(HORIZON_STREAM);
    const result = await fetchHorizonClaimableBalances(
      cursor.lastCursor ?? undefined,
    );

    for (const record of result.records) {
      const eventId = `giveaway_${record.id}`;
      await prisma.$transaction(async (tx) => {
        const existing = await tx.processedEvent.findUnique({
          where: { eventId },
        });

        if (!existing) {
          await tx.processedEvent.create({
            data: {
              eventId,
              ledger: BigInt(record.last_modified_ledger),
            },
          });

          await handleGiveawayRecord(record, tx);
        }

        await updateStreamCursor(
          HORIZON_STREAM,
          record.last_modified_ledger,
          record.paging_token,
          tx,
        );
      });
      horizonRecordsCount++;
    }
  } catch (err) {
    logger.error({ err }, "error during Horizon poll iteration");
  }

  return { sorobanEventsCount, horizonRecordsCount };
}

export async function startIndexer(): Promise<void> {
  if (isRunning) {
    logger.warn("indexer is already running");
    return;
  }

  // Acquire exclusive advisory lock so only one indexer instance processes events.
  hasLock = await tryAcquireIndexerLock();
  if (!hasLock) {
    logger.warn("exiting indexer startup: lock held by another process");
    return;
  }

  isRunning = true;
  logger.info(
    {
      network: config.stellarNetwork,
      rpcUrl: config.sorobanRpcUrl,
      horizonUrl: config.horizonUrl,
      pollIntervalMs: config.indexerPollIntervalMs,
    },
    "indexer worker started with advisory lock",
  );

  // Initial poll run
  void pollOnce();

  // Scheduled poll loop
  pollTimer = setInterval(() => {
    if (isRunning) {
      void pollOnce();
    }
  }, config.indexerPollIntervalMs);
}

export async function stopIndexer(): Promise<void> {
  if (!isRunning) return;
  isRunning = false;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (hasLock) {
    await releaseIndexerLock();
    hasLock = false;
  }

  logger.info("indexer worker stopped");
}

export function isIndexerRunning(): boolean {
  return isRunning && hasLock;
}
