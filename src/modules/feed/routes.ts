/**
 * Feed module routes.
 *
 * GET /feed – cursor-paginated timeline with global and following filters
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { requireAuth } from "../../plugins/auth";

const FeedQuerySchema = z.object({
  scope: z.enum(["global", "following"]).default("global"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  tag: z.string().optional(),
});

export async function feedRoutes(app: FastifyInstance): Promise<void> {
  // GET /feed
  app.get(
    "/feed",
    {
      schema: {
        tags: ["social"],
        summary: "Get feed timeline",
        querystring: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["global", "following"], default: "global" },
            cursor: { type: "string" },
            limit: { type: "integer", default: 20 },
            tag: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              posts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    author: { type: "string" },
                    body: { type: "string" },
                    mediaHashes: { type: "array", items: { type: "string" } },
                    status: { type: "string" },
                    createdAt: { type: "string" },
                    authorProfile: {
                      type: "object",
                      properties: {
                        displayName: { type: ["string", "null"] },
                        avatarHash: { type: ["string", "null"] },
                      },
                    },
                    commentsCount: { type: "number" },
                  },
                },
              },
              nextCursor: { type: ["string", "null"] },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsed = FeedQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        });
      }

      const { scope, cursor, limit, tag } = parsed.data;

      // Base query condition: only visible posts
      const where: Record<string, unknown> = {
        status: "VISIBLE",
      };

      if (tag) {
        where.body = {
          contains: tag.startsWith("#") ? tag : `#${tag}`,
        };
      }

      if (scope === "following") {
        requireAuth(request, reply);
        const user = request.user;

        const follows = await prisma.follow.findMany({
          where: { followerAddress: user.address },
          select: { followeeAddress: true },
        });

        const followeeAddresses = follows.map((f) => f.followeeAddress);
        where.author = { in: followeeAddresses };
      }

      const posts = await prisma.post.findMany({
        where,
        take: limit + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { createdAt: "desc" },
        include: {
          authorUser: {
            select: { displayName: true, avatarHash: true },
          },
          _count: {
            select: { comments: { where: { status: "VISIBLE" } } },
          },
        },
      });

      let nextCursor: string | null = null;
      if (posts.length > limit) {
        const nextItem = posts.pop();
        nextCursor = nextItem ? nextItem.id : null;
      }

      return reply.send({
        posts: posts.map((p) => ({
          id: p.id,
          author: p.author,
          body: p.body,
          mediaHashes: p.mediaHashes,
          status: p.status,
          createdAt: p.createdAt.toISOString(),
          authorProfile: {
            displayName: p.authorUser.displayName ?? null,
            avatarHash: p.authorUser.avatarHash ?? null,
          },
          commentsCount: p._count.comments,
        })),
        nextCursor,
      });
    },
  );
}
