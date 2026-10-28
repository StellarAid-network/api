/**
 * Moderation queue and resolution routes (moderator only).
 *
 * GET  /admin/reports             – review queue with status filter and cursor pagination
 * POST /admin/reports/:id/resolve – transition report status (`OPEN -> REVIEWING -> ACTIONED | DISMISSED`),
 *                                   optionally hide off-chain content, and record an audit log entry.
 *
 * SECURITY INVARIANT: Moderators can hide off-chain posts, comments, or request descriptions.
 * Moderators can NEVER move, freeze, or redirect on-chain funds.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { requireAuth, type RequestUser } from "../../plugins/auth";
import { config } from "../../config";

const AdminReportsQuerySchema = z.object({
  status: z.enum(["OPEN", "REVIEWING", "ACTIONED", "DISMISSED"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const ResolveReportSchema = z.object({
  status: z.enum(["REVIEWING", "ACTIONED", "DISMISSED"]),
  hideContent: z.boolean().optional().default(false),
  note: z.string().trim().max(1000).optional(),
});

const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  OPEN: new Set(["REVIEWING", "ACTIONED", "DISMISSED"]),
  REVIEWING: new Set(["ACTIONED", "DISMISSED"]),
  ACTIONED: new Set([]),
  DISMISSED: new Set([]),
};

function requireModerator(
  request: FastifyRequest,
  reply: FastifyReply,
): asserts request is FastifyRequest & { user: RequestUser } {
  requireAuth(request, reply);
  if (!config.adminAddresses.includes(request.user.address)) {
    void reply.code(403).send({
      type: "https://stellaraid.app/errors/forbidden",
      title: "Forbidden",
      status: 403,
      detail: "Moderator privileges required",
    });
    throw new Error("Forbidden");
  }
}

export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/reports
  app.get(
    "/admin/reports",
    {
      schema: {
        tags: ["moderation"],
        summary: "List reports in the moderation review queue",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["OPEN", "REVIEWING", "ACTIONED", "DISMISSED"],
            },
            cursor: { type: "string" },
            limit: { type: "integer", default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              reports: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    reporter: { type: "string" },
                    targetType: { type: "string" },
                    targetId: { type: "string" },
                    reason: { type: "string" },
                    status: { type: "string" },
                    resolvedBy: { type: ["string", "null"] },
                    createdAt: { type: "string" },
                    updatedAt: { type: "string" },
                  },
                },
              },
              nextCursor: { type: ["string", "null"] },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
          403: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireModerator(request, reply);

      const parsed = AdminReportsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        });
      }

      const { status, cursor, limit } = parsed.data;
      const where: Record<string, unknown> = {};
      if (status) {
        where.status = status;
      }

      const rows = await prisma.report.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const nextItem = rows.pop();
        nextCursor = nextItem ? nextItem.id : null;
      }

      return reply.send({
        reports: rows.map((r) => ({
          id: r.id,
          reporter: r.reporter,
          targetType: r.targetType,
          targetId: r.targetId,
          reason: r.reason,
          status: r.status,
          resolvedBy: r.resolvedBy,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        nextCursor,
      });
    },
  );

  // POST /admin/reports/:id/resolve
  app.post(
    "/admin/reports/:id/resolve",
    {
      schema: {
        tags: ["moderation"],
        summary: "Resolve a report and optionally hide off-chain content (moderator only)",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: ["REVIEWING", "ACTIONED", "DISMISSED"],
            },
            hideContent: { type: "boolean", default: false },
            note: { type: "string", maxLength: 1000 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              report: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  reporter: { type: "string" },
                  targetType: { type: "string" },
                  targetId: { type: "string" },
                  reason: { type: "string" },
                  status: { type: "string" },
                  resolvedBy: { type: ["string", "null"] },
                  updatedAt: { type: "string" },
                },
              },
              auditLog: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  reportId: { type: "string" },
                  moderator: { type: "string" },
                  action: { type: "string" },
                  targetType: { type: "string" },
                  targetId: { type: "string" },
                  previousStatus: { type: "string" },
                  newStatus: { type: "string" },
                  note: { type: ["string", "null"] },
                  createdAt: { type: "string" },
                },
              },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
          403: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
          409: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireModerator(request, reply);
      const moderator = request.user.address;
      const { id } = request.params as { id: string };

      const parsed = ResolveReportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid resolution payload",
        });
      }

      const existing = await prisma.report.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Report not found",
        });
      }

      const { status: nextStatus, hideContent, note } = parsed.data;
      const previousStatus = existing.status;
      const allowed = ALLOWED_TRANSITIONS[previousStatus];
      if (!allowed || !allowed.has(nextStatus)) {
        return reply.code(409).send({
          type: "https://stellaraid.app/errors/conflict",
          title: "Invalid Status Transition",
          status: 409,
          detail: `Cannot transition report from ${previousStatus} to ${nextStatus}`,
        });
      }

      const actionLabel = hideContent
        ? `resolve:${nextStatus.toLowerCase()}:hide_content`
        : `resolve:${nextStatus.toLowerCase()}`;

      const [updatedReport, auditLog] = await prisma.$transaction(async (tx) => {
        if (hideContent) {
          if (existing.targetType === "POST") {
            await tx.post.updateMany({
              where: { id: existing.targetId },
              data: { status: "HIDDEN" },
            });
          } else if (existing.targetType === "COMMENT") {
            await tx.comment.updateMany({
              where: { id: existing.targetId },
              data: { status: "HIDDEN" },
            });
          } else if (existing.targetType === "REQUEST") {
            try {
              const reqId = BigInt(existing.targetId);
              const reqRow = await tx.helpRequest.findUnique({ where: { id: reqId } });
              if (reqRow) {
                const currentMeta =
                  reqRow.metadata && typeof reqRow.metadata === "object"
                    ? (reqRow.metadata as Record<string, unknown>)
                    : {};
                // Hide off-chain description/metadata only; never touch on-chain escrow fields
                await tx.helpRequest.update({
                  where: { id: reqId },
                  data: {
                    metadata: {
                      ...currentMeta,
                      hidden: true,
                      hiddenReason: note ?? existing.reason,
                    },
                  },
                });
              }
            } catch {
              // Ignore non-numeric targetId
            }
          }
        }

        const rep = await tx.report.update({
          where: { id },
          data: {
            status: nextStatus,
            resolvedBy:
              nextStatus === "ACTIONED" || nextStatus === "DISMISSED"
                ? moderator
                : existing.resolvedBy,
          },
        });

        const log = await tx.moderationAuditLog.create({
          data: {
            reportId: existing.id,
            moderator,
            action: actionLabel,
            targetType: existing.targetType,
            targetId: existing.targetId,
            previousStatus,
            newStatus: nextStatus,
            note: note ?? null,
          },
        });

        return [rep, log] as const;
      });

      return reply.send({
        report: {
          id: updatedReport.id,
          reporter: updatedReport.reporter,
          targetType: updatedReport.targetType,
          targetId: updatedReport.targetId,
          reason: updatedReport.reason,
          status: updatedReport.status,
          resolvedBy: updatedReport.resolvedBy,
          updatedAt: updatedReport.updatedAt.toISOString(),
        },
        auditLog: {
          id: auditLog.id,
          reportId: auditLog.reportId,
          moderator: auditLog.moderator,
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          previousStatus: auditLog.previousStatus,
          newStatus: auditLog.newStatus,
          note: auditLog.note,
          createdAt: auditLog.createdAt.toISOString(),
        },
      });
    },
  );
}
