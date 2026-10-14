import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fp from "fastify-plugin";
import { config } from "../config";

export const swaggerPlugin = fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "StellarAid API",
          description:
            "Backend for StellarAid: social feed, SEP-10 auth, indexed on-chain " +
            "help requests, contributions, giveaways, reputation, and attestations.",
          version: "0.1.0",
        },
        servers: [{ url: `http://localhost:${config.port}` }],
        tags: [{ name: "health", description: "Liveness and readiness probes" }],
      },
    });

    app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

    await app.register(swaggerUi, {
      routePrefix: "/docs",
      staticCSP: true,
    });
  },
  { name: "swagger" },
);
