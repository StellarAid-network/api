/**
 * Auth plugin: decorates every request with `request.user`.
 *
 * - If `Authorization: Bearer <token>` is present and valid, sets request.user.
 * - If the token is missing or invalid, sets request.user to null (optional auth).
 * - Use `requireAuth(request, reply)` in route handlers to enforce authentication.
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { verifyToken } from "../lib/jwt";
import { config } from "../config";

export interface RequestUser {
  address: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: RequestUser | null;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("user", null);

  fastify.addHook("preHandler", async (request: FastifyRequest) => {
    const authHeader = request.headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      request.user = null;
      return;
    }
    const token = authHeader.slice(7);
    try {
      const payload = verifyToken(token, config.jwtSecret);
      if (typeof payload.sub !== "string") {
        request.user = null;
        return;
      }
      request.user = { address: payload.sub };
    } catch {
      request.user = null;
    }
  });
};

export const authFastifyPlugin = fp(authPlugin, {
  name: "auth",
  fastify: "5.x",
});

/**
 * Assert that the request is authenticated; throws 401 otherwise.
 * Call at the start of any route handler that requires a signed-in user.
 */
export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): asserts request is FastifyRequest & { user: RequestUser } {
  if (!request.user) {
    void reply.code(401).send({
      type: "https://stellaraid.app/errors/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required. Please sign in with your Stellar wallet.",
    });
    throw new Error("Unauthorized"); // stops handler execution
  }
}
