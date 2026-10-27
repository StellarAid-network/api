/**
 * Comments module routes.
 *
 * GET  /posts/:id/comments – list visible comments for a post
 * POST /posts/:id/comments – add a comment to a post
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { requireAuth } from "../../plugins/auth";
import { CommentBodySchema } from "../../lib/content";

const CreateCommentSchema = z.object({
  body: CommentBodySchema,
});

const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  // GET /posts/:id/comments
  app.get(
    "/posts/:id/comments",
    {
      schema: {
        tags: ["social"],
        summary: "Get comments for a post",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "integer", default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              comments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    postId: { type: "string" },
                    author: { type: "string" },
                    body: { type: "string" },
                    createdAt: { type: "string" },
                    authorProfile: {
                      type: "object",
                      properties: {
                        displayName: { type: ["string", "null"] },
                        avatarHash: { type: ["string", "null"] },
                      },
                    },
                  },
                },
              },
              nextCursor: { type: ["string", "null"] },
            },
          },
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { id: postId } = request.params as { id: string };
      const { cursor, limit } = PaginationQuerySchema.parse(request.query);

      // Verify post exists and is visible.
      const post = await prisma.post.findUnique({ where: { id: postId } });
      if (!post) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Post not found",
        });
      }

      if (post.status !== "VISIBLE") {
        if (!request.user || request.user.address !== post.author) {
          return reply.code(404).send({
            type: "https://stellaraid.app/errors/not-found",
            title: "Not Found",
            status: 404,
            detail: "Post not found",
          });
        }
      }

      const comments = await prisma.comment.findMany({
        where: {
          postId,
          status: "VISIBLE",
        },
        take: limit + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { createdAt: "asc" },
        include: {
          authorUser: {
            select: { displayName: true, avatarHash: true },
          },
        },
      });

      let nextCursor: string | null = null;
      if (comments.length > limit) {
        const nextItem = comments.pop();
        nextCursor = nextItem ? nextItem.id : null;
      }

      return reply.send({
        comments: comments.map((c) => ({
          id: c.id,
          postId: c.postId,
          author: c.author,
          body: c.body,
          createdAt: c.createdAt.toISOString(),
          authorProfile: {
            displayName: c.authorUser.displayName ?? null,
            avatarHash: c.authorUser.avatarHash ?? null,
          },
        })),
        nextCursor,
      });
    },
  );

  // POST /posts/:id/comments
  app.post(
    "/posts/:id/comments",
    {
      schema: {
        tags: ["social"],
        summary: "Add a comment to a post",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              postId: { type: "string" },
              author: { type: "string" },
              body: { type: "string" },
              createdAt: { type: "string" },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const user = request.user;

      const { id: postId } = request.params as { id: string };

      const parsed = CreateCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid comment body",
        });
      }

      const post = await prisma.post.findUnique({ where: { id: postId } });
      if (!post || post.status !== "VISIBLE") {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Post not found or not visible",
        });
      }

      await prisma.user.upsert({
        where: { address: user.address },
        create: { address: user.address },
        update: {},
      });

      const comment = await prisma.comment.create({
        data: {
          postId,
          author: user.address,
          body: parsed.data.body,
          status: "VISIBLE",
        },
      });

      return reply.code(201).send({
        id: comment.id,
        postId: comment.postId,
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
      });
    },
  );
}
