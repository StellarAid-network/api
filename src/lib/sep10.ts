/**
 * SEP-10 Web Authentication adapter delegating to `@stellar-aid/sdk/auth` (`0.1.0-testnet`).
 */

import type { Keypair } from "@stellar/stellar-sdk";
import {
  createChallenge as sdkCreateChallenge,
  extractNonce as sdkExtractNonce,
  verifyChallenge as sdkVerifyChallenge,
} from "@stellar-aid/sdk/auth";

export interface ChallengeOptions {
  account: string;
  serverKeypair: Keypair;
  homeDomain: string;
  webAuthDomain?: string;
  networkPassphrase: string;
  /** Challenge validity window in seconds (default: 900 = 15 min). */
  validFor?: number;
}

export interface VerifyChallengeOptions {
  signedXdr: string;
  serverKeypair: Keypair;
  homeDomain: string;
  webAuthDomain?: string;
  networkPassphrase: string;
}

export interface VerifyChallengeResult {
  /** The client's verified Stellar address. */
  address: string;
}

/**
 * Build a server-signed SEP-10 challenge transaction via `@stellar-aid/sdk/auth`.
 */
export function buildChallenge(opts: ChallengeOptions): string {
  return sdkCreateChallenge({
    account: opts.account,
    serverKey: opts.serverKeypair,
    homeDomain: opts.homeDomain,
    ...(opts.webAuthDomain ? { webAuthDomain: opts.webAuthDomain } : {}),
    networkPassphrase: opts.networkPassphrase,
    ...(opts.validFor !== undefined ? { validFor: opts.validFor } : {}),
  });
}

/**
 * Extract the 48-byte random SEP-10 challenge nonce (base64) for single-use enforcement.
 */
export function extractNonce(xdr: string, networkPassphrase: string): string {
  return sdkExtractNonce(xdr, networkPassphrase);
}

/**
 * Verify a client-signed SEP-10 challenge transaction via `@stellar-aid/sdk/auth`.
 */
export function verifyChallenge(opts: VerifyChallengeOptions): VerifyChallengeResult {
  const result = sdkVerifyChallenge({
    signedXdr: opts.signedXdr,
    serverKey: opts.serverKeypair,
    homeDomain: opts.homeDomain,
    ...(opts.webAuthDomain ? { webAuthDomain: opts.webAuthDomain } : {}),
    networkPassphrase: opts.networkPassphrase,
  });
  return { address: result.address };
}
