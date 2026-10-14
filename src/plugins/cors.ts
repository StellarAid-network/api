import cors from "@fastify/cors";
import fp from "fastify-plugin";
import { config } from "../config";

export const corsPlugin = fp(
  async (app) => {
    await app.register(cors, {
      origin: config.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    });
  },
  { name: "cors" },
);
