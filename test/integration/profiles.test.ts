/**
 * Integration tests for profile routes.
 *
 * Requires Docker (Postgres + Redis via Testcontainers).
 */

import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Keypair, Transaction } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const suite = dockerAvailable ? describe : describe.skip;

const networkPassphrase = "Test SDF Network ; September 2015";

async function getJwt(app: FastifyInstance, kp: Keypair): Promise<string> {
  const cr = await app.inject({
    method: "GET",
    url: `/auth/challenge?account=${kp.publicKey()}`,
  });
  const { transaction } = cr.json() as { transaction: string };
  const tx = new Transaction(transaction, networkPassphrase);
  tx.sign(kp);
  const tr = await app.inject({
    method: "POST",
    url: "/auth/token",
    payload: { transaction: tx.toXDR() },
  });
  return (tr.json() as { token: string }).token;
}

suite("Profile routes (integration)", () => {
  let postgres: StartedTestContainer | undefined;
  let redisContainer: StartedTestContainer | undefined;
  let app: FastifyInstance | undefined;
  let disconnect: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    postgres = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "stellaraid",
        POSTGRES_PASSWORD: "stellaraid",
        POSTGRES_DB: "stellaraid",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    redisContainer = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/, 1))
      .start();

    const databaseUrl =
      `postgresql://stellaraid:stellaraid@${postgres.getHost()}:` +
      `${postgres.getMappedPort(5432)}/stellaraid?schema=public`;
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;

    execSync("pnpm prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore",
    });

    const [{ buildApp }, { prisma }] = await Promise.all([
      import("../../src/app"),
      import("../../src/lib/db"),
    ]);

    disconnect = () => prisma.$disconnect();
    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await disconnect?.();
    await postgres?.stop();
    await redisContainer?.stop();
  });

  it("GET /profiles/:address returns defaults for an unknown address", async () => {
    const kp = Keypair.random();
    const res = await app!.inject({
      method: "GET",
      url: `/profiles/${kp.publicKey()}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { address: string; displayName: null; followerCount: number };
    expect(body.address).toBe(kp.publicKey());
    expect(body.displayName).toBeNull();
    expect(body.followerCount).toBe(0);
  });

  it("PUT /profiles/me requires auth", async () => {
    const res = await app!.inject({
      method: "PUT",
      url: "/profiles/me",
      payload: { displayName: "Alice" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("PUT /profiles/me creates and updates the profile", async () => {
    const kp = Keypair.random();
    const token = await getJwt(app!, kp);

    const res = await app!.inject({
      method: "PUT",
      url: "/profiles/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Alice", bio: "Mutual aid advocate" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { displayName: string; bio: string };
    expect(body.displayName).toBe("Alice");
    expect(body.bio).toBe("Mutual aid advocate");

    // Re-fetch via GET to confirm persistence.
    const getRes = await app!.inject({
      method: "GET",
      url: `/profiles/${kp.publicKey()}`,
    });
    expect((getRes.json() as { displayName: string }).displayName).toBe("Alice");
  });

  it("PUT /profiles/me rejects displayName longer than 50 chars", async () => {
    const kp = Keypair.random();
    const token = await getJwt(app!, kp);

    const res = await app!.inject({
      method: "PUT",
      url: "/profiles/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "A".repeat(51) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /profiles/:address/follow toggles follow state", async () => {
    const alice = Keypair.random();
    const bob = Keypair.random();
    const aliceToken = await getJwt(app!, alice);

    // Follow Bob.
    const follow = await app!.inject({
      method: "POST",
      url: `/profiles/${bob.publicKey()}/follow`,
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(follow.statusCode).toBe(200);
    expect((follow.json() as { following: boolean }).following).toBe(true);

    // Check Alice's profile shows followingCount = 1.
    const aliceProfile = await app!.inject({
      method: "GET",
      url: `/profiles/${alice.publicKey()}`,
    });
    expect((aliceProfile.json() as { followingCount: number }).followingCount).toBe(1);

    // Unfollow.
    const unfollow = await app!.inject({
      method: "POST",
      url: `/profiles/${bob.publicKey()}/follow`,
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect((unfollow.json() as { following: boolean }).following).toBe(false);
  });

  it("POST /profiles/:address/follow prevents self-follow", async () => {
    const kp = Keypair.random();
    const token = await getJwt(app!, kp);

    const res = await app!.inject({
      method: "POST",
      url: `/profiles/${kp.publicKey()}/follow`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
