/**
 * Integration tests for social backend routes (posts, comments, feed).
 *
 * Automatically skips when Docker is not available.
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

suite("Social backend routes (integration)", () => {
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

    process.env["DATABASE_URL"] = databaseUrl;
    process.env["REDIS_URL"] = redisUrl;
    process.env["STELLAR_NETWORK"] = "testnet";
    process.env["SOROBAN_RPC_URL"] = "https://soroban-testnet.stellar.org";
    process.env["HORIZON_URL"] = "https://horizon-testnet.stellar.org";
    process.env["SEP10_SIGNING_SECRET"] = Keypair.random().secret();
    process.env["SEP10_HOME_DOMAIN"] = "stellaraid.app";
    process.env["JWT_SECRET"] = "integration-test-secret-at-least-32-chars-long";
    process.env["CORS_ORIGINS"] = "http://localhost:3000";

    execSync("pnpm prisma db push --skip-generate", {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore",
    });

    const { disconnect: dc } = await import("../../src/lib/db");
    disconnect = dc;

    const { buildApp } = await import("../../src/app");
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await disconnect?.();
    await postgres?.stop();
    await redisContainer?.stop();
  });

  it("creates, reads, and deletes posts with proper authorization", async () => {
    if (!app) return;

    const user1 = Keypair.random();
    const token1 = await getJwt(app, user1);

    const user2 = Keypair.random();
    const token2 = await getJwt(app, user2);

    // Create post as user1
    const createRes = await app.inject({
      method: "POST",
      url: "/posts",
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        body: "First test post on StellarAid #giveaway",
        mediaHashes: ["QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const post = createRes.json() as { id: string; author: string; body: string };
    expect(post.author).toBe(user1.publicKey());

    // Get post publicly
    const getRes = await app.inject({
      method: "GET",
      url: `/posts/${post.id}`,
    });
    expect(getRes.statusCode).toBe(200);

    // user2 tries to delete user1's post -> 403 Forbidden
    const unauthDelete = await app.inject({
      method: "DELETE",
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(unauthDelete.statusCode).toBe(403);

    // user1 deletes their own post -> 200 OK
    const authDelete = await app.inject({
      method: "DELETE",
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(authDelete.statusCode).toBe(200);

    // Now public GET returns 404
    const deletedGet = await app.inject({
      method: "GET",
      url: `/posts/${post.id}`,
    });
    expect(deletedGet.statusCode).toBe(404);
  });

  it("creates and retrieves comments on a post", async () => {
    if (!app) return;

    const author = Keypair.random();
    const authorToken = await getJwt(app, author);

    const commenter = Keypair.random();
    const commenterToken = await getJwt(app, commenter);

    // Create post
    const postRes = await app.inject({
      method: "POST",
      url: "/posts",
      headers: { authorization: `Bearer ${authorToken}` },
      payload: { body: "Post for comments test" },
    });
    const { id: postId } = postRes.json() as { id: string };

    // Add comment as commenter
    const commentRes = await app.inject({
      method: "POST",
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${commenterToken}` },
      payload: { body: "Awesome initiative!" },
    });
    expect(commentRes.statusCode).toBe(201);

    // Read comments
    const listRes = await app.inject({
      method: "GET",
      url: `/posts/${postId}/comments`,
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json() as { comments: Array<{ body: string }> };
    expect(body.comments.length).toBe(1);
    expect(body.comments[0]?.body).toBe("Awesome initiative!");
  });

  it("lists posts in feed with tag and pagination support", async () => {
    if (!app) return;

    const user = Keypair.random();
    const token = await getJwt(app, user);

    await app.inject({
      method: "POST",
      url: "/posts",
      headers: { authorization: `Bearer ${token}` },
      payload: { body: "Tag search test #relief" },
    });

    const feedRes = await app.inject({
      method: "GET",
      url: "/feed?scope=global&tag=relief",
    });
    expect(feedRes.statusCode).toBe(200);
    const feed = feedRes.json() as { posts: Array<{ body: string }> };
    expect(feed.posts.some((p) => p.body.includes("#relief"))).toBe(true);
  });
});
