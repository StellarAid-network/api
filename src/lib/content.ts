/**
 * Content validation and output sanitation utilities.
 *
 * Input sanitation rule:
 * StellarAid stores text RAW in the database to preserve exact user intent, markdown formatting,
 * and cryptographic message digests. All text MUST be escaped or safely rendered in contexts
 * that interpret HTML to prevent cross-site scripting (XSS).
 */

import { z } from "zod";

/**
 * Regex for IPFS CIDv0 (base58 starting with Qm, 46 chars) and
 * CIDv1 (base32 starting with 'bafy', 'ba', etc.).
 */
export const IPFS_CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]{55,}|ba[a-z2-7]{57,})$/;

export function isValidIpfsCid(cid: string): boolean {
  return IPFS_CID_REGEX.test(cid);
}

export const IpfsCidSchema = z
  .string()
  .refine(isValidIpfsCid, { message: "Invalid IPFS CID format" });

export const PostBodySchema = z
  .string()
  .min(1, "Post body cannot be empty")
  .max(2000, "Post body cannot exceed 2000 characters");

export const CommentBodySchema = z
  .string()
  .min(1, "Comment body cannot be empty")
  .max(500, "Comment body cannot exceed 500 characters");

export const MediaHashesSchema = z
  .array(IpfsCidSchema)
  .max(4, "Cannot attach more than 4 media files")
  .default([]);

/**
 * Escapes unsafe HTML characters on output.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Validates that an account meets the minimum age requirement before creating social content.
 */
export function isAccountOldEnough(
  createdAt: Date | undefined | null,
  minAgeSeconds: number,
): boolean {
  if (minAgeSeconds <= 0) return true;
  if (!createdAt) return false;
  const ageSeconds = (Date.now() - createdAt.getTime()) / 1000;
  return ageSeconds >= minAgeSeconds;
}
