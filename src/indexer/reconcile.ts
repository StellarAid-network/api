/**
 * Indexer reconciliation script.
 * Usage: pnpm indexer:reconcile
 */

import { prisma } from "../lib/db";
import { logger } from "../lib/logger";

export async function reconcile(): Promise<{ reconciledRequests: number; fixedDiscrepancies: number }> {
  logger.info("starting indexer reconciliation job");

  const openRequests = await prisma.helpRequest.findMany({
    select: { id: true, raised: true },
  });

  let fixedDiscrepancies = 0;

  for (const req of openRequests) {
    const sumResult = await prisma.contribution.aggregate({
      where: { requestId: req.id },
      _sum: { amount: true },
    });

    const expectedRaised = sumResult._sum.amount ?? 0n;

    if (expectedRaised !== req.raised) {
      logger.warn(
        {
          requestId: req.id.toString(),
          recordedRaised: req.raised.toString(),
          calculatedRaised: expectedRaised.toString(),
        },
        "reconciliation: detected raised discrepancy, repairing",
      );

      await prisma.helpRequest.update({
        where: { id: req.id },
        data: { raised: expectedRaised },
      });

      fixedDiscrepancies++;
    }
  }

  logger.info(
    { totalChecked: openRequests.length, fixedDiscrepancies },
    "reconciliation job complete",
  );

  return { reconciledRequests: openRequests.length, fixedDiscrepancies };
}

// CLI entry point
if (process.argv[1]?.endsWith("reconcile.ts") || process.argv[1]?.endsWith("reconcile.js")) {
  reconcile()
    .catch((err) => {
      logger.error({ err }, "reconciliation failed");
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
