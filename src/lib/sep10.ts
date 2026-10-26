/**
 * SEP-10 Web Authentication implementation.
 *
 * The @stellar-aid/sdk/auth module is not yet released, so we implement
 * SEP-10 directly against @stellar/stellar-sdk.
 * TODO: replace with sdk/auth helpers once sdk 0.1.0-testnet is published.
 */

import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Operation,
  Account,
} from "@stellar/stellar-sdk";
import * as crypto from "node:crypto";

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
  networkPassphrase: string;
}

export interface VerifyChallengeResult {
  /** The client's Stellar address. */
  address: string;
}

/**
 * Build a SEP-10 challenge transaction (unsigned by client).
 *
 * The transaction has:
 * - source account = server account, sequence = 0
 * - time bounds = now ± validFor seconds
 * - manage_data op: key = "{homeDomain} auth", value = random 48-byte nonce (base64)
 */
export function buildChallenge(opts: ChallengeOptions): string {
  const validFor = opts.validFor ?? 900;
  const now = Math.floor(Date.now() / 1000);

  // Sequence 0 means the challenge transaction is not tied to the server's real sequence.
  const serverAccount = new Account(opts.serverKeypair.publicKey(), "-1");

  const nonce = crypto.randomBytes(48).toString("base64");

  const tx = new TransactionBuilder(serverAccount, {
    fee: "100",
    networkPassphrase: opts.networkPassphrase,
    timebounds: { minTime: now - 60, maxTime: now + validFor },
  })
    .addOperation(
      Operation.manageData({
        name: `${opts.homeDomain} auth`,
        value: nonce,
        source: opts.account,
      }),
    )
    .build();

  // Server signs the challenge.
  tx.sign(opts.serverKeypair);

  return tx.toXDR();
}

/**
 * Extract the nonce from a challenge XDR (for single-use enforcement).
 */
export function extractNonce(xdr: string, networkPassphrase: string): string {
  const tx = new Transaction(xdr, networkPassphrase);
  const op = tx.operations[0] as { value?: Buffer };
  return op?.value?.toString("base64") ?? "";
}

/**
 * Verify a signed SEP-10 challenge transaction and return the client address.
 *
 * Checks:
 * 1. Transaction can be parsed.
 * 2. Time bounds are valid (not expired).
 * 3. Server signature is present and valid.
 * 4. Client account (first non-server signer) has signed.
 */
export function verifyChallenge(opts: VerifyChallengeOptions): VerifyChallengeResult {
  const { signedXdr, serverKeypair, networkPassphrase } = opts;

  let tx: Transaction;
  try {
    tx = new Transaction(signedXdr, networkPassphrase);
  } catch (err) {
    throw new Error(`Failed to parse challenge XDR: ${String(err)}`);
  }

  // Check time bounds.
  const now = Math.floor(Date.now() / 1000);
  const { minTime, maxTime } = tx.timeBounds ?? {};
  if (!maxTime || now > Number(maxTime)) {
    throw new Error("Challenge has expired");
  }
  if (minTime && now < Number(minTime)) {
    throw new Error("Challenge is not yet valid");
  }

  // Find the manage_data operation to get the client account.
  const op = tx.operations[0] as { type: string; source?: string };
  if (op?.type !== "manageData") {
    throw new Error("Expected manage_data operation as first op");
  }
  const clientAddress = op.source;
  if (!clientAddress) {
    throw new Error("Challenge manage_data op must specify the client account as source");
  }

  // Verify server signature.
  const txHash = tx.hash();
  const serverPubKey = Keypair.fromPublicKey(serverKeypair.publicKey());

  let serverSigned = false;
  let clientSigned = false;

  for (const sig of tx.signatures) {
    const hint = sig.signature().slice(-4);
    const serverHint = Buffer.from(serverKeypair.rawPublicKey()).slice(-4);

    if (hint.equals(serverHint)) {
      try {
        if (serverPubKey.verify(txHash, sig.signature())) {
          serverSigned = true;
        }
      } catch {
        // not this key
      }
    }

    // Try client key.
    try {
      const clientKp = Keypair.fromPublicKey(clientAddress);
      if (clientKp.verify(txHash, sig.signature())) {
        clientSigned = true;
      }
    } catch {
      // not valid
    }
  }

  if (!serverSigned) {
    throw new Error("Server signature missing or invalid");
  }
  if (!clientSigned) {
    throw new Error("Client signature missing or invalid");
  }

  return { address: clientAddress };
}
