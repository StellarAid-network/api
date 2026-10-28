import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { signToken } from "../../src/lib/jwt";
import { config } from "../../src/config";
import { prisma } from "../../src/lib/db";
import {
  computeMetadataHash,
  checkContentHashMatch,
} from "../../src/modules/requests/routes";
import {
  sniffImageMagicBytes,
  computeDeterministicCidV1,
} from "../../src/modules/uploads/routes";

interface MockRequestRow {
  id: bigint;
  creator: string;
  token: string;
  goal: bigint;
  raised: bigint;
  deadline: Date;
  status: string;
  contentHash: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  milestones: Array<{
    id: string;
    requestId: bigint;
    index: number;
    amount: bigint;
    status: string;
    evidenceHash: string | null;
    updatedAt: Date;
  }>;
  _count: { contributions: number };
}

interface MockReportRow {
  id: string;
  reporter: string;
  targetType: "POST" | "COMMENT" | "REQUEST" | "USER";
  targetId: string;
  reason: string;
  status: "OPEN" | "REVIEWING" | "ACTIONED" | "DISMISSED";
  resolvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

describe("Day 5 API routes: requests, giveaways, uploads, search, and moderation", () => {
  let app: FastifyInstance;
  const creatorAddr = "GCFGKLCBV5IGJYGRR7FJNU53HFV5674PMQNNJT6HRAFGUAHZ7V3ZELXR";
  const otherAddr = "GBTYIQPBLDAXZ3DGFY5KAYFHRVGOF5V5GU263RTRVQQOAIICCW5S4VEQ";
  const moderatorAddr = "GD5DJQDDBKGAYNEAXU562HYGOOSYAEOO6AS53PZXBOZGCP5M2OPGMZV3";

  let requestsStore: MockRequestRow[] = [];
  let reportsStore: MockReportRow[] = [];
  let auditLogsStore: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    if (!config.adminAddresses.includes(moderatorAddr)) {
      config.adminAddresses.push(moderatorAddr);
    }
    const { buildApp } = await import("../../src/app");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    const now = new Date();
    const validMeta = {
      title: "Solar Microgrid for Clinic",
      description: "Emergency solar battery backup for community health clinic",
      mediaHashes: ["QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"],
      tags: ["solar", "medical"],
    };
    const matchingHash = computeMetadataHash(validMeta);

    requestsStore = [
      {
        id: 1n,
        creator: creatorAddr,
        token: "USDC",
        goal: 1000_0000000n,
        raised: 800_0000000n, // 80% -> nearingGoal
        deadline: new Date(now.getTime() + 24 * 3600 * 1000), // +24h -> endingSoon
        status: "Open",
        contentHash: matchingHash,
        metadata: { ...validMeta, computedHash: matchingHash, hashMismatch: false },
        createdAt: now,
        updatedAt: now,
        milestones: [
          {
            id: "m1",
            requestId: 1n,
            index: 0,
            amount: 1000_0000000n,
            status: "pending",
            evidenceHash: null,
            updatedAt: now,
          },
        ],
        _count: { contributions: 2 },
      },
      {
        id: 2n,
        creator: otherAddr,
        token: "XLM",
        goal: 500_0000000n,
        raised: 100_0000000n, // 20% -> not nearingGoal
        deadline: new Date(now.getTime() + 10 * 24 * 3600 * 1000), // +10d -> not endingSoon
        status: "Open",
        contentHash: "a".repeat(64),
        metadata: {
          title: "School Books Drive",
          description: "Textbooks for primary students",
          mediaHashes: [],
          tags: ["education"],
        },
        createdAt: now,
        updatedAt: now,
        milestones: [],
        _count: { contributions: 1 },
      },
    ];

    reportsStore = [];
    auditLogsStore = [];

    vi.spyOn(prisma.helpRequest, "findMany").mockImplementation((async (args?: {
      where?: { status?: string; creator?: string; deadline?: { gt: Date; lte: Date } };
      cursor?: { id: bigint };
      skip?: number;
      take?: number;
    }) => {
      let list = [...requestsStore].sort((a, b) => Number(b.id - a.id));
      if (args?.where?.status) {
        list = list.filter((r) => r.status === args.where?.status);
      }
      if (args?.where?.creator) {
        list = list.filter((r) => r.creator === args.where?.creator);
      }
      if (args?.where?.deadline) {
        const { gt, lte } = args.where.deadline;
        list = list.filter((r) => r.deadline > gt && r.deadline <= lte);
      }
      if (args?.cursor) {
        const idx = list.findIndex((r) => r.id === args.cursor?.id);
        if (idx >= 0) {
          list = list.slice(idx + (args.skip ?? 0));
        }
      }
      if (args?.take) {
        list = list.slice(0, args.take);
      }
      return list;
    }) as never);

    vi.spyOn(prisma.helpRequest, "findUnique").mockImplementation((async (args: {
      where: { id: bigint };
    }) => {
      return requestsStore.find((r) => r.id === args.where.id) ?? null;
    }) as never);

    vi.spyOn(prisma.helpRequest, "update").mockImplementation((async (args: {
      where: { id: bigint };
      data: { metadata?: Record<string, unknown> };
    }) => {
      const found = requestsStore.find((r) => r.id === args.where.id);
      if (!found) throw new Error("Not found");
      if (args.data.metadata !== undefined) {
        found.metadata = args.data.metadata;
      }
      return found;
    }) as never);

    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      address: creatorAddr,
      displayName: "Dr. Amina",
      bio: "Community clinic director",
      avatarHash: null,
      createdAt: now,
      updatedAt: now,
    });

    vi.spyOn(prisma.user, "findMany").mockResolvedValue([
      {
        address: creatorAddr,
        displayName: "Dr. Amina",
        bio: "Community clinic director",
        avatarHash: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    vi.spyOn(prisma.contribution, "findMany").mockResolvedValue([
      {
        id: "c1",
        requestId: 1n,
        contributor: otherAddr,
        amount: 500_0000000n,
        txHash: "tx_hash_1",
        ledger: 12345n,
        createdAt: now,
      },
    ]);

    vi.spyOn(prisma.giveaway, "findMany").mockResolvedValue([
      {
        id: "g1",
        balanceId: "00000000balance1",
        creator: creatorAddr,
        asset: "USDC",
        amount: 50_0000000n,
        claimants: [otherAddr],
        predicates: { expiresAt: new Date(now.getTime() + 12 * 3600 * 1000).toISOString() },
        status: "open",
        createdAt: now,
        updatedAt: now,
        _count: { claims: 0 },
      } as never,
    ]);

    vi.spyOn(prisma.giveaway, "findUnique").mockResolvedValue({
      id: "g1",
      balanceId: "00000000balance1",
      creator: creatorAddr,
      asset: "USDC",
      amount: 50_0000000n,
      claimants: [otherAddr],
      predicates: {},
      status: "open",
      createdAt: now,
      updatedAt: now,
      claims: [],
    } as never);

    vi.spyOn(prisma.report, "create").mockImplementation((async (args: {
      data: {
        reporter: string;
        targetType: "POST" | "COMMENT" | "REQUEST" | "USER";
        targetId: string;
        reason: string;
        status: "OPEN";
      };
    }) => {
      const row: MockReportRow = {
        id: `rep_${reportsStore.length + 1}`,
        reporter: args.data.reporter,
        targetType: args.data.targetType,
        targetId: args.data.targetId,
        reason: args.data.reason,
        status: args.data.status,
        resolvedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      reportsStore.push(row);
      return row;
    }) as never);

    vi.spyOn(prisma.report, "findMany").mockImplementation((async (args?: {
      where?: { status?: string };
    }) => {
      return reportsStore.filter((r) => !args?.where?.status || r.status === args.where.status);
    }) as never);

    vi.spyOn(prisma.report, "findUnique").mockImplementation((async (args: {
      where: { id: string };
    }) => {
      return reportsStore.find((r) => r.id === args.where.id) ?? null;
    }) as never);

    vi.spyOn(prisma, "$transaction").mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) => {
      const txClient = {
        post: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        comment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        helpRequest: {
          findUnique: prisma.helpRequest.findUnique,
          update: prisma.helpRequest.update,
        },
        report: {
          update: vi.fn().mockImplementation(async ({ where, data }) => {
            const rep = reportsStore.find((r) => r.id === where.id);
            if (!rep) throw new Error("Not found");
            rep.status = data.status;
            rep.resolvedBy = data.resolvedBy;
            rep.updatedAt = new Date();
            return rep;
          }),
        },
        moderationAuditLog: {
          create: vi.fn().mockImplementation(async ({ data }) => {
            const entry = {
              id: `audit_${auditLogsStore.length + 1}`,
              ...data,
              createdAt: new Date(),
            };
            auditLogsStore.push(entry);
            return entry;
          }),
        },
      };
      return fn(txClient);
    }) as never);
  });

  it("filters and paginates help requests and giveaways accurately", async () => {
    // 1. Nearing goal filter (only request 1 is at 80%)
    const nearingRes = await app.inject({
      method: "GET",
      url: "/requests?nearingGoal=true",
    });
    expect(nearingRes.statusCode).toBe(200);
    const nearingBody = nearingRes.json() as { requests: Array<{ id: string }> };
    expect(nearingBody.requests).toHaveLength(1);
    expect(nearingBody.requests[0]?.id).toBe("1");

    // 2. Ending soon filter (only request 1 expires within 72h)
    const endingRes = await app.inject({
      method: "GET",
      url: "/requests?endingSoon=true",
    });
    expect(endingRes.statusCode).toBe(200);
    expect((endingRes.json() as { requests: Array<{ id: string }> }).requests).toHaveLength(1);

    // 3. Tag filter
    const tagRes = await app.inject({
      method: "GET",
      url: "/requests?tag=solar",
    });
    expect(tagRes.statusCode).toBe(200);
    expect((tagRes.json() as { requests: Array<{ id: string }> }).requests[0]?.id).toBe("1");

    // 4. Cursor pagination (limit=1)
    const page1 = await app.inject({
      method: "GET",
      url: "/requests?limit=1",
    });
    const page1Body = page1.json() as { requests: Array<{ id: string }>; nextCursor: string | null };
    expect(page1Body.requests).toHaveLength(1);
    expect(page1Body.requests[0]?.id).toBe("2");
    expect(page1Body.nextCursor).toBe("2");

    const page2 = await app.inject({
      method: "GET",
      url: `/requests?limit=1&cursor=${page1Body.nextCursor}`,
    });
    const page2Body = page2.json() as { requests: Array<{ id: string }>; nextCursor: string | null };
    expect(page2Body.requests).toHaveLength(1);
    expect(page2Body.requests[0]?.id).toBe("1");
    expect(page2Body.nextCursor).toBeNull();

    // 5. Request detail & contributions
    const detailRes = await app.inject({ method: "GET", url: "/requests/1" });
    expect(detailRes.statusCode).toBe(200);
    expect((detailRes.json() as { hashMismatch: boolean }).hashMismatch).toBe(false);

    const contribRes = await app.inject({ method: "GET", url: "/requests/1/contributions" });
    expect(contribRes.statusCode).toBe(200);
    expect((contribRes.json() as { contributions: unknown[] }).contributions).toHaveLength(1);

    // 6. Giveaways list and detail
    const giveawaysRes = await app.inject({ method: "GET", url: "/giveaways?endingSoon=true" });
    expect(giveawaysRes.statusCode).toBe(200);
    expect((giveawaysRes.json() as { giveaways: unknown[] }).giveaways).toHaveLength(1);

    const giveawayDetail = await app.inject({ method: "GET", url: "/giveaways/g1" });
    expect(giveawayDetail.statusCode).toBe(200);
  });

  it("enforces creator-only access on POST /requests/:id/metadata and flags contentHash mismatches", async () => {
    const creatorJwt = signToken(creatorAddr, config.jwtSecret, "1h");
    const otherJwt = signToken(otherAddr, config.jwtSecret, "1h");

    // Non-creator rejected with 403
    const forbiddenRes = await app.inject({
      method: "POST",
      url: "/requests/1/metadata",
      headers: { authorization: `Bearer ${otherJwt}` },
      payload: {
        title: "Tampered Title",
        description: "Unauthorized edit attempt",
      },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // Creator submits exact matching content -> hashMismatch: false
    const matchingPayload = {
      title: "Solar Microgrid for Clinic",
      description: "Emergency solar battery backup for community health clinic",
      mediaHashes: ["QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"],
      tags: ["solar", "medical"],
    };
    const matchRes = await app.inject({
      method: "POST",
      url: "/requests/1/metadata",
      headers: { authorization: `Bearer ${creatorJwt}` },
      payload: matchingPayload,
    });
    expect(matchRes.statusCode).toBe(200);
    expect((matchRes.json() as { hashMismatch: boolean }).hashMismatch).toBe(false);

    // Creator submits modified text that does not match on-chain hash -> hashMismatch: true
    const mismatchRes = await app.inject({
      method: "POST",
      url: "/requests/1/metadata",
      headers: { authorization: `Bearer ${creatorJwt}` },
      payload: {
        ...matchingPayload,
        description: "Changed description that differs from on-chain commitment",
      },
    });
    expect(mismatchRes.statusCode).toBe(200);
    expect((mismatchRes.json() as { hashMismatch: boolean }).hashMismatch).toBe(true);
    expect(checkContentHashMatch("abcd", "1234")).toBe(false);
  });

  it("validates MIME types and magic bytes on POST /uploads", async () => {
    const userJwt = signToken(creatorAddr, config.jwtSecret, "1h");

    // Valid PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    expect(sniffImageMagicBytes(pngBytes)).toBe("image/png");
    expect(computeDeterministicCidV1(pngBytes).cid).toMatch(/^bafkrei/);

    const okRes = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { authorization: `Bearer ${userJwt}` },
      payload: {
        filename: "evidence.png",
        mimeType: "image/png",
        dataBase64: pngBytes.toString("base64"),
      },
    });
    expect(okRes.statusCode).toBe(201);
    const okBody = okRes.json() as { cid: string; hash: string; size: number };
    expect(okBody.cid).toMatch(/^bafkrei/);
    expect(okBody.size).toBe(pngBytes.length);

    // Spoofed file (declares image/png but has plain text bytes) -> 415 Unsupported Media Type
    const textBytes = Buffer.from("not an image file");
    const spoofRes = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { authorization: `Bearer ${userJwt}` },
      payload: {
        filename: "exploit.png",
        mimeType: "image/png",
        dataBase64: textBytes.toString("base64"),
      },
    });
    expect(spoofRes.statusCode).toBe(415);
  });

  it("enforces moderator access, status machine, audit logs, and hides content in search/reads without touching funds", async () => {
    const userJwt = signToken(otherAddr, config.jwtSecret, "1h");
    const modJwt = signToken(moderatorAddr, config.jwtSecret, "1h");

    // 1. User files a report against request 1
    const createReportRes = await app.inject({
      method: "POST",
      url: "/reports",
      headers: { authorization: `Bearer ${userJwt}` },
      payload: {
        targetType: "REQUEST",
        targetId: "1",
        reason: "Misleading off-chain description",
      },
    });
    expect(createReportRes.statusCode).toBe(201);
    const report = createReportRes.json() as { id: string; status: string };
    expect(report.status).toBe("OPEN");

    // 2. Non-moderator cannot view or resolve reports -> 403 Forbidden
    const unauthQueue = await app.inject({
      method: "GET",
      url: "/admin/reports",
      headers: { authorization: `Bearer ${userJwt}` },
    });
    expect(unauthQueue.statusCode).toBe(403);

    const unauthResolve = await app.inject({
      method: "POST",
      url: `/admin/reports/${report.id}/resolve`,
      headers: { authorization: `Bearer ${userJwt}` },
      payload: { status: "ACTIONED", hideContent: true },
    });
    expect(unauthResolve.statusCode).toBe(403);

    // 3. Moderator moves report OPEN -> REVIEWING -> ACTIONED (with hideContent: true)
    const reviewRes = await app.inject({
      method: "POST",
      url: `/admin/reports/${report.id}/resolve`,
      headers: { authorization: `Bearer ${modJwt}` },
      payload: { status: "REVIEWING", note: "Investigating description" },
    });
    expect(reviewRes.statusCode).toBe(200);
    expect((reviewRes.json() as { report: { status: string } }).report.status).toBe("REVIEWING");

    const actionRes = await app.inject({
      method: "POST",
      url: `/admin/reports/${report.id}/resolve`,
      headers: { authorization: `Bearer ${modJwt}` },
      payload: {
        status: "ACTIONED",
        hideContent: true,
        note: "Confirmed spam description; hiding off-chain text",
      },
    });
    expect(actionRes.statusCode).toBe(200);
    const actionBody = actionRes.json() as {
      report: { status: string; resolvedBy: string };
      auditLog: { action: string; previousStatus: string; newStatus: string };
    };
    expect(actionBody.report.status).toBe("ACTIONED");
    expect(actionBody.report.resolvedBy).toBe(moderatorAddr);
    expect(actionBody.auditLog.previousStatus).toBe("REVIEWING");
    expect(actionBody.auditLog.newStatus).toBe("ACTIONED");
    expect(auditLogsStore).toHaveLength(2);

    // 4. Cannot transition an already ACTIONED report -> 409 Conflict
    const invalidTransition = await app.inject({
      method: "POST",
      url: `/admin/reports/${report.id}/resolve`,
      headers: { authorization: `Bearer ${modJwt}` },
      payload: { status: "DISMISSED" },
    });
    expect(invalidTransition.statusCode).toBe(409);

    // 5. Hidden content is excluded from /search and masked for public viewers,
    //    while on-chain escrow amounts (goal, raised, status) remain untouched!
    const searchRes = await app.inject({
      method: "GET",
      url: "/search?q=Solar",
    });
    expect(searchRes.statusCode).toBe(200);
    expect((searchRes.json() as { requests: unknown[] }).requests).toHaveLength(0);

    const publicReqRes = await app.inject({
      method: "GET",
      url: "/requests/1",
    });
    const publicReq = publicReqRes.json() as {
      goal: string;
      raised: string;
      status: string;
      metadata: { title: string; description: string; hidden: boolean };
    };
    expect(publicReq.goal).toBe("10000000000");
    expect(publicReq.raised).toBe("8000000000");
    expect(publicReq.status).toBe("Open");
    expect(publicReq.metadata.hidden).toBe(true);
    expect(publicReq.metadata.title).toBe("[Content hidden by moderator]");
    expect(publicReq.metadata.description).toBe("");
  });
});
