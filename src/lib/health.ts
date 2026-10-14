import type { FastifyInstance } from "fastify";
import { prisma } from "./db";
import { redis } from "./redis";

interface ReadinessChecks {
  database: boolean;
  redis: boolean;
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
                },
                required: ["database", "redis"],
              },
            },
            required: ["status", "checks"],
          },
          503: { type: "object", additionalProperties: true },
        },
      },
    },
    async (_request, reply) => {
      const checks: ReadinessChecks = { database: false, redis: false };

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

      const ready = checks.database && checks.redis;
      reply.code(ready ? 200 : 503);
      return { status: ready ? "ready" : "not_ready", checks };
    },
  );
}
