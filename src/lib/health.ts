import type { FastifyInstance } from "fastify";
import { prisma } from "./db";
import { redis } from "./redis";
import {
  isIndexerLagAcceptable,
  getIndexerMetrics,
  formatPrometheusMetrics,
} from "../indexer/metrics";

interface ReadinessChecks {
  database: boolean;
  redis: boolean;
  indexer: boolean;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/healthz",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness probe",
        response: {
          200: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
          },
        },
      },
    },
    async () => ({ status: "ok" }),
  );

  app.get(
    "/readyz",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness probe",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              checks: {
                type: "object",
                properties: {
                  database: { type: "boolean" },
                  redis: { type: "boolean" },
                  indexer: { type: "boolean" },
                },
                required: ["database", "redis", "indexer"],
              },
              metrics: {
                type: "object",
                properties: {
                  indexer_lag_ledgers: { type: "number" },
                  events_processed_total: { type: "number" },
                },
              },
            },
            required: ["status", "checks"],
          },
          503: { type: "object", additionalProperties: true },
        },
      },
    },
    async (_request, reply) => {
      const checks: ReadinessChecks = {
        database: false,
        redis: false,
        indexer: true,
      };

      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database = true;
      } catch (error) {
        app.log.warn({ err: error }, "readiness: database check failed");
      }

      try {
        const pong = await redis.ping();
        checks.redis = pong === "PONG";
      } catch (error) {
        app.log.warn({ err: error }, "readiness: redis check failed");
      }

      // Check indexer lag
      const indexerOk = isIndexerLagAcceptable();
      checks.indexer = indexerOk;
      if (!indexerOk) {
        app.log.warn(
          { metrics: getIndexerMetrics() },
          "readiness: indexer lag exceeds threshold",
        );
      }

      const ready = checks.database && checks.redis && checks.indexer;
      reply.code(ready ? 200 : 503);
      return {
        status: ready ? "ready" : "not_ready",
        checks,
        metrics: getIndexerMetrics(),
      };
    },
  );

  app.get(
    "/metrics",
    {
      schema: {
        tags: ["health"],
        summary: "Prometheus metrics",
      },
    },
    async (_request, reply) => {
      reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return formatPrometheusMetrics();
    },
  );
}
