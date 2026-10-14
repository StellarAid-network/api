import { logger } from "../lib/logger";

export async function reconcile(): Promise<void> {
  logger.debug("reconcile: no streams configured yet");
}
