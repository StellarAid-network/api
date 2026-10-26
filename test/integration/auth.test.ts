/**
 * Integration tests for SEP-10 auth flow.
 *
 * Requires Docker (Postgres + Redis via Testcontainers).
 * Skipped automatically when Docker is unavailable.
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

/** Sign a challenge transaction with the given keypair and return XDR. */
function signChallenge(challengeXdr: string, signer: Keypair): string {
  const tx = new Transaction(challengeXdr, networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

suite("Auth routes (integration)", () => {
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

    const dbHost = postgres.getHost();
    const dbPort = postgres.getMappedPort(5432);
    const databaseUrl = `postgresql://stellaraid:stellaraid@${dbHost}:${dbPort}/stellaraid?schema=public`;
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;

    // Run migrations.
    execSync(`pnpm prisma migrate deploy`, {
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

  // ── challenge ──────────────────────────────────────────────────────────

  it("GET /auth/challenge returns a valid challenge XDR", async () => {
    const clientKp = Keypair.random();
    const res = await app!.inject({
      method: "GET",
      url: `/auth/challenge?account=${clientKp.publicKey()}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { transaction: string; network_passphrase: string };
    expect(typeof body.transaction).toBe("string");
    expect(body.transaction.length).toBeGreaterThan(10);
    expect(body.network_passphrase).toBe(networkPassphrase);

    // Transaction must parse.
    expect(() => new Transaction(body.transaction, networkPassphrase)).not.toThrow();
  });

  it("GET /auth/challenge rejects a missing account param", async () => {
    const res = await app!.inject({ method: "GET", url: "/auth/challenge" });
    expect(res.statusCode).toBe(400);
  });

  // ── token ──────────────────────────────────────────────────────────────

  it("POST /auth/token with a correctly signed challenge returns a JWT", async () => {
    const clientKp = Keypair.random();

    // 1. Get challenge.
    const challengeRes = await app!.inject({
      method: "GET",
      url: `/auth/challenge?account=${clientKp.publicKey()}`,
    });
    expect(challengeRes.statusCode).toBe(200);
    const { transaction: challengeXdr } = challengeRes.json() as { transaction: string };

    // 2. Sign the challenge with the client's key.
    const signedXdr = signChallenge(challengeXdr, clientKp);

    // 3. Exchange for JWT.
    const tokenRes = await app!.inject({
      method: "POST",
      url: "/auth/token",
      payload: { transaction: signedXdr },
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokenBody = tokenRes.json() as { token: string; address: string };
    expect(typeof tokenBody.token).toBe("string");
    expect(tokenBody.address).toBe(clientKp.publicKey());
  });

  it("POST /auth/token rejects a replayed (already-used) challenge", async () => {
    const clientKp = Keypair.random();

    const challengeRes = await app!.inject({
      method: "GET",
      url: `/auth/challenge?account=${clientKp.publicKey()}`,
    });
    const { transaction } = challengeRes.json() as { transaction: string };
    const signedXdr = signChallenge(transaction, clientKp);

    // First use: succeeds.
    const first = await app!.inject({
      method: "POST",
      url: "/auth/token",
      payload: { transaction: signedXdr },
    });
    expect(first.statusCode).toBe(200);

    // Second use (replay): must fail.
    const second = await app!.inject({
      method: "POST",
      url: "/auth/token",
      payload: { transaction: signedXdr },
    });
    expect(second.statusCode).toBe(401);
  });

  it("POST /auth/token with a forged signature returns 401", async () => {
    const clientKp = Keypair.random();
    const attackerKp = Keypair.random();

    const challengeRes = await app!.inject({
      method: "GET",
      url: `/auth/challenge?account=${clientKp.publicKey()}`,
    });
    const { transaction } = challengeRes.json() as { transaction: string };

    // Sign with attacker key instead of client key.
    const forgery = signChallenge(transaction, attackerKp);

    const res = await app!.inject({
      method: "POST",
      url: "/auth/token",
      payload: { transaction: forgery },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── /auth/me ───────────────────────────────────────────────────────────

  it("GET /auth/me returns the address when authenticated", async () => {
    const clientKp = Keypair.random();

    const challengeRes = await app!.inject({
      method: "GET",
      url: `/auth/challenge?account=${clientKp.publicKey()}`,
    });
    const { transaction } = challengeRes.json() as { transaction: string };
    const signed = signChallenge(transaction, clientKp);
    const tokenRes = await app!.inject({
      method: "POST",
      url: "/auth/token",
      payload: { transaction: signed },
    });
    const { token } = tokenRes.json() as { token: string };

    const meRes = await app!.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect((meRes.json() as { address: string }).address).toBe(clientKp.publicKey());
  });

  it("GET /auth/me returns 401 without a token", async () => {
    const res = await app!.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /auth/me returns 401 with a forged token", async () => {
    const res = await app!.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer invalid.token.here" },
    });
    expect(res.statusCode).toBe(401);
  });
});
