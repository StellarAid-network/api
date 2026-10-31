/**
 * Reputation and attestation read routes (indexed from Soroban contracts).
 *
 * GET /reputation/:address   – current reputation score, earned badges, and recent events
 * GET /attestations/:subject – active (or all) attestations for a subject
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { deriveBadgesForScore } from "../../indexer/handlers/reputation";

const StellarAddressParam = z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");
const SubjectParam = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((val) => !/^S[A-Z2-7]{55}$/.test(val), "Secret keys are not valid subjects");

const AttestationQuerySchema = z.object({
  includeRevoked: z.coerce.boolean().optional().default(false),
});

export async function getIndexedReputationSummary(address: string) {
  const events = await prisma.reputationEvent.findMany({
    where: { subject: address },
    orderBy: [{ ledger: "desc" }, { createdAt: "desc" }],
    take: 25,
  });

  const score = events[0]?.newScore ?? 0;
  const badges = deriveBadgesForScore(score);

  return {
    address,
    score,
    badges,
    events: events.map((e) => ({
      id: e.id,
      delta: e.delta,
      newScore: e.newScore,
      refId: e.refId,
      ledger: e.ledger.toString(),
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export async function reputationRoutes(app: FastifyInstance): Promise<void> {
  // GET /reputation/:address
  app.get(
    "/reputation/:address",
    {
      schema: {
        tags: ["trust"],
        summary: "Get reputation score, earned badges, and recent score events",
        params: {
          type: "object",
          required: ["address"],
          properties: { address: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              address: { type: "string" },
              score: { type: "integer" },
              badges: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    tier: { type: "integer" },
                    threshold: { type: "integer" },
                  },
                },
              },
              events: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    delta: { type: "integer" },
                    newScore: { type: "integer" },
                    refId: { type: "string" },
                    ledger: { type: "string" },
                    createdAt: { type: "string" },
                  },
                },
              },
            },
          },
          400: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params as { address: string };
      const parsed = StellarAddressParam.safeParse(address);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "Invalid Stellar address",
        });
      }

      const summary = await getIndexedReputationSummary(address);
      return reply.send(summary);
    },
  );

  // GET /attestations/:subject
  app.get(
    "/attestations/:subject",
    {
      schema: {
        tags: ["trust"],
        summary: "Get attestations recorded for a user or request subject",
        params: {
          type: "object",
          required: ["subject"],
          properties: { subject: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            includeRevoked: { type: "boolean", default: false },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              subject: { type: "string" },
              attestations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    attestor: { type: "string" },
                    subject: { type: "string" },
                    kind: { type: "string" },
                    contentHash: { type: "string" },
                    expiresAt: { type: ["string", "null"] },
                    revoked: { type: "boolean" },
                    createdAt: { type: "string" },
                  },
                },
              },
            },
          },
          400: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { subject } = request.params as { subject: string };
      const parsedSubject = SubjectParam.safeParse(subject);
      if (!parsedSubject.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsedSubject.error.issues[0]?.message ?? "Invalid subject parameter",
        });
      }

      const parsedQuery = AttestationQuerySchema.safeParse(request.query);
      const includeRevoked = parsedQuery.success ? parsedQuery.data.includeRevoked : false;
      const now = new Date();

      const rows = await prisma.attestation.findMany({
        where: {
          subject: parsedSubject.data,
          ...(includeRevoked ? {} : { revoked: false }),
        },
        orderBy: { createdAt: "desc" },
      });

      const visible = includeRevoked
        ? rows
        : rows.filter((a) => !a.expiresAt || a.expiresAt.getTime() > now.getTime());

      return reply.send({
        subject: parsedSubject.data,
        attestations: visible.map((a) => ({
          id: a.id,
          attestor: a.attestor,
          subject: a.subject,
          kind: a.kind,
          contentHash: a.contentHash,
          expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
          revoked: a.revoked,
          createdAt: a.createdAt.toISOString(),
        })),
      });
    },
  );
}
