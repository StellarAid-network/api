import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { config } from "./config";
import { logger } from "./lib/logger";
import { healthRoutes } from "./lib/health";
import { requestIdPlugin } from "./plugins/request-id";
import { errorHandlerPlugin } from "./plugins/error-handler";
import { corsPlugin } from "./plugins/cors";
import { helmetPlugin } from "./plugins/helmet";
import { swaggerPlugin } from "./plugins/swagger";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestIdHeader: "x-request-id",
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      return typeof header === "string" && header.length > 0 ? header : randomUUID();
    },
  });

  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(helmetPlugin);
  await app.register(corsPlugin);
  await app.register(swaggerPlugin);

  await healthRoutes(app);

  app.get("/", { schema: { hide: true } }, async () => ({
    name: "stellaraid-api",
    network: config.stellarNetwork,
    docs: "/docs",
    spec: "/openapi.json",
  }));

  return app;
}
