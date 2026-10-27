import { logger } from "../lib/logger";
import { config } from "../config";
import { tryAcquireIndexerLock, releaseIndexerLock } from "./lock";

let isRunning = false;
let hasLock = false;

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
}

export async function stopIndexer(): Promise<void> {
  if (!isRunning) return;
  isRunning = false;

  if (hasLock) {
    await releaseIndexerLock();
    hasLock = false;
  }

  logger.info("indexer worker stopped");
}

export function isIndexerRunning(): boolean {
  return isRunning && hasLock;
}
