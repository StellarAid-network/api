/**
 * Help Requests read-model and creator metadata routes.
 *
 * Indexed tables (HelpRequest, Milestone, Contribution) are read-only to HTTP except
 * for `POST /requests/:id/metadata`, which attaches off-chain title/description/media
 * and validates them against the on-chain `contentHash`.
 *
 * GET  /requests                   – list & filter requests with cursor pagination
 * GET  /requests/:id               – request detail, milestones, metadata, hashMismatch flag
 * GET  /requests/:id/contributions – public contribution history
 * POST /requests/:id/metadata      – attach creator off-chain metadata & validate hash
 */

import * as crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { requireAuth } from "../../plugins/auth";
import { config } from "../../config";
import { MediaHashesSchema } from "../../lib/content";

export interface RequestMetadataPayload {
  title: string;
  description: string;
  mediaHashes?: string[];
  tags?: string[];
  hidden?: boolean;
  hiddenReason?: string;
  hashMismatch?: boolean;
  computedHash?: string;
}

const RequestsQuerySchema = z.object({
  status: z.string().optional(),
  nearingGoal: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  endingSoon: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  tag: z.string().optional(),
  creator: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const ContributionsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const AttachMetadataSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(5000),
  mediaHashes: MediaHashesSchema.optional().default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional().default([]),
  cid: z.string().trim().optional(),
});

/**
 * Compute deterministic SHA-256 hex digest of the canonical metadata fields.
 */
export function computeMetadataHash(input: {
  title: string;
  description: string;
  mediaHashes?: string[];
  tags?: string[];
}): string {
  const canonical = JSON.stringify({
    title: input.title,
    description: input.description,
    mediaHashes: input.mediaHashes ?? [],
    tags: input.tags ?? [],
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Determine whether off-chain metadata matches the on-chain `contentHash`.
 */
export function checkContentHashMatch(
  onChainHash: string,
  computedHash: string,
  cid?: string,
): boolean {
  const normalizedOnChain = onChainHash.toLowerCase().replace(/^0x/, "").trim();
  const normalizedComputed = computedHash.toLowerCase().replace(/^0x/, "").trim();

  if (normalizedOnChain === normalizedComputed) {
    return true;
  }
  if (cid) {
    const cidHex = Buffer.from(cid, "utf8").toString("hex").slice(0, 64).padEnd(64, "0");
    if (normalizedOnChain === cid.toLowerCase() || normalizedOnChain === cidHex) {
      return true;
    }
  }
  return false;
}

function sanitizeRequestMetadata(
  rawMetadata: unknown,
  onChainHash: string,
  viewerAddress: string | null,
  creatorAddress: string,
): {
  metadata: Record<string, unknown> | null;
  hashMismatch: boolean;
  hidden: boolean;
} {
  if (!rawMetadata || typeof rawMetadata !== "object") {
    return { metadata: null, hashMismatch: false, hidden: false };
  }

  const meta = rawMetadata as Record<string, unknown>;
  const isHidden = meta.hidden === true;
  const isModerator = viewerAddress ? config.adminAddresses.includes(viewerAddress) : false;
  const isOwner = viewerAddress === creatorAddress;

  const title = typeof meta.title === "string" ? meta.title : "";
  const description = typeof meta.description === "string" ? meta.description : "";
  const mediaHashes = Array.isArray(meta.mediaHashes)
    ? (meta.mediaHashes as string[])
    : [];
  const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
  const cid = typeof meta.cid === "string" ? meta.cid : undefined;

  const computed = computeMetadataHash({ title, description, mediaHashes, tags });
  const hashMismatch =
    typeof meta.hashMismatch === "boolean"
      ? meta.hashMismatch
      : !checkContentHashMatch(onChainHash, computed, cid);

  if (isHidden && !isOwner && !isModerator) {
    return {
      metadata: {
        title: "[Content hidden by moderator]",
        description: "",
        mediaHashes: [],
        tags: [],
        hidden: true,
      },
      hashMismatch,
      hidden: true,
    };
  }

  return {
    metadata: {
      title,
      description,
      mediaHashes,
      tags,
      ...(cid ? { cid } : {}),
      hidden: isHidden,
    },
    hashMismatch,
    hidden: isHidden,
  };
}

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  // GET /requests
  app.get(
    "/requests",
    {
      schema: {
        tags: ["requests"],
        summary: "List and filter help requests",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            nearingGoal: { type: "string", enum: ["true", "false"] },
            endingSoon: { type: "string", enum: ["true", "false"] },
            tag: { type: "string" },
            creator: { type: "string" },
            cursor: { type: "string" },
            limit: { type: "integer", default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              requests: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    id: { type: "string" },
                    creator: { type: "string" },
                    token: { type: "string" },
                    goal: { type: "string" },
                    raised: { type: "string" },
                    deadline: { type: "string" },
                    status: { type: "string" },
                    contentHash: { type: "string" },
                    metadata: { type: ["object", "null"], additionalProperties: true },
                    hashMismatch: { type: "boolean" },
                    createdAt: { type: "string" },
                    updatedAt: { type: "string" },
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
      const parsed = RequestsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        });
      }

      const { status, nearingGoal, endingSoon, tag, creator, cursor, limit } = parsed.data;
      const where: Record<string, unknown> = {};

      if (status) {
        where.status = status;
      } else if (nearingGoal || endingSoon) {
        where.status = "Open";
      }

      if (creator) {
        where.creator = creator;
      }

      if (endingSoon) {
        const now = new Date();
        const soon = new Date(now.getTime() + 72 * 3600 * 1000);
        where.deadline = { gt: now, lte: soon };
      }

      let cursorId: bigint | undefined;
      if (cursor) {
        try {
          cursorId = BigInt(cursor);
        } catch {
          return reply.code(400).send({
            type: "https://stellaraid.app/errors/bad-request",
            title: "Bad Request",
            status: 400,
            detail: "Invalid cursor format",
          });
        }
      }

      const rows = await prisma.helpRequest.findMany({
        where,
        orderBy: { id: "desc" },
        ...(cursorId !== undefined ? { skip: 1, cursor: { id: cursorId } } : {}),
        take: nearingGoal || tag ? 200 : limit + 1,
        include: {
          milestones: { orderBy: { index: "asc" } },
        },
      });

      const viewerAddress = request.user?.address ?? null;
      const normalizedTag = tag ? tag.toLowerCase().replace(/^#/, "") : undefined;

      const filtered = rows.filter((r) => {
        if (nearingGoal) {
          if (r.goal <= 0n) return false;
          // Nearing goal: >= 75% funded and < 100% funded
          const pct = (r.raised * 100n) / r.goal;
          if (pct < 75n || r.raised >= r.goal) return false;
        }
        if (normalizedTag) {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          if (meta.hidden === true) return false;
          const tags = Array.isArray(meta.tags)
            ? (meta.tags as string[]).map((t) => String(t).toLowerCase().replace(/^#/, ""))
            : [];
          const text = `${String(meta.title ?? "")} ${String(meta.description ?? "")}`.toLowerCase();
          if (!tags.includes(normalizedTag) && !text.includes(normalizedTag)) {
            return false;
          }
        }
        return true;
      });

      const pageItems = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor = hasMore && lastItem ? lastItem.id.toString() : null;

      return reply.send({
        requests: pageItems.map((r) => {
          const { metadata, hashMismatch } = sanitizeRequestMetadata(
            r.metadata,
            r.contentHash,
            viewerAddress,
            r.creator,
          );
          return {
            id: r.id.toString(),
            creator: r.creator,
            token: r.token,
            goal: r.goal.toString(),
            raised: r.raised.toString(),
            deadline: r.deadline.toISOString(),
            status: r.status,
            contentHash: r.contentHash,
            metadata,
            hashMismatch,
            milestones: r.milestones.map((m) => ({
              index: m.index,
              amount: m.amount.toString(),
              status: m.status,
              evidenceHash: m.evidenceHash,
            })),
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          };
        }),
        nextCursor,
      });
    },
  );

  // GET /requests/:id
  app.get(
    "/requests/:id",
    {
      schema: {
        tags: ["requests"],
        summary: "Get help request detail, progress, and milestones",
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
              creator: { type: "string" },
              token: { type: "string" },
              goal: { type: "string" },
              raised: { type: "string" },
              deadline: { type: "string" },
              status: { type: "string" },
              contentHash: { type: "string" },
              metadata: { type: ["object", "null"], additionalProperties: true },
              hashMismatch: { type: "boolean" },
              creatorProfile: {
                type: ["object", "null"],
                properties: {
                  address: { type: "string" },
                  displayName: { type: ["string", "null"] },
                  bio: { type: ["string", "null"] },
                  avatarHash: { type: ["string", "null"] },
                },
              },
              milestones: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    index: { type: "integer" },
                    amount: { type: "string" },
                    status: { type: "string" },
                    evidenceHash: { type: ["string", "null"] },
                  },
                },
              },
              contributionsCount: { type: "integer" },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
          },
          400: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      let requestId: bigint;
      try {
        requestId = BigInt(id);
      } catch {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "Invalid request id",
        });
      }

      const row = await prisma.helpRequest.findUnique({
        where: { id: requestId },
        include: {
          milestones: { orderBy: { index: "asc" } },
          _count: { select: { contributions: true } },
        },
      });

      if (!row) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Help request not found",
        });
      }

      const creatorUser = await prisma.user.findUnique({
        where: { address: row.creator },
      });

      const viewerAddress = request.user?.address ?? null;
      const { metadata, hashMismatch } = sanitizeRequestMetadata(
        row.metadata,
        row.contentHash,
        viewerAddress,
        row.creator,
      );

      return reply.send({
        id: row.id.toString(),
        creator: row.creator,
        token: row.token,
        goal: row.goal.toString(),
        raised: row.raised.toString(),
        deadline: row.deadline.toISOString(),
        status: row.status,
        contentHash: row.contentHash,
        metadata,
        hashMismatch,
        creatorProfile: creatorUser
          ? {
              address: creatorUser.address,
              displayName: creatorUser.displayName,
              bio: creatorUser.bio,
              avatarHash: creatorUser.avatarHash,
            }
          : {
              address: row.creator,
              displayName: null,
              bio: null,
              avatarHash: null,
            },
        milestones: row.milestones.map((m) => ({
          index: m.index,
          amount: m.amount.toString(),
          status: m.status,
          evidenceHash: m.evidenceHash,
        })),
        contributionsCount: row._count.contributions,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    },
  );

  // GET /requests/:id/contributions
  app.get(
    "/requests/:id/contributions",
    {
      schema: {
        tags: ["requests"],
        summary: "Get public contribution history for a help request",
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
              contributions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    requestId: { type: "string" },
                    contributor: { type: "string" },
                    amount: { type: "string" },
                    txHash: { type: "string" },
                    ledger: { type: "string" },
                    createdAt: { type: "string" },
                  },
                },
              },
              nextCursor: { type: ["string", "null"] },
            },
          },
          400: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      let requestId: bigint;
      try {
        requestId = BigInt(id);
      } catch {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "Invalid request id",
        });
      }

      const parsed = ContributionsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        });
      }

      const exists = await prisma.helpRequest.findUnique({
        where: { id: requestId },
        select: { id: true },
      });
      if (!exists) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Help request not found",
        });
      }

      const { cursor, limit } = parsed.data;
      const rows = await prisma.contribution.findMany({
        where: { requestId },
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
        contributions: rows.map((c) => ({
          id: c.id,
          requestId: c.requestId.toString(),
          contributor: c.contributor,
          amount: c.amount.toString(),
          txHash: c.txHash,
          ledger: c.ledger.toString(),
          createdAt: c.createdAt.toISOString(),
        })),
        nextCursor,
      });
    },
  );

  // POST /requests/:id/metadata
  app.post(
    "/requests/:id/metadata",
    {
      schema: {
        tags: ["requests"],
        summary: "Attach off-chain description and media referenced by on-chain hash (creator only)",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["title", "description"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 160 },
            description: { type: "string", minLength: 1, maxLength: 5000 },
            mediaHashes: { type: "array", items: { type: "string" }, maxItems: 4 },
            tags: { type: "array", items: { type: "string" }, maxItems: 10 },
            cid: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              contentHash: { type: "string" },
              computedHash: { type: "string" },
              hashMismatch: { type: "boolean" },
              metadata: { type: "object", additionalProperties: true },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
          403: { type: "object", additionalProperties: true },
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      const user = request.user;

      const { id } = request.params as { id: string };
      let requestId: bigint;
      try {
        requestId = BigInt(id);
      } catch {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "Invalid request id",
        });
      }

      const parsed = AttachMetadataSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid metadata payload",
        });
      }

      const row = await prisma.helpRequest.findUnique({
        where: { id: requestId },
      });

      if (!row) {
        return reply.code(404).send({
          type: "https://stellaraid.app/errors/not-found",
          title: "Not Found",
          status: 404,
          detail: "Help request not found",
        });
      }

      if (row.creator !== user.address) {
        return reply.code(403).send({
          type: "https://stellaraid.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Only the request creator can attach metadata",
        });
      }

      const { title, description, mediaHashes, tags, cid } = parsed.data;
      const computedHash = computeMetadataHash({ title, description, mediaHashes, tags });
      const hashMismatch = !checkContentHashMatch(row.contentHash, computedHash, cid);

      const existingMeta =
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {};

      const metadataToStore = {
        ...existingMeta,
        title,
        description,
        mediaHashes,
        tags,
        ...(cid ? { cid } : {}),
        computedHash,
        hashMismatch,
      };

      await prisma.helpRequest.update({
        where: { id: requestId },
        data: {
          metadata: metadataToStore,
        },
      });

      return reply.send({
        id: row.id.toString(),
        contentHash: row.contentHash,
        computedHash,
        hashMismatch,
        metadata: {
          title,
          description,
          mediaHashes,
          tags,
          ...(cid ? { cid } : {}),
        },
      });
    },
  );
}
