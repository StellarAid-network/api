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
import { authFastifyPlugin } from "./plugins/auth";
import { rateLimitFPlugin } from "./plugins/rate-limit";
import { authRoutes } from "./modules/auth/routes";
import { profileRoutes } from "./modules/profiles/routes";
import { postRoutes } from "./modules/posts/routes";
import { commentRoutes } from "./modules/comments/routes";
import { feedRoutes } from "./modules/feed/routes";

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
  await app.register(rateLimitFPlugin);
  await app.register(authFastifyPlugin);

  await healthRoutes(app);

  await app.register(
    async (sub) => {
      await authRoutes(sub);
      await profileRoutes(sub);
      await postRoutes(sub);
      await commentRoutes(sub);
      await feedRoutes(sub);
    },
    { prefix: "/" },
  );

  app.get("/", { schema: { hide: true } }, async () => ({
    name: "stellaraid-api",
    network: config.stellarNetwork,
    docs: "/docs",
    spec: "/openapi.json",
  }));

  return app;
}
