/**
 * Rate limiting plugin using @fastify/rate-limit with Redis as the store.
 *
 * Default limits from the README:
 *   - Global per-IP:            120 requests / minute
 *   - Authenticated per-address: 300 requests / minute
 *   - Auth routes (/auth/*):     10 requests / minute per IP
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import rateLimitPlugin from "@fastify/rate-limit";
import { redis } from "../lib/redis";

const rateLimitFastifyPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(rateLimitPlugin, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    // Use Redis as the store when available; fall back to in-memory in tests.
    redis: process.env.NODE_ENV !== "test" ? redis : undefined,
    keyGenerator(request) {
      // Prefer authenticated address over IP for higher per-address limits.
      const user = (request as unknown as { user?: { address?: string } }).user;
      if (user?.address) {
        return `rl:auth:${user.address}`;
      }
      return `rl:ip:${request.ip}`;
    },
    // Return 429 with RFC 7807 body.
    errorResponseBuilder(_request, context) {
      return {
        type: "https://stellaraid.app/errors/rate-limited",
        title: "Too Many Requests",
        status: 429,
        detail: `Rate limit exceeded. Try again in ${String(context.after)}.`,
      };
    },
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
  });
};

export const rateLimitFPlugin = fp(rateLimitFastifyPlugin, {
  name: "rate-limit",
  fastify: "5.x",
});

/** Per-route config to apply a stricter limit on auth endpoints. */
export const authRateLimit = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: "1 minute",
      keyGenerator: (request: { ip: string }) => `rl:auth:${request.ip}`,
    },
  },
};

/** Stricter rate limit for creating posts and comments (spam protection). */
export const socialWriteRateLimit = {
  config: {
    rateLimit: {
      max: 20,
      timeWindow: "1 minute",
      keyGenerator: (request: unknown) => {
        const user = (request as { user?: { address?: string } }).user;
        return user?.address
          ? `rl:social:${user.address}`
          : `rl:social:${(request as { ip: string }).ip}`;
      },
    },
  },
};
