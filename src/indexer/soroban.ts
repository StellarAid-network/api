/**
 * Soroban RPC event fetcher for contract event indexing.
 */

import { config } from "../config";
import { logger } from "../lib/logger";

export interface RawSorobanEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];
  value: string | { xdr?: string } | Record<string, unknown>;
  inSuccessfulContractCall: boolean;
}

export interface GetEventsResult {
  latestLedger: number;
  events: RawSorobanEvent[];
  cursor?: string;
}

export async function fetchSorobanEvents(
  contractId: string,
  startLedger: number,
  limit: number = 100,
): Promise<GetEventsResult> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getEvents",
    params: {
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contractId],
        },
      ],
      pagination: {
        limit,
      },
    },
  };

  try {
    const res = await fetch(config.sorobanRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Soroban RPC HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as {
      result?: {
        latestLedger: number;
        events: RawSorobanEvent[];
        cursor?: string;
      };
      error?: { code: number; message: string };
    };

    if (data.error) {
      throw new Error(`Soroban RPC error (${data.error.code}): ${data.error.message}`);
    }

    const result = data.result || { latestLedger: startLedger, events: [] };
    return {
      latestLedger: result.latestLedger ?? startLedger,
      events: result.events ?? [],
      cursor: result.cursor,
    };
  } catch (err) {
    logger.error({ err, contractId, startLedger }, "failed to fetch Soroban events");
    return {
      latestLedger: startLedger,
      events: [],
    };
  }
}
