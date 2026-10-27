/**
 * Indexer stream reset CLI script.
 * Usage: pnpm indexer:reset --stream <name>
 */

import { prisma } from "../lib/db";
import { logger } from "../lib/logger";

export async function resetStream(streamName: string): Promise<void> {
  let targetStreams: string[] = [];

  if (streamName === "all") {
    targetStreams = ["soroban:help_request", "horizon:giveaways"];
  } else if (streamName === "help_request" || streamName === "soroban:help_request") {
    targetStreams = ["soroban:help_request"];
  } else if (streamName === "giveaway" || streamName === "giveaways" || streamName === "horizon:giveaways") {
    targetStreams = ["horizon:giveaways"];
  } else {
    targetStreams = [streamName];
  }

  for (const stream of targetStreams) {
    logger.info({ stream }, "resetting indexer stream cursor");
    await prisma.indexerCursor.deleteMany({
      where: { stream },
    });
  }

  logger.info({ targetStreams }, "stream cursor reset complete");
}

// CLI entry point
if (process.argv[1]?.endsWith("reset.ts") || process.argv[1]?.endsWith("reset.js")) {
  const args = process.argv.slice(2);
  let stream = "help_request";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" && args[i + 1]) {
      stream = args[i + 1]!;
      i++;
    }
  }

  resetStream(stream)
    .catch((err) => {
      logger.error({ err, stream }, "failed to reset stream");
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
