import type { Prisma } from "@prisma/client";
import type { StellarAidEvent } from "@stellar-aid/sdk";
import { handleHelpRequestEvent } from "./help-request";
import { handleReputationEvent } from "./reputation";
import { handleAttestationEvent, type AttestationDetailsLookup } from "./attestation";

export interface IndexerHandler {
  readonly event: string;
  handle(payload: unknown): Promise<void>;
}

export const handlers: readonly IndexerHandler[] = [];

export { handleHelpRequestEvent } from "./help-request";
export { handleGiveawayRecord, handleGiveawayClaim } from "./giveaway";
export { handleReputationEvent, deriveBadgesForScore, DEFAULT_BADGE_TIERS } from "./reputation";
export { handleAttestationEvent, type AttestationDetailsLookup } from "./attestation";

/**
 * Route any decoded Soroban domain event to its corresponding Prisma handler.
 */
export async function dispatchSorobanEvent(
  event: StellarAidEvent,
  tx: Prisma.TransactionClient,
  context: {
    eventId: string;
    ledger: number;
    txHash?: string;
    lookupAttestationDetails?: AttestationDetailsLookup;
  },
): Promise<void> {
  if (event.type.startsWith("help_request.")) {
    await handleHelpRequestEvent(event, tx, context);
    return;
  }
  if (event.type === "reputation.score_changed") {
    await handleReputationEvent(event, tx, context);
    return;
  }
  if (event.type === "attestation.attested" || event.type === "attestation.revoked") {
    await handleAttestationEvent(event, tx, {
      eventId: context.eventId,
      ledger: context.ledger,
      ...(context.lookupAttestationDetails
        ? { lookupDetails: context.lookupAttestationDetails }
        : {}),
    });
  }
}
