/**
 * Profile routes.
 *
 * GET  /profiles/:address     – public profile with reputation and stats
 * PUT  /profiles/me           – update own profile (lazily creates User row)
 * POST /profiles/:address/follow – follow/unfollow toggle
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { requireAuth } from "../../plugins/auth";
import { deriveBadgesForScore } from "../../indexer/handlers/reputation";

// ── Zod schemas ────────────────────────────────────────────────────────────

const UpdateProfileSchema = z.object({
  displayName: z.string().max(50).optional(),
  bio: z.string().max(300).optional(),
  // avatarHash must look like an IPFS CIDv1 or CIDv0, or be absent.
  avatarHash: z
    .string()
    .regex(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{57,})$/, "must be a valid IPFS CID")
    .optional(),
});

const AddressParam = z.string().length(56).startsWith("G");

// ── Response helpers ───────────────────────────────────────────────────────

async function buildProfileResponse(address: string) {
  const [user, followerCount, followingCount] = await Promise.all([
    prisma.user.findUnique({ where: { address } }),
    prisma.follow.count({ where: { followeeAddress: address } }),
    prisma.follow.count({ where: { followerAddress: address } }),
  ]);

  let reputationScore = 0;
  try {
    const latestRep = await prisma.reputationEvent?.findFirst?.({
      where: { subject: address },
      orderBy: [{ ledger: "desc" }, { createdAt: "desc" }],
    });
    if (latestRep && typeof latestRep.newScore === "number") {
      reputationScore = latestRep.newScore;
    }
  } catch {
    reputationScore = 0;
  }

  return {
    address,
    displayName: user?.displayName ?? null,
    bio: user?.bio ?? null,
    avatarHash: user?.avatarHash ?? null,
    followerCount,
    followingCount,
    reputationScore,
    badges: deriveBadgesForScore(reputationScore),
    createdAt: user?.createdAt?.toISOString() ?? null,
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  // GET /profiles/:address
  app.get(
    "/profiles/:address",
    {
      schema: {
        tags: ["profiles"],
        summary: "Get a public profile",
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
              displayName: { type: ["string", "null"] },
              bio: { type: ["string", "null"] },
              avatarHash: { type: ["string", "null"] },
              followerCount: { type: "number" },
              followingCount: { type: "number" },
              reputationScore: { type: "integer" },
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
              createdAt: { type: ["string", "null"] },
            },
          },
          400: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params as { address: string };

      const parsed = AddressParam.safeParse(address);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "Invalid Stellar address",
        });
      }

      const profile = await buildProfileResponse(address);
      return reply.send(profile);
    },
  );

  // PUT /profiles/me
  app.put(
    "/profiles/me",
    {
      schema: {
        tags: ["profiles"],
        summary: "Update own profile",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          properties: {
            displayName: { type: "string", maxLength: 50 },
            bio: { type: "string", maxLength: 300 },
            avatarHash: { type: "string" },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);

      const parsed = UpdateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }

      const { displayName, bio, avatarHash } = parsed.data;

      // Lazily upsert the User row.
      await prisma.user.upsert({
        where: { address: request.user.address },
        create: {
          address: request.user.address,
          ...(displayName !== undefined && { displayName }),
          ...(bio !== undefined && { bio }),
          ...(avatarHash !== undefined && { avatarHash }),
        },
        update: {
          ...(displayName !== undefined && { displayName }),
          ...(bio !== undefined && { bio }),
          ...(avatarHash !== undefined && { avatarHash }),
        },
      });

      const profile = await buildProfileResponse(request.user.address);
      return reply.send(profile);
    },
  );

  // POST /profiles/:address/follow
  app.post(
    "/profiles/:address/follow",
    {
      schema: {
        tags: ["profiles"],
        summary: "Follow or unfollow an address (toggle)",
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["address"],
          properties: { address: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: { following: { type: "boolean" } },
            required: ["following"],
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);

      const { address } = request.params as { address: string };

      if (address === request.user.address) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "You cannot follow yourself",
        });
      }

      const parsed = AddressParam.safeParse(address);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "Invalid Stellar address",
        });
      }

      const existing = await prisma.follow.findUnique({
        where: {
          followerAddress_followeeAddress: {
            followerAddress: request.user.address,
            followeeAddress: address,
          },
        },
      });

      if (existing) {
        // Unfollow.
        await prisma.follow.delete({ where: { id: existing.id } });
        return reply.send({ following: false });
      }

      // Follow — ensure both User rows exist (lazy creation).
      await prisma.user.upsert({
        where: { address: request.user.address },
        create: { address: request.user.address },
        update: {},
      });

      await prisma.follow.create({
        data: {
          followerAddress: request.user.address,
          followeeAddress: address,
        },
      });

      return reply.send({ following: true });
    },
  );
}
