import { logger } from "../lib/logger";
import { config } from "../config";

export async function startIndexer(): Promise<void> {
  logger.info(
    {
      network: config.stellarNetwork,
      rpcUrl: config.sorobanRpcUrl,
      pollIntervalMs: config.indexerPollIntervalMs,
    },
    "indexer booted; event processing is not implemented yet",
  );
}

export async function stopIndexer(): Promise<void> {
  logger.info("indexer stopped");
}
