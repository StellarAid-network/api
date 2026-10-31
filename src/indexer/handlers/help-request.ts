/**
 * Handlers for Help Request contract events decoded by @stellar-aid/sdk/events.
 */

import type { Prisma } from "@prisma/client";
import { formatAmount, type StellarAidEvent } from "@stellar-aid/sdk";
import { logger } from "../../lib/logger";
import { enqueueNotification } from "../../jobs/notifications";

async function findRequestCreator(
  tx: Prisma.TransactionClient,
  requestId: bigint,
): Promise<string | null> {
  const finder = (
    tx.helpRequest as unknown as {
      findUnique?: (args: {
        where: { id: bigint };
        select?: { creator: boolean };
      }) => Promise<{ creator?: string } | null>;
    }
  )?.findUnique;
  if (!finder) return null;
  try {
    const row = await finder({ where: { id: requestId }, select: { creator: true } });
    return row?.creator ?? null;
  } catch {
    return null;
  }
}

export async function handleHelpRequestEvent(
  event: StellarAidEvent,
  tx: Prisma.TransactionClient,
  context: { eventId: string; ledger: number; txHash?: string },
): Promise<void> {
  const { eventId, ledger, txHash } = context;

  switch (event.type) {
    case "help_request.created": {
      const deadlineDate = new Date(Number(event.deadline) * 1000);
      await tx.helpRequest.upsert({
        where: { id: event.requestId },
        update: {
          creator: event.creator,
          token: event.token,
          goal: event.goal,
          deadline: deadlineDate,
          status: "open",
        },
        create: {
          id: event.requestId,
          creator: event.creator,
          token: event.token,
          goal: event.goal,
          raised: 0n,
          deadline: deadlineDate,
          status: "open",
          contentHash: event.creator, // placeholder content hash until backfilled
        },
      });
      logger.info({ requestId: event.requestId.toString() }, "indexed help_request.created");
      break;
    }

    case "help_request.contributed": {
      await tx.helpRequest.updateMany({
        where: { id: event.requestId },
        data: { raised: event.totalRaised },
      });

      const syntheticTxHash = txHash || `${eventId}_tx`;
      await tx.contribution.upsert({
        where: { txHash: syntheticTxHash },
        update: {
          amount: event.amount,
        },
        create: {
          requestId: event.requestId,
          contributor: event.contributor,
          amount: event.amount,
          txHash: syntheticTxHash,
          ledger: BigInt(ledger),
        },
      });
      const creator = await findRequestCreator(tx, event.requestId);
      if (creator && creator !== event.contributor) {
        await enqueueNotification({
          recipient: creator,
          kind: "contribution_received",
          title: "New contribution received",
          body: `${event.contributor.slice(0, 6)}... contributed ${formatAmount(event.amount)} to request #${event.requestId.toString()}.`,
          refId: event.requestId.toString(),
        });
      }
      logger.info(
        { requestId: event.requestId.toString(), contributor: event.contributor },
        "indexed help_request.contributed",
      );
      break;
    }

    case "help_request.funded": {
      await tx.helpRequest.updateMany({
        where: { id: event.requestId },
        data: {
          status: "funded",
          raised: event.totalRaised,
        },
      });
      const creator = await findRequestCreator(tx, event.requestId);
      if (creator) {
        await enqueueNotification({
          recipient: creator,
          kind: "goal_reached",
          title: "Funding goal reached",
          body: `Help request #${event.requestId.toString()} reached its goal (${formatAmount(event.totalRaised)} raised).`,
          refId: event.requestId.toString(),
        });
      }
      logger.info({ requestId: event.requestId.toString() }, "indexed help_request.funded");
      break;
    }

    case "help_request.failed": {
      await tx.helpRequest.updateMany({
        where: { id: event.requestId },
        data: {
          status: "failed",
          raised: event.totalRaised,
        },
      });
      const creator = await findRequestCreator(tx, event.requestId);
      if (creator) {
        await enqueueNotification({
          recipient: creator,
          kind: "goal_failed",
          title: "Funding deadline ended below goal",
          body: `Help request #${event.requestId.toString()} closed below goal; contributors can now claim full refunds.`,
          refId: event.requestId.toString(),
        });
      }
      logger.info({ requestId: event.requestId.toString() }, "indexed help_request.failed");
      break;
    }

    case "help_request.cancelled": {
      await tx.helpRequest.updateMany({
        where: { id: event.requestId },
        data: { status: "cancelled" },
      });
      logger.info({ requestId: event.requestId.toString() }, "indexed help_request.cancelled");
      break;
    }

    case "help_request.refunded": {
      logger.info(
        {
          requestId: event.requestId.toString(),
          contributor: event.contributor,
          amount: event.amount.toString(),
        },
        "indexed help_request.refunded",
      );
      break;
    }

    case "help_request.milestone_submitted": {
      await tx.milestone.upsert({
        where: {
          requestId_index: {
            requestId: event.requestId,
            index: event.index,
          },
        },
        update: {
          status: "submitted",
          evidenceHash: event.evidenceHash,
        },
        create: {
          requestId: event.requestId,
          index: event.index,
          amount: 0n,
          status: "submitted",
          evidenceHash: event.evidenceHash,
        },
      });
      logger.info(
        { requestId: event.requestId.toString(), index: event.index },
        "indexed help_request.milestone_submitted",
      );
      break;
    }

    case "help_request.milestone_approved": {
      await tx.milestone.updateMany({
        where: {
          requestId: event.requestId,
          index: event.index,
        },
        data: {
          status: "approved",
        },
      });
      const creator = await findRequestCreator(tx, event.requestId);
      if (creator) {
        await enqueueNotification({
          recipient: creator,
          kind: "milestone_approved",
          title: `Milestone #${event.index + 1} approved`,
          body: `Milestone #${event.index + 1} on help request #${event.requestId.toString()} was approved and is ready to release.`,
          refId: `${event.requestId.toString()}:${event.index}`,
        });
      }
      logger.info(
        { requestId: event.requestId.toString(), index: event.index, approver: event.approver },
        "indexed help_request.milestone_approved",
      );
      break;
    }

    case "help_request.milestone_released": {
      await tx.milestone.updateMany({
        where: {
          requestId: event.requestId,
          index: event.index,
        },
        data: {
          status: "released",
          amount: event.amount,
        },
      });
      await tx.helpRequest.updateMany({
        where: { id: event.requestId },
        data: { status: "releasing" },
      });
      logger.info(
        {
          requestId: event.requestId.toString(),
          index: event.index,
          amount: event.amount.toString(),
        },
        "indexed help_request.milestone_released",
      );
      break;
    }

    default:
      break;
  }
}
