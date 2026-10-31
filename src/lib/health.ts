import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "./db";
import { redis } from "./redis";
import { sendProblem } from "./problem";
import {
  isIndexerLagAcceptable,
  getIndexerMetrics,
  formatPrometheusMetrics,
  recordHttpRequest,
  setDbPoolActive,
} from "../indexer/metrics";

interface ReadinessChecks {
  database: boolean;
  redis: boolean;
  indexer: boolean;
}

export function isInternalIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/, "").trim();
  if (normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost") {
    return true;
  }
  // RFC 1918 private ranges + IPv6 ULA (fc00::/7)
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;
  return false;
}

export function isInternalMetricsRequest(request: FastifyRequest): boolean {
  const configuredToken = process.env["METRICS_INTERNAL_TOKEN"];
  const providedToken = request.headers["x-internal-token"];
  if (
    configuredToken &&
    configuredToken.length > 0 &&
    typeof providedToken === "string" &&
    providedToken === configuredToken
  ) {
    return true;
  }

  // If a reverse proxy sets x-forwarded-for, every hop must be internal.
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    const hops = forwarded.split(",").map((h) => h.trim());
    return hops.every((hop) => isInternalIp(hop));
  }

  return isInternalIp(request.ip) && isInternalIp(request.socket?.remoteAddress);
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onResponse", async (_request, reply) => {
    recordHttpRequest(reply.elapsedTime);
  });

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
        setDbPoolActive(1);
      } catch (error) {
        setDbPoolActive(0);
        app.log.warn({ err: error }, "readiness: database check failed");
      }

      try {
        const pong = await redis.ping();
        checks.redis = pong === "PONG";
      } catch (error) {
        app.log.warn({ err: error }, "readiness: redis check failed");
      }

      const indexerOk = isIndexerLagAcceptable();
      checks.indexer = indexerOk;
      if (!indexerOk) {
        app.log.warn({ metrics: getIndexerMetrics() }, "readiness: indexer lag exceeds threshold");
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
        summary: "Prometheus metrics (internal only)",
        hide: true,
      },
    },
    async (request, reply) => {
      if (!isInternalMetricsRequest(request)) {
        return sendProblem(reply, {
          type: "https://stellaraid.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Metrics endpoint is restricted to internal network callers.",
          instance: request.url,
          requestId: request.id,
        });
      }
      reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return formatPrometheusMetrics();
    },
  );
}
