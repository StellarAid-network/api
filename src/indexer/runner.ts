import { config } from "../config";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { tryAcquireIndexerLock, releaseIndexerLock } from "./lock";
import { getStreamCursor, updateStreamCursor } from "./cursor";
import { fetchSorobanEvents } from "./soroban";
import { fetchHorizonClaimableBalances } from "./horizon";
import { dispatchSorobanEvent, handleGiveawayRecord } from "./handlers";
import { recordProcessedEvents, updateLatestLedger, updateLastIndexedLedger } from "./metrics";
import { NETWORK_DEFAULTS, decodeEvent } from "@stellar-aid/sdk";

export interface SorobanStreamDefinition {
  stream: string;
  contractKey: "help_request" | "reputation" | "attestation";
  fallbackContractId: string;
}

export const SOROBAN_STREAMS: readonly SorobanStreamDefinition[] = [
  {
    stream: "soroban:help_request",
    contractKey: "help_request",
    fallbackContractId: "CBPW3FPPKPT4YWT7NSWM2EZ5AMONGQQQBPAEYZBSBWSOUGY5B26A7RLL",
  },
  {
    stream: "soroban:reputation",
    contractKey: "reputation",
    fallbackContractId: "CC46Y6JBSNNTHPZZCLLUILMWMSNLRC3MV46UQ2REQX3N4WI6PTDPOZ2C",
  },
  {
    stream: "soroban:attestation",
    contractKey: "attestation",
    fallbackContractId: "CBGSEMRF6DKWPGYGFJBQG5UEUBGFDHEJQUB5EOYTS4C746J54AYAS7GN",
  },
];

const HORIZON_STREAM = "horizon:giveaways";

let isRunning = false;
let hasLock = false;
let pollTimer: NodeJS.Timeout | null = null;

export function getContractIdForKey(
  key: "help_request" | "reputation" | "attestation",
  fallback: string,
): string {
  const networkDefaults = NETWORK_DEFAULTS[config.stellarNetwork as keyof typeof NETWORK_DEFAULTS];
  return networkDefaults?.contracts?.[key] || fallback;
}

export function getHelpRequestContractId(): string {
  return getContractIdForKey(
    "help_request",
    "CBPW3FPPKPT4YWT7NSWM2EZ5AMONGQQQBPAEYZBSBWSOUGY5B26A7RLL",
  );
}

/**
 * Executes a single indexing iteration across Soroban RPC contract streams and Horizon.
 * Atomic transaction per event/record guarantees cursor persistence and idempotency.
 */
export async function pollOnce(): Promise<{
  sorobanEventsCount: number;
  horizonRecordsCount: number;
}> {
  let sorobanEventsCount = 0;
  let horizonRecordsCount = 0;

  // 1. Process Soroban RPC events for HelpRequest, Reputation, and Attestation contracts
  for (const def of SOROBAN_STREAMS) {
    try {
      const contractId = getContractIdForKey(def.contractKey, def.fallbackContractId);
      const cursor = await getStreamCursor(def.stream);
      const startLedger =
        cursor.lastLedger > 0 ? cursor.lastLedger + 1 : config.indexerStartLedger || 1;

      const result = await fetchSorobanEvents(contractId, startLedger);
      updateLatestLedger(result.latestLedger);

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
              await dispatchSorobanEvent(decoded, tx, {
                eventId: raw.id,
                ledger: raw.ledger,
              });
            } catch (decErr) {
              logger.warn(
                { err: decErr, eventId: raw.id, stream: def.stream },
                "failed to decode or handle Soroban event; recording as processed",
              );
            }

            recordProcessedEvents(1);
            updateLastIndexedLedger(raw.ledger);
          }

          await updateStreamCursor(def.stream, raw.ledger, raw.id, tx);
        });
        sorobanEventsCount++;
      }

      if (result.events.length === 0 && result.latestLedger > cursor.lastLedger) {
        await updateStreamCursor(def.stream, result.latestLedger, cursor.lastCursor);
      }
    } catch (err) {
      logger.error({ err, stream: def.stream }, "error during Soroban poll iteration");
    }
  }

  // 2. Process Horizon Claimable Balances for Giveaways
  try {
    const cursor = await getStreamCursor(HORIZON_STREAM);
    const result = await fetchHorizonClaimableBalances(cursor.lastCursor ?? undefined);

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
          recordProcessedEvents(1);
          updateLastIndexedLedger(record.last_modified_ledger);
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

  void pollOnce();

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
