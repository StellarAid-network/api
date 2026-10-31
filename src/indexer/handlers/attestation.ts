/**
 * Handler for Attestation contract events (`attestation.attested`, `attestation.revoked`)
 * decoded by `@stellar-aid/sdk/events`.
 */

import type { Prisma } from "@prisma/client";
import type { StellarAidEvent } from "@stellar-aid/sdk";
import { logger } from "../../lib/logger";

export interface AttestationDetailsLookup {
  (
    subject: string,
    attestationId: bigint,
  ): Promise<{
    kind: string;
    contentHash: string;
    expiresAt: Date | null;
  } | null>;
}

export async function handleAttestationEvent(
  event: StellarAidEvent,
  tx: Prisma.TransactionClient,
  context: {
    eventId: string;
    ledger: number;
    lookupDetails?: AttestationDetailsLookup;
  },
): Promise<void> {
  if (event.type === "attestation.attested") {
    const id = event.attestationId.toString();
    let kind = "verified";
    let contentHash = "";
    let expiresAt: Date | null = null;

    if (context.lookupDetails) {
      try {
        const details = await context.lookupDetails(event.subject, event.attestationId);
        if (details) {
          kind = details.kind;
          contentHash = details.contentHash;
          expiresAt = details.expiresAt;
        }
      } catch (err) {
        logger.warn({ err, attestationId: id }, "could not hydrate on-chain attestation metadata");
      }
    }

    await tx.attestation.upsert({
      where: { id },
      update: {
        attestor: event.attestor,
        subject: event.subject,
        kind,
        contentHash,
        expiresAt,
        revoked: false,
      },
      create: {
        id,
        attestor: event.attestor,
        subject: event.subject,
        kind,
        contentHash,
        expiresAt,
        revoked: false,
      },
    });

    logger.info(
      { attestationId: id, attestor: event.attestor, subject: event.subject },
      "indexed attestation.attested",
    );
    return;
  }

  if (event.type === "attestation.revoked") {
    const id = event.attestationId.toString();
    await tx.attestation.upsert({
      where: { id },
      update: {
        revoked: true,
      },
      create: {
        id,
        attestor: event.attestor,
        subject: event.subject,
        kind: "verified",
        contentHash: "",
        expiresAt: null,
        revoked: true,
      },
    });

    logger.info(
      { attestationId: id, attestor: event.attestor, subject: event.subject },
      "indexed attestation.revoked",
    );
  }
}
