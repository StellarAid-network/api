import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { signToken } from "../../src/lib/jwt";
import { config } from "../../src/config";
import { prisma } from "../../src/lib/db";
import { dispatchSorobanEvent } from "../../src/indexer/handlers";
import { reconcile } from "../../src/indexer/reconcile";
import { getIndexerMetrics, resetIndexerMetricsForTesting } from "../../src/indexer/metrics";

interface MockRepEvent {
  id: string;
  subject: string;
  delta: number;
  newScore: number;
  refId: string;
  ledger: bigint;
  createdAt: Date;
}

interface MockAttestation {
  id: string;
  attestor: string;
  subject: string;
  kind: string;
  contentHash: string;
  expiresAt: Date | null;
  revoked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface MockNotification {
  id: string;
  recipient: string;
  kind: string;
  title: string;
  body: string;
  refId: string | null;
  read: boolean;
  createdAt: Date;
}

describe("Day 6 API: trust indexer/routes, chain reconciliation, notifications, metrics, and authz matrix", () => {
  let app: FastifyInstance;
  const aliceAddr = "GCFGKLCBV5IGJYGRR7FJNU53HFV5674PMQNNJT6HRAFGUAHZ7V3ZELXR";
  const bobAddr = "GBTYIQPBLDAXZ3DGFY5KAYFHRVGOF5V5GU263RTRVQQOAIICCW5S4VEQ";
  const moderatorAddr = "GD5DJQDDBKGAYNEAXU562HYGOOSYAEOO6AS53PZXBOZGCP5M2OPGMZV3";
  const attestorAddr = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  let repEventsStore: MockRepEvent[] = [];
  let attestationsStore: MockAttestation[] = [];
  let notificationsStore: MockNotification[] = [];
  let requestsStore: Array<{
    id: bigint;
    creator: string;
    raised: bigint;
    status: string;
    contentHash: string;
    metadata: Record<string, unknown> | null;
  }> = [];
  let contributionsSums = new Map<string, bigint>();
  let postsStore: Array<{
    id: string;
    author: string;
    body: string;
    status: string;
    createdAt: Date;
  }> = [];

  const tokenFor = (addr: string) => signToken(addr, config.jwtSecret, "1h");

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
    vi.restoreAllMocks();
    resetIndexerMetricsForTesting();
    repEventsStore = [];
    attestationsStore = [];
    notificationsStore = [];
    requestsStore = [
      {
        id: 10n,
        creator: aliceAddr,
        raised: 25_0000000n, // drifted! chain has 100_0000000n
        status: "open",
        contentHash: "a".repeat(64),
        metadata: null,
      },
      {
        id: 11n,
        creator: bobAddr,
        raised: 0n, // drifted! contributions sum is 40_0000000n
        status: "open",
        contentHash: "b".repeat(64),
        metadata: null,
      },
    ];
    contributionsSums = new Map([
      ["10", 100_0000000n],
      ["11", 40_0000000n],
    ]);
    postsStore = [
      {
        id: "post_1",
        author: aliceAddr,
        body: "Community clinic update",
        status: "VISIBLE",
        createdAt: new Date(),
      },
    ];

    vi.spyOn(prisma.reputationEvent, "findMany").mockImplementation((async (args?: {
      where?: { subject?: string };
    }) => {
      const subject = args?.where?.subject;
      return repEventsStore
        .filter((e) => !subject || e.subject === subject)
        .sort((a, b) => Number(b.ledger - a.ledger));
    }) as never);

    vi.spyOn(prisma.reputationEvent, "findFirst").mockImplementation((async (args?: {
      where?: { subject?: string };
    }) => {
      const subject = args?.where?.subject;
      const matches = repEventsStore
        .filter((e) => !subject || e.subject === subject)
        .sort((a, b) => Number(b.ledger - a.ledger));
      return matches[0] ?? null;
    }) as never);

    vi.spyOn(prisma.attestation, "findMany").mockImplementation((async (args?: {
      where?: { subject?: string; revoked?: boolean };
    }) => {
      return attestationsStore.filter((a) => {
        if (args?.where?.subject && a.subject !== args.where.subject) return false;
        if (args?.where?.revoked !== undefined && a.revoked !== args.where.revoked) return false;
        return true;
      });
    }) as never);

    vi.spyOn(prisma.notification, "create").mockImplementation((async (args: {
      data: Omit<MockNotification, "id" | "read" | "createdAt">;
    }) => {
      const created: MockNotification = {
        id: `notif_${notificationsStore.length + 1}`,
        recipient: args.data.recipient,
        kind: args.data.kind,
        title: args.data.title,
        body: args.data.body,
        refId: args.data.refId ?? null,
        read: false,
        createdAt: new Date(),
      };
      notificationsStore.push(created);
      return created;
    }) as never);

    vi.spyOn(prisma.notification, "findMany").mockImplementation((async (args?: {
      where?: { recipient?: string; read?: boolean };
    }) => {
      return notificationsStore.filter((n) => {
        if (args?.where?.recipient && n.recipient !== args.where.recipient) return false;
        if (args?.where?.read !== undefined && n.read !== args.where.read) return false;
        return true;
      });
    }) as never);

    vi.spyOn(prisma.notification, "count").mockImplementation((async (args?: {
      where?: { recipient?: string; read?: boolean };
    }) => {
      return notificationsStore.filter((n) => {
        if (args?.where?.recipient && n.recipient !== args.where.recipient) return false;
        if (args?.where?.read !== undefined && n.read !== args.where.read) return false;
        return true;
      }).length;
    }) as never);

    vi.spyOn(prisma.notification, "findUnique").mockImplementation((async (args: {
      where: { id: string };
    }) => {
      return notificationsStore.find((n) => n.id === args.where.id) ?? null;
    }) as never);

    vi.spyOn(prisma.notification, "update").mockImplementation((async (args: {
      where: { id: string };
      data: { read: boolean };
    }) => {
      const target = notificationsStore.find((n) => n.id === args.where.id);
      if (!target) throw new Error("Not found");
      target.read = args.data.read;
      return target;
    }) as never);

    vi.spyOn(prisma.helpRequest, "findMany").mockImplementation((async () => {
      return requestsStore.map((r) => ({ id: r.id, raised: r.raised, status: r.status }));
    }) as never);

    vi.spyOn(prisma.helpRequest, "findUnique").mockImplementation((async (args: {
      where: { id: bigint };
    }) => {
      return requestsStore.find((r) => r.id === args.where.id) ?? null;
    }) as never);

    vi.spyOn(prisma.helpRequest, "update").mockImplementation((async (args: {
      where: { id: bigint };
      data: { raised?: bigint; status?: string; metadata?: Record<string, unknown> };
    }) => {
      const target = requestsStore.find((r) => r.id === args.where.id);
      if (!target) throw new Error("Not found");
      if (args.data.raised !== undefined) target.raised = args.data.raised;
      if (args.data.status !== undefined) target.status = args.data.status;
      if (args.data.metadata !== undefined) target.metadata = args.data.metadata;
      return target;
    }) as never);

    vi.spyOn(prisma.contribution, "aggregate").mockImplementation((async (args: {
      where?: { requestId?: bigint };
    }) => {
      const key = args.where?.requestId?.toString() ?? "";
      return { _sum: { amount: contributionsSums.get(key) ?? 0n } };
    }) as never);

    vi.spyOn(prisma.post, "findUnique").mockImplementation((async (args: {
      where: { id: string };
    }) => {
      return postsStore.find((p) => p.id === args.where.id) ?? null;
    }) as never);

    vi.spyOn(prisma.user, "findUnique").mockImplementation((async () => null) as never);
    vi.spyOn(prisma.user, "upsert").mockImplementation((async (args: {
      where: { address: string };
    }) => ({
      address: args.where.address,
      displayName: null,
      bio: null,
      avatarHash: null,
      createdAt: new Date(Date.now() - 86_400_000),
      updatedAt: new Date(),
    })) as never);

    vi.spyOn(prisma.comment, "create").mockImplementation((async (args: {
      data: { postId: string; author: string; body: string; status: string };
    }) => ({
      id: "comment_1",
      postId: args.data.postId,
      author: args.data.author,
      body: args.data.body,
      status: args.data.status,
      createdAt: new Date(),
    })) as never);
  });

  describe("1. Reputation & Attestation Indexer Handlers and Routes", () => {
    it("indexes score_changed, attested, and revoked events and serves GET /reputation/:address & GET /attestations/:subject", async () => {
      const mockTx = {
        reputationEvent: {
          upsert: vi
            .fn()
            .mockImplementation(async ({ create }: { create: Omit<MockRepEvent, "createdAt"> }) => {
              const entry: MockRepEvent = { ...create, createdAt: new Date() };
              repEventsStore.push(entry);
              return entry;
            }),
        },
        attestation: {
          upsert: vi
            .fn()
            .mockImplementation(
              async ({
                where,
                update,
                create,
              }: {
                where: { id: string };
                update: Partial<MockAttestation>;
                create: Omit<MockAttestation, "createdAt" | "updatedAt">;
              }) => {
                const existing = attestationsStore.find((a) => a.id === where.id);
                if (existing) {
                  Object.assign(existing, update, { updatedAt: new Date() });
                  return existing;
                }
                const created: MockAttestation = {
                  ...create,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                };
                attestationsStore.push(created);
                return created;
              },
            ),
        },
      } as unknown as Prisma.TransactionClient;

      await dispatchSorobanEvent(
        {
          type: "reputation.score_changed",
          subject: aliceAddr,
          delta: 55,
          newScore: 55,
          refId: "req_10",
        },
        mockTx,
        { eventId: "evt_rep_1", ledger: 500 },
      );

      await dispatchSorobanEvent(
        {
          type: "attestation.attested",
          attestationId: 1n,
          attestor: attestorAddr,
          subject: aliceAddr,
        },
        mockTx,
        {
          eventId: "evt_att_1",
          ledger: 501,
          lookupAttestationDetails: async () => ({
            kind: "verified_org",
            contentHash: "c".repeat(64),
            expiresAt: new Date(Date.now() + 86_400_000),
          }),
        },
      );

      await dispatchSorobanEvent(
        {
          type: "attestation.attested",
          attestationId: 2n,
          attestor: attestorAddr,
          subject: aliceAddr,
        },
        mockTx,
        { eventId: "evt_att_2", ledger: 502 },
      );

      // Revoke attestation #2
      await dispatchSorobanEvent(
        {
          type: "attestation.revoked",
          attestationId: 2n,
          attestor: attestorAddr,
          subject: aliceAddr,
        },
        mockTx,
        { eventId: "evt_att_3", ledger: 503 },
      );

      const repRes = await app.inject({
        method: "GET",
        url: `/reputation/${aliceAddr}`,
      });
      expect(repRes.statusCode).toBe(200);
      const repJson = repRes.json();
      expect(repJson.score).toBe(55);
      expect(repJson.badges.map((b: { name: string }) => b.name)).toEqual(["Helper", "Advocate"]);
      expect(repJson.events).toHaveLength(1);

      const attRes = await app.inject({
        method: "GET",
        url: `/attestations/${aliceAddr}`,
      });
      expect(attRes.statusCode).toBe(200);
      const attJson = attRes.json();
      expect(attJson.attestations).toHaveLength(1);
      expect(attJson.attestations[0].kind).toBe("verified_org");

      const allAttRes = await app.inject({
        method: "GET",
        url: `/attestations/${aliceAddr}?includeRevoked=true`,
      });
      expect(allAttRes.json().attestations).toHaveLength(2);
    });
  });

  describe("2. Reconciliation repairs injected drift toward chain state", () => {
    it("repairs drifted raised & status from chain reader and contribution sums, updating metrics", async () => {
      const result = await reconcile({
        chainReader: async (requestId) => {
          if (requestId === 10n) {
            return { raised: 100_0000000n, status: "funded" };
          }
          // Simulate offline/not-yet-cached RPC for request 11 -> falls back to contribution sum
          return null;
        },
      });

      expect(result.reconciledRequests).toBe(2);
      expect(result.fixedDiscrepancies).toBe(2);
      expect(requestsStore.find((r) => r.id === 10n)).toMatchObject({
        raised: 100_0000000n,
        status: "funded",
      });
      expect(requestsStore.find((r) => r.id === 11n)).toMatchObject({
        raised: 40_0000000n,
        status: "open",
      });

      const metrics = getIndexerMetrics();
      expect(metrics.reconciliation_runs_total).toBe(1);
      expect(metrics.reconciliation_discrepancies_repaired_total).toBe(2);
    });
  });

  describe("3. BullMQ Notifications Job & Routes", () => {
    it("creates in-app notifications on chain events and comments, enforcing recipient ownership", async () => {
      const mockTx = {
        helpRequest: {
          findUnique: prisma.helpRequest.findUnique,
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        contribution: {
          upsert: vi.fn().mockResolvedValue({}),
        },
        milestone: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      } as unknown as Prisma.TransactionClient;

      await dispatchSorobanEvent(
        {
          type: "help_request.contributed",
          requestId: 10n,
          contributor: bobAddr,
          amount: 25_0000000n,
          totalRaised: 50_0000000n,
        },
        mockTx,
        { eventId: "evt_c_1", ledger: 600 },
      );

      await dispatchSorobanEvent(
        {
          type: "help_request.funded",
          requestId: 10n,
          totalRaised: 100_0000000n,
        },
        mockTx,
        { eventId: "evt_f_1", ledger: 601 },
      );

      await dispatchSorobanEvent(
        {
          type: "help_request.milestone_approved",
          requestId: 10n,
          index: 0,
          approver: moderatorAddr,
        },
        mockTx,
        { eventId: "evt_m_1", ledger: 602 },
      );

      // Bob comments on Alice's post -> triggers comment_on_post notification
      const commentRes = await app.inject({
        method: "POST",
        url: "/posts/post_1/comments",
        headers: { authorization: `Bearer ${tokenFor(bobAddr)}` },
        payload: { body: "Wishing the clinic a speedy setup!" },
      });
      expect(commentRes.statusCode).toBe(201);

      expect(notificationsStore.map((n) => n.kind)).toEqual([
        "contribution_received",
        "goal_reached",
        "milestone_approved",
        "comment_on_post",
      ]);

      // Alice reads her notifications
      const listRes = await app.inject({
        method: "GET",
        url: "/notifications",
        headers: { authorization: `Bearer ${tokenFor(aliceAddr)}` },
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().unreadCount).toBe(4);

      // Bob cannot mark Alice's notification as read -> 403
      const forbidRead = await app.inject({
        method: "POST",
        url: "/notifications/notif_1/read",
        headers: { authorization: `Bearer ${tokenFor(bobAddr)}` },
      });
      expect(forbidRead.statusCode).toBe(403);

      // Alice marks her notification as read -> 200
      const okRead = await app.inject({
        method: "POST",
        url: "/notifications/notif_1/read",
        headers: { authorization: `Bearer ${tokenFor(aliceAddr)}` },
      });
      expect(okRead.statusCode).toBe(200);
      expect(okRead.json().read).toBe(true);
    });
  });

  describe("4. Internal-only /metrics & Observability", () => {
    it("blocks external x-forwarded-for requests on /metrics with 403 and allows loopback / internal token", async () => {
      const blocked = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { "x-forwarded-for": "203.0.113.45" },
      });
      expect(blocked.statusCode).toBe(403);

      process.env["METRICS_INTERNAL_TOKEN"] = "internal-scrape-token-test";
      const withToken = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: {
          "x-forwarded-for": "203.0.113.45",
          "x-internal-token": "internal-scrape-token-test",
        },
      });
      delete process.env["METRICS_INTERNAL_TOKEN"];

      expect(withToken.statusCode).toBe(200);
      expect(withToken.body).toContain("http_requests_total");
      expect(withToken.body).toContain("events_processed_per_minute");
      expect(withToken.body).toContain("notifications_queue_depth");
    });
  });

  describe("5. Route Authorization Matrix Audit", () => {
    it("enforces 401 on every JWT-protected route when unauthenticated", async () => {
      const protectedCalls: Array<{
        method: "GET" | "POST" | "PUT" | "DELETE";
        url: string;
        payload?: Record<string, unknown>;
      }> = [
        { method: "GET", url: "/auth/me" },
        { method: "PUT", url: "/profiles/me", payload: { displayName: "Anon" } },
        { method: "POST", url: `/profiles/${aliceAddr}/follow` },
        { method: "GET", url: "/feed?scope=following" },
        { method: "POST", url: "/posts", payload: { body: "hello" } },
        { method: "DELETE", url: "/posts/post_1" },
        { method: "POST", url: "/posts/post_1/comments", payload: { body: "hi" } },
        {
          method: "POST",
          url: "/requests/10/metadata",
          payload: { title: "Valid Title", description: "Valid longer description text" },
        },
        { method: "POST", url: "/uploads", payload: { mimeType: "image/png", dataBase64: "AA==" } },
        {
          method: "POST",
          url: "/reports",
          payload: { targetType: "POST", targetId: "post_1", reason: "Spam link" },
        },
        { method: "GET", url: "/admin/reports" },
        { method: "POST", url: "/admin/reports/rep_1/resolve", payload: { status: "DISMISSED" } },
        { method: "GET", url: "/notifications" },
        { method: "POST", url: "/notifications/notif_1/read" },
      ];

      for (const call of protectedCalls) {
        const res = await app.inject({
          method: call.method,
          url: call.url,
          ...(call.payload ? { payload: call.payload } : {}),
        });
        expect(
          res.statusCode,
          `Expected 401 for unauthenticated ${call.method} ${call.url}, got ${res.statusCode}`,
        ).toBe(401);
      }
    });

    it("enforces 403 on resource-owner and moderator-only routes when authenticated as non-owner / non-moderator", async () => {
      // Bob (non-owner) tries to delete Alice's post -> 403
      const delPost = await app.inject({
        method: "DELETE",
        url: "/posts/post_1",
        headers: { authorization: `Bearer ${tokenFor(bobAddr)}` },
      });
      expect(delPost.statusCode).toBe(403);

      // Bob (non-creator) tries to overwrite Alice's request metadata -> 403
      const reqMeta = await app.inject({
        method: "POST",
        url: "/requests/10/metadata",
        headers: { authorization: `Bearer ${tokenFor(bobAddr)}` },
        payload: {
          title: "Attempted hijack title",
          description: "Attempted hijack description body",
        },
      });
      expect(reqMeta.statusCode).toBe(403);

      // Bob (non-moderator) tries to access moderator queue and resolve endpoint -> 403
      const modQueue = await app.inject({
        method: "GET",
        url: "/admin/reports",
        headers: { authorization: `Bearer ${tokenFor(bobAddr)}` },
      });
      expect(modQueue.statusCode).toBe(403);

      const modResolve = await app.inject({
        method: "POST",
        url: "/admin/reports/r1/resolve",
        headers: { authorization: `Bearer ${tokenFor(bobAddr)}` },
        payload: { status: "DISMISSED" },
      });
      expect(modResolve.statusCode).toBe(403);
    });
  });
});
