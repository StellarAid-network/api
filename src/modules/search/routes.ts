/**
 * Search route across requests, giveaways, and profiles.
 *
 * GET /search?q= – searches requests (excluding hidden metadata), giveaways,
 * and profiles.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";

const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/search",
    {
      schema: {
        tags: ["utility"],
        summary: "Search requests, giveaways, and profiles",
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1 },
            limit: { type: "integer", default: 10 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              query: { type: "string" },
              requests: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    id: { type: "string" },
                    creator: { type: "string" },
                    goal: { type: "string" },
                    raised: { type: "string" },
                    status: { type: "string" },
                    deadline: { type: "string" },
                    metadata: { type: ["object", "null"], additionalProperties: true },
                  },
                },
              },
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
                    status: { type: "string" },
                  },
                },
              },
              profiles: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    address: { type: "string" },
                    displayName: { type: ["string", "null"] },
                    bio: { type: ["string", "null"] },
                    avatarHash: { type: ["string", "null"] },
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
      const parsed = SearchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid search query",
        });
      }

      const { q, limit } = parsed.data;
      const needle = q.toLowerCase();
      const terms = needle.split(/\s+/).filter(Boolean);

      // 1. Search profiles
      const profiles = await prisma.user.findMany({
        where: {
          OR: [
            { address: { contains: q, mode: "insensitive" } },
            { displayName: { contains: q, mode: "insensitive" } },
            { bio: { contains: q, mode: "insensitive" } },
          ],
        },
        take: limit,
        orderBy: { createdAt: "desc" },
      });

      // 2. Search help requests (respecting hidden metadata)
      const allRequests = await prisma.helpRequest.findMany({
        take: 200,
        orderBy: { id: "desc" },
      });

      const matchedRequests = allRequests
        .filter((r) => {
          const meta =
            r.metadata && typeof r.metadata === "object"
              ? (r.metadata as Record<string, unknown>)
              : {};
          // Exclude requests whose metadata has been hidden by moderation
          if (meta.hidden === true) {
            return false;
          }
          const searchable = [
            r.id.toString(),
            r.creator,
            r.status,
            typeof meta.title === "string" ? meta.title : "",
            typeof meta.description === "string" ? meta.description : "",
            Array.isArray(meta.tags) ? (meta.tags as string[]).join(" ") : "",
          ]
            .join(" ")
            .toLowerCase();

          return terms.every((t) => searchable.includes(t));
        })
        .slice(0, limit);

      // 3. Search giveaways
      const allGiveaways = await prisma.giveaway.findMany({
        take: 200,
        orderBy: { createdAt: "desc" },
      });

      const matchedGiveaways = allGiveaways
        .filter((g) => {
          const searchable = [
            g.id,
            g.balanceId,
            g.creator,
            g.asset,
            g.status,
            JSON.stringify(g.predicates ?? {}),
          ]
            .join(" ")
            .toLowerCase();

          return terms.every((t) => searchable.includes(t));
        })
        .slice(0, limit);

      return reply.send({
        query: q,
        requests: matchedRequests.map((r) => ({
          id: r.id.toString(),
          creator: r.creator,
          token: r.token,
          goal: r.goal.toString(),
          raised: r.raised.toString(),
          status: r.status,
          deadline: r.deadline.toISOString(),
          contentHash: r.contentHash,
          metadata:
            r.metadata && typeof r.metadata === "object"
              ? (r.metadata as Record<string, unknown>)
              : null,
        })),
        giveaways: matchedGiveaways.map((g) => ({
          id: g.id,
          balanceId: g.balanceId,
          creator: g.creator,
          asset: g.asset,
          amount: g.amount.toString(),
          status: g.status,
        })),
        profiles: profiles.map((p) => ({
          address: p.address,
          displayName: p.displayName,
          bio: p.bio,
          avatarHash: p.avatarHash,
        })),
      });
    },
  );
}
