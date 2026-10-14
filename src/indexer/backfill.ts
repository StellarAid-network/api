import { logger } from "../lib/logger";

export async function backfill(): Promise<void> {
  logger.debug("backfill: no streams configured yet");
}
