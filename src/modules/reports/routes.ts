/**
 * User reports module.
 *
 * POST /reports – report a post, comment, request, or user.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { requireAuth } from "../../plugins/auth";
import { socialWriteRateLimit } from "../../plugins/rate-limit";

const CreateReportSchema = z.object({
  targetType: z.enum(["POST", "COMMENT", "REQUEST", "USER"]),
  targetId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(3).max(1000),
});

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/reports",
    {
      ...socialWriteRateLimit,
      schema: {
        tags: ["moderation"],
        summary: "Report a post, comment, request, or user",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["targetType", "targetId", "reason"],
          properties: {
            targetType: {
              type: "string",
              enum: ["POST", "COMMENT", "REQUEST", "USER"],
            },
            targetId: { type: "string", minLength: 1, maxLength: 200 },
            reason: { type: "string", minLength: 3, maxLength: 1000 },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              reporter: { type: "string" },
              targetType: { type: "string" },
              targetId: { type: "string" },
              reason: { type: "string" },
              status: { type: "string" },
              createdAt: { type: "string" },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const user = request.user;

      const parsed = CreateReportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid report data",
        });
      }

      const { targetType, targetId, reason } = parsed.data;

      const report = await prisma.report.create({
        data: {
          reporter: user.address,
          targetType,
          targetId,
          reason,
          status: "OPEN",
        },
      });

      return reply.code(201).send({
        id: report.id,
        reporter: report.reporter,
        targetType: report.targetType,
        targetId: report.targetId,
        reason: report.reason,
        status: report.status,
        createdAt: report.createdAt.toISOString(),
      });
    },
  );
}
