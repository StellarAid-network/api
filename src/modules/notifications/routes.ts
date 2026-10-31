/**
 * In-app notifications routes (authenticated owner only).
 *
 * GET  /notifications          – list own in-app notifications with unread count
 * POST /notifications/:id/read – mark own notification as read
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { requireAuth } from "../../plugins/auth";

const NotificationsQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional().default(false),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/notifications",
    {
      schema: {
        tags: ["notifications"],
        summary: "List in-app notifications for the signed-in user",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            unreadOnly: { type: "boolean", default: false },
            cursor: { type: "string" },
            limit: { type: "integer", default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              notifications: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    recipient: { type: "string" },
                    kind: { type: "string" },
                    title: { type: "string" },
                    body: { type: "string" },
                    refId: { type: ["string", "null"] },
                    read: { type: "boolean" },
                    createdAt: { type: "string" },
                  },
                },
              },
              unreadCount: { type: "integer" },
              nextCursor: { type: ["string", "null"] },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const parsed = NotificationsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        });
      }

      const { unreadOnly, cursor, limit } = parsed.data;
      const where = {
        recipient: request.user.address,
        ...(unreadOnly ? { read: false } : {}),
      };

      const [rows, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit + 1,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        }),
        prisma.notification.count({
          where: { recipient: request.user.address, read: false },
        }),
      ]);

      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const nextItem = rows.pop();
        nextCursor = nextItem ? nextItem.id : null;
      }

      return reply.send({
        notifications: rows.map((n) => ({
          id: n.id,
          recipient: n.recipient,
          kind: n.kind,
          title: n.title,
          body: n.body,
          refId: n.refId ?? null,
          read: n.read,
          createdAt: n.createdAt.toISOString(),
        })),
        unreadCount,
        nextCursor,
      });
    },
  );

  app.post(
    "/notifications/:id/read",
    {
      schema: {
        tags: ["notifications"],
        summary: "Mark an in-app notification as read",
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
              id: { type: "string" },
              read: { type: "boolean" },
            },
          },
          401: { type: "object", additionalProperties: true },
          403: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const { id } = request.params as { id: string };

      const existing = await prisma.notification.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Notification not found",
        });
      }

      if (existing.recipient !== request.user.address) {
        return reply.code(403).send({
          type: "https://stellaraid.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Cannot modify another user's notification",
        });
      }

      const updated = await prisma.notification.update({
        where: { id },
        data: { read: true },
      });

      return reply.send({
        id: updated.id,
        read: updated.read,
      });
    },
  );
}
