/**
 * Giveaways read-model routes.
 *
 * Indexed tables (Giveaway, GiveawayClaim) are written only by the indexer and
 * are strictly read-only for the HTTP layer.
 *
 * GET /giveaways     – list and filter giveaways with cursor pagination
 * GET /giveaways/:id – giveaway detail and claim status
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";

const GiveawaysQuerySchema = z.object({
  status: z.string().optional(),
  endingSoon: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  tag: z.string().optional(),
  creator: z.string().optional(),
  asset: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function extractExpiryMs(predicates: unknown): number | null {
  if (!predicates || typeof predicates !== "object") return null;
  const pred = predicates as Record<string, unknown>;
  if (typeof pred.expiresAt === "string") {
    const t = Date.parse(pred.expiresAt);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof pred.expiresAt === "number") {
    return pred.expiresAt > 1e12 ? pred.expiresAt : pred.expiresAt * 1000;
  }
  return null;
}

export async function giveawayRoutes(app: FastifyInstance): Promise<void> {
  // GET /giveaways
  app.get(
    "/giveaways",
    {
      schema: {
        tags: ["giveaways"],
        summary: "List and filter giveaways",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            endingSoon: { type: "string", enum: ["true", "false"] },
            tag: { type: "string" },
            creator: { type: "string" },
            asset: { type: "string" },
            cursor: { type: "string" },
            limit: { type: "integer", default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              giveaways: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    id: { type: "string" },
                    balanceId: { type: "string" },
                    creator: { type: "string" },
                    asset: { type: "string" },
                    amount: { type: "string" },
                    claimants: { type: "array", items: { type: "string" } },
                    predicates: { type: "object", additionalProperties: true },
                    status: { type: "string" },
                    claimsCount: { type: "integer" },
                    createdAt: { type: "string" },
                  },
                },
              },
              nextCursor: { type: ["string", "null"] },
            },
          },
          400: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsed = GiveawaysQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        });
      }

      const { status, endingSoon, tag, creator, asset, cursor, limit } = parsed.data;
      const where: Record<string, unknown> = {};

      if (status) {
        where.status = status;
      }
      if (creator) {
        where.creator = creator;
      }
      if (asset) {
        where.asset = asset;
      }

      const rows = await prisma.giveaway.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        take: endingSoon || tag ? 200 : limit + 1,
        include: {
          _count: { select: { claims: true } },
        },
      });

      const now = Date.now();
      const soonThreshold = now + 72 * 3600 * 1000;
      const normalizedTag = tag ? tag.toLowerCase().replace(/^#/, "") : undefined;

      const filtered = rows.filter((g) => {
        if (endingSoon) {
          const exp = extractExpiryMs(g.predicates);
          if (!exp || exp <= now || exp > soonThreshold) {
            return false;
          }
        }
        if (normalizedTag) {
          const predStr = JSON.stringify(g.predicates ?? {}).toLowerCase();
          if (!predStr.includes(normalizedTag) && !g.asset.toLowerCase().includes(normalizedTag)) {
            return false;
          }
        }
        return true;
      });

      const pageItems = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && lastItem ? lastItem.id : null;

      return reply.send({
        giveaways: pageItems.map((g) => ({
          id: g.id,
          balanceId: g.balanceId,
          creator: g.creator,
          asset: g.asset,
          amount: g.amount.toString(),
          claimants: g.claimants,
          predicates:
            g.predicates && typeof g.predicates === "object"
              ? (g.predicates as Record<string, unknown>)
              : {},
          status: g.status,
          claimsCount: g._count.claims,
          createdAt: g.createdAt.toISOString(),
          updatedAt: g.updatedAt.toISOString(),
        })),
        nextCursor,
      });
    },
  );

  // GET /giveaways/:id
  app.get(
    "/giveaways/:id",
    {
      schema: {
        tags: ["giveaways"],
        summary: "Get giveaway detail and claim status",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string" },
              balanceId: { type: "string" },
              creator: { type: "string" },
              asset: { type: "string" },
              amount: { type: "string" },
              claimants: { type: "array", items: { type: "string" } },
              predicates: { type: "object", additionalProperties: true },
              status: { type: "string" },
              claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    balanceId: { type: "string" },
                    claimer: { type: "string" },
                    txHash: { type: "string" },
                    ledger: { type: "string" },
                    createdAt: { type: "string" },
                  },
                },
              },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
          },
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const row =
        (await prisma.giveaway.findUnique({
          where: { id },
          include: { claims: { orderBy: { createdAt: "desc" } } },
        })) ??
        (await prisma.giveaway.findUnique({
          where: { balanceId: id },
          include: { claims: { orderBy: { createdAt: "desc" } } },
        }));

      if (!row) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Giveaway not found",
        });
      }

      return reply.send({
        id: row.id,
        balanceId: row.balanceId,
        creator: row.creator,
        asset: row.asset,
        amount: row.amount.toString(),
        claimants: row.claimants,
        predicates:
          row.predicates && typeof row.predicates === "object"
            ? (row.predicates as Record<string, unknown>)
            : {},
        status: row.status,
        claims: row.claims.map((c) => ({
          id: c.id,
          balanceId: c.balanceId,
          claimer: c.claimer,
          txHash: c.txHash,
          ledger: c.ledger.toString(),
          createdAt: c.createdAt.toISOString(),
        })),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    },
  );
}
