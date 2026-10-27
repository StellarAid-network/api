import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { prisma } from "../../src/lib/db";
import {
  recordProcessedEvents,
  updateLatestLedger,
  updateLastIndexedLedger,
  resetIndexerMetricsForTesting,
  isIndexerLagAcceptable,
  getIndexerMetrics,
} from "../../src/indexer/metrics";

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

describe("GET /metrics", () => {
  it("exposes Prometheus formatted metrics", async () => {
    recordProcessedEvents(5);
    updateLatestLedger(100);
    updateLastIndexedLedger(98);

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("indexer_lag_ledgers 2");
    expect(response.body).toContain("events_processed_total 5");
    expect(response.body).toContain("latest_ledger 100");
    expect(response.body).toContain("last_indexed_ledger 98");
  });
});

describe("Indexer lag checks", () => {
  it("computes lag and reports acceptable if within threshold", () => {
    resetIndexerMetricsForTesting();
    updateLatestLedger(1000);
    updateLastIndexedLedger(900); // lag = 100 <= 500

    expect(getIndexerMetrics().indexer_lag_ledgers).toBe(100);
    expect(isIndexerLagAcceptable(500)).toBe(true);
  });

  it("detects when lag exceeds threshold", () => {
    resetIndexerMetricsForTesting();
    updateLatestLedger(2000);
    updateLastIndexedLedger(1000); // lag = 1000 > 500

    expect(getIndexerMetrics().indexer_lag_ledgers).toBe(1000);
    expect(isIndexerLagAcceptable(500)).toBe(false);
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
