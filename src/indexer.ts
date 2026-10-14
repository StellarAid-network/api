import { startIndexer, stopIndexer } from "./indexer/runner";
import { logger } from "./lib/logger";
import { prisma } from "./lib/db";
import { redis } from "./lib/redis";

async function shutdown(): Promise<void> {
  await stopIndexer();
  await prisma.$disconnect();
  redis.disconnect();
}

async function main(): Promise<void> {
  await startIndexer();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "indexer failed to start");
  process.exit(1);
});
