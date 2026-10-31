/**
 * Chain-vs-Database reconciliation job (`pnpm indexer:reconcile`).
 *
 * Source-of-truth rule: for anything involving funds, **the chain wins**.
 * Compares indexed HelpRequest rows (`raised`, `status`) against:
 *  1. On-chain contract state via `@stellar-aid/sdk` (or an injected `ChainRequestReader`), and
 *  2. Indexed `Contribution` sum aggregates when on-chain RPC is offline.
 * Repairs any detected drift and increments Prometheus reconciliation metrics.
 */

import { createStellarAid } from "@stellar-aid/sdk";
import { config } from "../config";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { recordReconciliationRun } from "./metrics";

export interface ChainRequestSnapshot {
  raised: bigint;
  status: string;
}

export type ChainRequestReader = (requestId: bigint) => Promise<ChainRequestSnapshot | null>;

export interface ReconcileOptions {
  chainReader?: ChainRequestReader;
}

export interface ReconcileResult {
  reconciledRequests: number;
  fixedDiscrepancies: number;
  repairs: Array<{
    requestId: string;
    previousRaised: string;
    repairedRaised: string;
    previousStatus: string;
    repairedStatus: string;
    source: "chain" | "contributions_aggregate";
  }>;
}

function createDefaultChainReader(): ChainRequestReader {
  const aid = createStellarAid({
    network: config.stellarNetwork,
    rpcUrl: config.sorobanRpcUrl,
    horizonUrl: config.horizonUrl,
  });

  return async (requestId: bigint): Promise<ChainRequestSnapshot | null> => {
    try {
      const details = await aid.helpRequests.get(requestId);
      return {
        raised: details.raised,
        status: details.status.toLowerCase(),
      };
    } catch {
      return null;
    }
  };
}

export async function reconcile(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  logger.info("starting indexer reconciliation job");

  const reader = options.chainReader ?? createDefaultChainReader();
  const requests = await prisma.helpRequest.findMany({
    select: { id: true, raised: true, status: true },
  });

  let fixedDiscrepancies = 0;
  const repairs: ReconcileResult["repairs"] = [];

  for (const req of requests) {
    const sumResult = await prisma.contribution.aggregate({
      where: { requestId: req.id },
      _sum: { amount: true },
    });
    const contributionTotal = sumResult._sum.amount ?? 0n;

    const chainSnapshot = await reader(req.id);
    const authoritativeRaised = chainSnapshot ? chainSnapshot.raised : contributionTotal;
    const authoritativeStatus = chainSnapshot ? chainSnapshot.status : req.status;
    const source: "chain" | "contributions_aggregate" = chainSnapshot
      ? "chain"
      : "contributions_aggregate";

    const raisedDrifted = authoritativeRaised !== req.raised;
    const statusDrifted =
      chainSnapshot !== null && authoritativeStatus.toLowerCase() !== req.status.toLowerCase();

    if (raisedDrifted || statusDrifted) {
      logger.warn(
        {
          requestId: req.id.toString(),
          source,
          recordedRaised: req.raised.toString(),
          authoritativeRaised: authoritativeRaised.toString(),
          recordedStatus: req.status,
          authoritativeStatus,
        },
        "reconciliation: detected state discrepancy, repairing toward source of truth",
      );

      await prisma.helpRequest.update({
        where: { id: req.id },
        data: {
          raised: authoritativeRaised,
          ...(statusDrifted ? { status: authoritativeStatus } : {}),
        },
      });

      fixedDiscrepancies++;
      repairs.push({
        requestId: req.id.toString(),
        previousRaised: req.raised.toString(),
        repairedRaised: authoritativeRaised.toString(),
        previousStatus: req.status,
        repairedStatus: statusDrifted ? authoritativeStatus : req.status,
        source,
      });
    }
  }

  recordReconciliationRun(fixedDiscrepancies);

  logger.info({ totalChecked: requests.length, fixedDiscrepancies }, "reconciliation job complete");

  return {
    reconciledRequests: requests.length,
    fixedDiscrepancies,
    repairs,
  };
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
