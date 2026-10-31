/**
 * Reproducible load & throughput benchmark for @stellar-aid/api:
 * 1. Measures concurrent HTTP throughput (req/s) and p50 / p95 / p99 latency on
 *    GET /feed, GET /requests, GET /reputation/:address, and POST /posts.
 * 2. Measures 1,000-event indexer handler replay throughput (events/sec).
 */

import type { InjectOptions } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { performance } from "node:perf_hooks";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgresql://stellaraid:stellaraid@localhost:5432/stellaraid";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.STELLAR_NETWORK ??= "testnet";
process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL ??= "https://horizon-testnet.stellar.org";
process.env.SEP10_SIGNING_SECRET ??= Keypair.random().secret();
process.env.SEP10_HOME_DOMAIN ??= "localhost:3000";
process.env.JWT_SECRET ??= "loadtest-jwt-secret-minimum-32-chars-long";
process.env.CORS_ORIGINS ??= "http://localhost:3000";
process.env.MIN_ACCOUNT_AGE_SECONDS ??= "0";

const ALICE = Keypair.random().publicKey();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function main(): Promise<void> {
  const [
    { prisma },
    { redis },
    { signToken },
    { config },
    { buildApp },
    { handleReputationEvent },
  ] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/redis"),
    import("../src/lib/jwt"),
    import("../src/config"),
    import("../src/app"),
    import("../src/indexer/handlers/reputation"),
  ]);

  const samplePosts = Array.from({ length: 20 }, (_, i) => ({
    id: `post_${i}`,
    author: ALICE,
    body: `Solar microgrid milestone update #${i} #solar`,
    mediaHashes: [],
    status: "VISIBLE",
    createdAt: new Date(Date.now() - i * 60_000),
    authorUser: { displayName: "Adaeze", avatarHash: null },
    _count: { comments: 2 },
  }));

  const sampleRequests = Array.from({ length: 20 }, (_, i) => ({
    id: BigInt(i + 1),
    creator: ALICE,
    token: "USDC",
    goal: 500_0000000n,
    raised: 250_0000000n,
    deadline: new Date(Date.now() + 86_400_000 * 7),
    status: "open",
    contentHash: "a".repeat(64),
    metadata: {
      title: `Request #${i + 1}`,
      description: "Clinic equipment",
      tags: ["health"],
      media: [],
    },
    milestones: [],
    createdAt: new Date(Date.now() - i * 60_000),
    updatedAt: new Date(),
    _count: { milestones: 0, contributions: 4 },
  }));

  redis.incr = (async () => 1) as unknown as typeof redis.incr;
  redis.expire = (async () => 1) as unknown as typeof redis.expire;
  redis.ttl = (async () => 60) as unknown as typeof redis.ttl;
  redis.ping = (async () => "PONG") as unknown as typeof redis.ping;

  prisma.post.findMany = (async () => [...samplePosts]) as unknown as typeof prisma.post.findMany;
  prisma.post.create = (async (args: {
    data: { author: string; body: string; mediaHashes: string[] };
  }) => ({
    id: `post_new_${Date.now()}`,
    author: args.data.author,
    body: args.data.body,
    mediaHashes: args.data.mediaHashes,
    status: "VISIBLE",
    createdAt: new Date(),
  })) as unknown as typeof prisma.post.create;
  prisma.user.findUnique = (async ({ where }: { where: { address: string } }) => ({
    address: where.address,
    displayName: "Community Member",
    bio: null,
    avatarHash: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })) as unknown as typeof prisma.user.findUnique;
  prisma.user.upsert = (async ({ where }: { where: { address: string } }) => ({
    address: where.address,
  })) as unknown as typeof prisma.user.upsert;
  prisma.helpRequest.findMany = (async () => [
    ...sampleRequests,
  ]) as unknown as typeof prisma.helpRequest.findMany;
  prisma.reputationEvent.findFirst = (async () => ({
    newScore: 78,
  })) as unknown as typeof prisma.reputationEvent.findFirst;
  prisma.reputationEvent.findMany = (async () => [
    {
      id: "re_1",
      subject: ALICE,
      delta: 10,
      newScore: 78,
      refId: "1",
      ledger: 100n,
      createdAt: new Date(),
    },
  ]) as unknown as typeof prisma.reputationEvent.findMany;

  const app = await buildApp();
  await app.ready();
  const virtualUsers = Array.from({ length: 60 }, (_, idx) => {
    const kp = Keypair.random();
    return {
      address: kp.publicKey(),
      jwt: signToken(kp.publicKey(), config.jwtSecret, "1h"),
      ip: `10.42.${Math.floor(idx / 200)}.${(idx % 200) + 1}`,
    };
  });

  async function benchmarkRoute(
    label: string,
    totalRequests: number,
    concurrency: number,
    makeReq: (seq: number) => InjectOptions,
  ) {
    const latencies: number[] = [];
    let completed = 0;
    const startWall = performance.now();

    async function worker() {
      while (completed < totalRequests) {
        const seq = completed++;
        const t0 = performance.now();
        const res = await app.inject(makeReq(seq));
        if (res.statusCode >= 400) {
          throw new Error(`${label} returned unexpected HTTP ${res.statusCode}: ${res.body}`);
        }
        latencies.push(performance.now() - t0);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const elapsedSec = (performance.now() - startWall) / 1000;
    latencies.sort((a, b) => a - b);

    return {
      route: label,
      requests: latencies.length,
      concurrency,
      reqPerSec: Math.round(latencies.length / elapsedSec),
      p50Ms: Number(percentile(latencies, 50).toFixed(2)),
      p95Ms: Number(percentile(latencies, 95).toFixed(2)),
      p99Ms: Number(percentile(latencies, 99).toFixed(2)),
    };
  }

  const results = [];
  results.push(
    await benchmarkRoute("GET /feed", 500, 20, (seq) => ({
      method: "GET",
      url: "/feed?limit=20",
      remoteAddress: virtualUsers[seq % virtualUsers.length]!.ip,
    })),
  );
  results.push(
    await benchmarkRoute("GET /requests", 500, 20, (seq) => ({
      method: "GET",
      url: "/requests?limit=20",
      remoteAddress: virtualUsers[seq % virtualUsers.length]!.ip,
    })),
  );
  results.push(
    await benchmarkRoute("GET /reputation/:address", 500, 20, (seq) => ({
      method: "GET",
      url: `/reputation/${ALICE}`,
      remoteAddress: virtualUsers[seq % virtualUsers.length]!.ip,
    })),
  );
  results.push(
    await benchmarkRoute("POST /posts", 300, 10, (seq) => {
      const vu = virtualUsers[seq % virtualUsers.length]!;
      return {
        method: "POST",
        url: "/posts",
        remoteAddress: vu.ip,
        headers: { authorization: `Bearer ${vu.jwt}` },
        payload: { body: "Load-test community update #aid", mediaHashes: [] },
      };
    }),
  );

  // 1,000-event indexer replay benchmark
  const seen = new Set<string>();
  const mockTx = {
    processedEvent: {
      findUnique: async ({ where }: { where: { eventId: string } }) =>
        seen.has(where.eventId) ? { eventId: where.eventId } : null,
      create: async ({ data }: { data: { eventId: string } }) => {
        seen.add(data.eventId);
        return data;
      },
    },
    reputationEvent: {
      upsert: async ({ create }: { create: unknown }) => create,
    },
    indexerCursor: {
      upsert: async ({ create }: { create: unknown }) => create,
    },
  };

  const totalEvents = 1000;
  const t0 = performance.now();
  for (let i = 0; i < totalEvents; i++) {
    const eventId = `evt-bench-${i}`;
    const ledger = 600_000 + i;
    const existing = await mockTx.processedEvent.findUnique({ where: { eventId } });
    if (!existing) {
      await mockTx.processedEvent.create({ data: { eventId } });
      await handleReputationEvent(
        {
          type: "reputation.score_changed",
          subject: ALICE,
          delta: 5,
          newScore: 5 * (i + 1),
          refId: `req:${i}`,
        },
        mockTx as unknown as Parameters<typeof handleReputationEvent>[1],
        { eventId, ledger },
      );
      await mockTx.indexerCursor.upsert({
        create: { stream: "soroban:reputation", lastLedger: BigInt(ledger) },
      });
    }
  }
  const replayElapsedMs = performance.now() - t0;
  const indexerReplay = {
    events: totalEvents,
    elapsedMs: Number(replayElapsedMs.toFixed(1)),
    eventsPerSec: Math.round((totalEvents / replayElapsedMs) * 1000),
  };

  await app.close();
  console.log(JSON.stringify({ http: results, indexerReplay }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
