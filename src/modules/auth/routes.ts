/**
 * SEP-10 authentication routes.
 *
 * GET  /auth/challenge  – issue a challenge transaction
 * POST /auth/token      – verify a signed challenge and issue a JWT
 * GET  /auth/me         – return current session info (requires JWT)
 */

import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { config } from "../../config";
import { buildChallenge, extractNonce, verifyChallenge } from "../../lib/sep10";
import { signToken } from "../../lib/jwt";
import { redis } from "../../lib/redis";
import { requireAuth } from "../../plugins/auth";

const CHALLENGE_TTL_SECONDS = 900; // 15 minutes

function challengeKey(nonce: string): string {
  return `sep10:challenge:${nonce}`;
}

const networkPassphrase: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  local: "Standalone Network ; February 2017",
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const serverKeypair = Keypair.fromSecret(config.sep10SigningSecret);
  const passphrase = networkPassphrase[config.stellarNetwork] ?? networkPassphrase["testnet"]!;

  // -------------------------------------------------------------------------
  // GET /auth/challenge
  // -------------------------------------------------------------------------
  app.get(
    "/auth/challenge",
    {
      schema: {
        tags: ["auth"],
        summary: "Issue a SEP-10 challenge transaction",
        querystring: {
          type: "object",
          required: ["account"],
          properties: {
            account: { type: "string", description: "Stellar account address (G...)" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              transaction: { type: "string", description: "Unsigned challenge XDR" },
              network_passphrase: { type: "string" },
            },
            required: ["transaction", "network_passphrase"],
          },
          400: { type: "object", additionalProperties: true },
          429: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { account } = request.query as { account: string };

      if (!account || !/^G[A-Z2-7]{55}$/i.test(account) || account.length !== 56) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "Invalid Stellar account address",
        });
      }

      const xdr = buildChallenge({
        account,
        serverKeypair,
        homeDomain: config.sep10HomeDomain,
        webAuthDomain: config.sep10WebAuthDomain,
        networkPassphrase: passphrase,
      });

      // Store nonce in Redis for single-use enforcement.
      const nonce = extractNonce(xdr, passphrase);
      await redis.set(challengeKey(nonce), "1", "EX", CHALLENGE_TTL_SECONDS);

      return reply.send({ transaction: xdr, network_passphrase: passphrase });
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/token
  // -------------------------------------------------------------------------
  app.post(
    "/auth/token",
    {
      schema: {
        tags: ["auth"],
        summary: "Exchange a signed SEP-10 challenge for a JWT",
        body: {
          type: "object",
          required: ["transaction"],
          properties: {
            transaction: { type: "string", description: "Signed challenge XDR" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              address: { type: "string" },
            },
            required: ["token", "address"],
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
          429: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { transaction: string };

      if (!body.transaction) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "transaction field is required",
        });
      }

      // Verify challenge and extract client address.
      let address: string;
      try {
        const result = verifyChallenge({
          signedXdr: body.transaction,
          serverKeypair,
          homeDomain: config.sep10HomeDomain,
          networkPassphrase: passphrase,
        });
        address = result.address;
      } catch (err: unknown) {
        return reply.code(401).send({
          type: "https://stellaraid.app/errors/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: String(err instanceof Error ? err.message : err),
        });
      }

      // Enforce single-use: nonce must exist in Redis.
      const nonce = extractNonce(body.transaction, passphrase);
      const key = challengeKey(nonce);
      const exists = await redis.getdel(key);
      if (!exists) {
        return reply.code(401).send({
          type: "https://stellaraid.app/errors/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "Challenge has already been used or has expired",
        });
      }

      const token = signToken(address, config.jwtSecret, config.jwtExpiresIn);
      return reply.send({ token, address });
    },
  );

  // -------------------------------------------------------------------------
  // GET /auth/me
  // -------------------------------------------------------------------------
  app.get(
    "/auth/me",
    {
      schema: {
        tags: ["auth"],
        summary: "Return current session info",
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              address: { type: "string" },
            },
            required: ["address"],
          },
          401: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);
      return reply.send({ address: request.user.address });
    },
  );
}
