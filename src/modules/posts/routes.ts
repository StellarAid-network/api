/**
 * Posts module routes.
 *
 * POST   /posts      – create a new post
 * GET    /posts/:id  – get post by id (respects visibility rules)
 * DELETE /posts/:id  – soft delete post (author only)
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { requireAuth } from "../../plugins/auth";
import { PostBodySchema, MediaHashesSchema, isAccountOldEnough } from "../../lib/content";
import { socialWriteRateLimit } from "../../plugins/rate-limit";
import { config } from "../../config";

const CreatePostSchema = z.object({
  body: PostBodySchema,
  mediaHashes: MediaHashesSchema.optional(),
});

export async function postRoutes(app: FastifyInstance): Promise<void> {
  // POST /posts
  app.post(
    "/posts",
    {
      ...socialWriteRateLimit,
      schema: {
        tags: ["social"],
        summary: "Create a new post",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1, maxLength: 2000 },
            mediaHashes: {
              type: "array",
              items: { type: "string" },
              maxItems: 4,
            },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              author: { type: "string" },
              body: { type: "string" },
              mediaHashes: { type: "array", items: { type: "string" } },
              status: { type: "string" },
              createdAt: { type: "string" },
              commentsCount: { type: "number" },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
          403: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const user = request.user;

      const existingUser = await prisma.user.findUnique({ where: { address: user.address } });
      if (
        existingUser &&
        !isAccountOldEnough(existingUser.createdAt, config.minAccountAgeSeconds)
      ) {
        return reply.code(403).send({
          type: "https://stellaraid.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Account is too new to post",
        });
      }

      const parsed = CreatePostSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid post data",
        });
      }

      const { body, mediaHashes = [] } = parsed.data;

      // Lazily create User record if not yet created.
      await prisma.user.upsert({
        where: { address: user.address },
        create: { address: user.address },
        update: {},
      });

      const post = await prisma.post.create({
        data: {
          author: user.address,
          body,
          mediaHashes,
          status: "VISIBLE",
        },
      });

      return reply.code(201).send({
        id: post.id,
        author: post.author,
        body: post.body,
        mediaHashes: post.mediaHashes,
        status: post.status,
        createdAt: post.createdAt.toISOString(),
        commentsCount: 0,
      });
    },
  );

  // GET /posts/:id
  app.get(
    "/posts/:id",
    {
      schema: {
        tags: ["social"],
        summary: "Get a post by id",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
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
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const post = await prisma.post.findUnique({
        where: { id },
        include: {
          authorUser: true,
          _count: {
            select: { comments: { where: { status: "VISIBLE" } } },
          },
        },
      });

      if (!post) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Post not found",
        });
      }

      // Hidden or deleted posts can only be viewed by the author.
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

      return reply.send({
        id: post.id,
        author: post.author,
        body: post.body,
        mediaHashes: post.mediaHashes,
        status: post.status,
        createdAt: post.createdAt.toISOString(),
        authorProfile: {
          displayName: post.authorUser.displayName ?? null,
          avatarHash: post.authorUser.avatarHash ?? null,
        },
        commentsCount: post._count.comments,
      });
    },
  );

  // DELETE /posts/:id
  app.delete(
    "/posts/:id",
    {
      schema: {
        tags: ["social"],
        summary: "Delete a post (author only)",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              id: { type: "string" },
            },
          },
          403: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const user = request.user;

      const { id } = request.params as { id: string };

      const post = await prisma.post.findUnique({ where: { id } });
      if (!post) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Post not found",
        });
      }

      if (post.author !== user.address) {
        return reply.code(403).send({
          type: "https://stellaraid.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "You are not authorized to delete this post",
        });
      }

      await prisma.post.update({
        where: { id },
        data: { status: "DELETED" },
      });

      return reply.send({ success: true, id });
    },
  );
}
