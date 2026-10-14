import helmet, { type FastifyHelmetOptions } from "@fastify/helmet";
import fp from "fastify-plugin";
import { config } from "../config";

export const helmetPlugin = fp(
  async (app) => {
    const options: FastifyHelmetOptions = {
      crossOriginResourcePolicy: { policy: "cross-origin" },
    };
    if (config.nodeEnv !== "production") {
      options.contentSecurityPolicy = false;
    }
    await app.register(helmet, options);
  },
  { name: "helmet" },
);
