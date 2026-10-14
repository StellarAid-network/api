import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { prisma } from "../../src/lib/db";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("GET /healthz", () => {
  it("returns 200 with an ok status", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("echoes a caller supplied request id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "req-123" },
    });

    expect(response.headers["x-request-id"]).toBe("req-123");
  });
});

describe("unknown routes", () => {
  it("returns an RFC 7807 problem document", async () => {
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      title: "Not Found",
      status: 404,
      instance: "/does-not-exist",
    });
  });
});
