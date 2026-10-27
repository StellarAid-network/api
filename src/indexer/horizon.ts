/**
 * Horizon fetcher for claimable balance giveaway indexing.
 */

import { config } from "../config";
import { logger } from "../lib/logger";

export interface HorizonClaimableBalance {
  id: string;
  asset: string;
  amount: string;
  sponsor?: string;
  last_modified_ledger: number;
  last_modified_time: string;
  claimants: Array<{
    destination: string;
    predicate: Record<string, unknown>;
  }>;
  paging_token: string;
}

export interface HorizonBalancesResult {
  records: HorizonClaimableBalance[];
  nextCursor?: string;
}

export async function fetchHorizonClaimableBalances(
  cursor?: string,
  limit: number = 50,
): Promise<HorizonBalancesResult> {
  const url = new URL(`${config.horizonUrl}/claimable_balances`);
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  url.searchParams.set("order", "asc");
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(`Horizon HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as {
      _embedded?: {
        records: HorizonClaimableBalance[];
      };
      _links?: {
        next?: { href: string };
      };
    };

    const records = data._embedded?.records ?? [];
    const lastRecord = records[records.length - 1];
    const nextCursor = lastRecord?.paging_token ?? cursor;

    return {
      records,
      nextCursor,
    };
  } catch (err) {
    logger.error({ err, cursor }, "failed to fetch Horizon claimable balances");
    return {
      records: [],
      nextCursor: cursor,
    };
  }
}
