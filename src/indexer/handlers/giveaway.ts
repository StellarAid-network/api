/**
 * Handlers for Horizon Claimable Balance records representing Giveaways.
 */

import type { Prisma } from "@prisma/client";
import type { HorizonClaimableBalance } from "../horizon";
import { logger } from "../../lib/logger";

export function parseStellarAmount(amountStr: string): bigint {
  const parts = amountStr.split(".");
  const intPart = BigInt(parts[0] || "0");
  const fracPart = BigInt((parts[1] || "").padEnd(7, "0").slice(0, 7));
  return intPart * 10_000_000n + fracPart;
}

export async function handleGiveawayRecord(
  record: HorizonClaimableBalance,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const amount = parseStellarAmount(record.amount);
  const claimants = record.claimants.map((c) => c.destination);
  const creator = record.sponsor || claimants[0] || "unknown";
  const predicatesJson = JSON.parse(
    JSON.stringify(
      record.claimants.map((c) => ({
        destination: c.destination,
        predicate: c.predicate,
      })),
    ),
  ) as Prisma.InputJsonValue;

  await tx.giveaway.upsert({
    where: { balanceId: record.id },
    update: {
      asset: record.asset,
      amount,
      claimants,
      predicates: predicatesJson,
      status: "open",
    },
    create: {
      balanceId: record.id,
      creator,
      asset: record.asset,
      amount,
      claimants,
      predicates: predicatesJson,
      status: "open",
    },
  });

  logger.info(
    { balanceId: record.id, creator, asset: record.asset },
    "indexed giveaway claimable balance",
  );
}

export async function handleGiveawayClaim(
  claim: { balanceId: string; claimer: string; txHash: string; ledger: number },
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.giveawayClaim.upsert({
    where: { txHash: claim.txHash },
    update: {
      balanceId: claim.balanceId,
      claimer: claim.claimer,
      ledger: BigInt(claim.ledger),
    },
    create: {
      balanceId: claim.balanceId,
      claimer: claim.claimer,
      txHash: claim.txHash,
      ledger: BigInt(claim.ledger),
    },
  });

  await tx.giveaway.updateMany({
    where: { balanceId: claim.balanceId },
    data: { status: "claimed" },
  });

  logger.info({ balanceId: claim.balanceId, claimer: claim.claimer }, "indexed giveaway claim");
}
