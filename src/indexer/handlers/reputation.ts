/**
 * Handler for Reputation contract events (`reputation.score_changed`) decoded by `@stellar-aid/sdk/events`.
 */

import type { Prisma } from "@prisma/client";
import type { StellarAidEvent } from "@stellar-aid/sdk";
import { logger } from "../../lib/logger";

export interface DerivedBadge {
  name: string;
  tier: number;
  threshold: number;
}

export const DEFAULT_BADGE_TIERS: readonly DerivedBadge[] = [
  { name: "Helper", tier: 1, threshold: 10 },
  { name: "Advocate", tier: 2, threshold: 50 },
  { name: "Champion", tier: 3, threshold: 100 },
];

export function deriveBadgesForScore(score: number): DerivedBadge[] {
  return DEFAULT_BADGE_TIERS.filter((tier) => score >= tier.threshold);
}

export async function handleReputationEvent(
  event: StellarAidEvent,
  tx: Prisma.TransactionClient,
  context: { eventId: string; ledger: number },
): Promise<void> {
  if (event.type !== "reputation.score_changed") {
    return;
  }

  const recordId = `rep_${context.eventId}`;
  await tx.reputationEvent.upsert({
    where: { id: recordId },
    update: {
      subject: event.subject,
      delta: event.delta,
      newScore: event.newScore,
      refId: event.refId,
      ledger: BigInt(context.ledger),
    },
    create: {
      id: recordId,
      subject: event.subject,
      delta: event.delta,
      newScore: event.newScore,
      refId: event.refId,
      ledger: BigInt(context.ledger),
    },
  });

  logger.info(
    {
      subject: event.subject,
      delta: event.delta,
      newScore: event.newScore,
      refId: event.refId,
    },
    "indexed reputation.score_changed",
  );
}
