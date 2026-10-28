/**
 * Media upload route.
 *
 * POST /uploads – validates image MIME type, size limit (<= 5 MB), magic-byte
 * content sniffing, pins to IPFS (or computes a deterministic CIDv1 hash when
 * running in local/test mode), and returns the IPFS CID and SHA-256 hex digest.
 */

import * as crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/auth";
import { socialWriteRateLimit } from "../../plugins/rate-limit";
import { config } from "../../config";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const UploadBodySchema = z.object({
  filename: z.string().trim().min(1).max(255).optional().default("upload.bin"),
  mimeType: z.string().trim().min(1),
  dataBase64: z.string().min(1),
});

/**
 * Inspect magic bytes of buffer to verify actual image format matches declared MIME type.
 */
export function sniffImageMagicBytes(buf: Buffer): string | null {
  if (buf.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return "image/gif";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function toBase32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Compute a deterministic CIDv1 (raw codec 0x55, sha2-256 0x12, 32 bytes 0x20) in base32 (`bafkrei...`).
 */
export function computeDeterministicCidV1(buf: Buffer): { cid: string; sha256Hex: string } {
  const digest = crypto.createHash("sha256").update(buf).digest();
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const cid = `b${toBase32Lower(cidBytes)}`;
  return { cid, sha256Hex: digest.toString("hex") };
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/uploads",
    {
      ...socialWriteRateLimit,
      bodyLimit: 8 * 1024 * 1024, // allow base64 overhead up to 8 MB
      schema: {
        tags: ["utility"],
        summary: "Upload media and pin to IPFS",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["mimeType", "dataBase64"],
          properties: {
            filename: { type: "string" },
            mimeType: { type: "string" },
            dataBase64: { type: "string" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              hash: { type: "string" },
              cid: { type: "string" },
              sha256: { type: "string" },
              mimeType: { type: "string" },
              size: { type: "integer" },
            },
          },
          400: { type: "object", additionalProperties: true },
          401: { type: "object", additionalProperties: true },
          413: { type: "object", additionalProperties: true },
          415: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      requireAuth(request, reply);

      const parsed = UploadBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: parsed.error.issues[0]?.message ?? "Invalid upload payload",
        });
      }

      const { mimeType, dataBase64 } = parsed.data;
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        return reply.code(415).send({
          type: "https://stellaraid.app/errors/unsupported-media-type",
          title: "Unsupported Media Type",
          status: 415,
          detail: `Unsupported MIME type: ${mimeType}. Allowed: image/jpeg, image/png, image/webp, image/gif`,
        });
      }

      const cleanBase64 = dataBase64.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(cleanBase64, "base64");

      if (buffer.length === 0) {
        return reply.code(400).send({
          type: "https://stellaraid.app/errors/bad-request",
          title: "Bad Request",
          status: 400,
          detail: "Empty upload payload",
        });
      }

      if (buffer.length > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({
          type: "https://stellaraid.app/errors/payload-too-large",
          title: "Payload Too Large",
          status: 413,
          detail: `File size (${buffer.length} bytes) exceeds 5 MB limit`,
        });
      }

      const sniffedMime = sniffImageMagicBytes(buffer);
      if (!sniffedMime || sniffedMime !== mimeType) {
        return reply.code(415).send({
          type: "https://stellaraid.app/errors/unsupported-media-type",
          title: "Unsupported Media Type",
          status: 415,
          detail: `File content magic bytes (${sniffedMime ?? "unknown"}) do not match declared MIME type (${mimeType})`,
        });
      }

      const { cid, sha256Hex } = computeDeterministicCidV1(buffer);

      // If a real Pinata JWT is configured in production, attempt remote pinning with fallback
      if (
        config.nodeEnv === "production" &&
        config.ipfsPinningJwt &&
        !config.ipfsPinningJwt.includes("placeholder")
      ) {
        try {
          const form = new FormData();
          form.append("file", new Blob([buffer], { type: mimeType }), parsed.data.filename);
          const pinRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
            method: "POST",
            headers: { Authorization: `Bearer ${config.ipfsPinningJwt}` },
            body: form,
          });
          if (pinRes.ok) {
            const json = (await pinRes.json()) as { IpfsHash?: string };
            if (json.IpfsHash) {
              return reply.code(201).send({
                hash: json.IpfsHash,
                cid: json.IpfsHash,
                sha256: sha256Hex,
                mimeType,
                size: buffer.length,
              });
            }
          }
        } catch {
          // Fall back to deterministic CIDv1 hash
        }
      }

      return reply.code(201).send({
        hash: cid,
        cid,
        sha256: sha256Hex,
        mimeType,
        size: buffer.length,
      });
    },
  );
}
