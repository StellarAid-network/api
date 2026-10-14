import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const suite = dockerAvailable ? describe : describe.skip;

suite("GET /readyz (integration)", () => {
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

  it("reports ready once Postgres and Redis are reachable", async () => {
    const response = await app!.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: { database: true, redis: true },
    });
  });
});
