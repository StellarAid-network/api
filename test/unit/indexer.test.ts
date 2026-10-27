import { describe, it, expect, vi } from "vitest";
import { handleHelpRequestEvent } from "../../src/indexer/handlers/help-request";
import {
  handleGiveawayRecord,
  handleGiveawayClaim,
  parseStellarAmount,
} from "../../src/indexer/handlers/giveaway";
import type { StellarAidEvent } from "@stellar-aid/sdk";
import type { Prisma } from "@prisma/client";

describe("Indexer Event Handlers & Replay Safety", () => {
  it("converts decimal asset amounts to 7-decimal stroop BigInt", () => {
    expect(parseStellarAmount("100.5000000")).toBe(1005000000n);
    expect(parseStellarAmount("0.0000001")).toBe(1n);
    expect(parseStellarAmount("25")).toBe(250000000n);
    expect(parseStellarAmount("10.123")).toBe(101230000n);
  });

  it("replays recorded help_request event stream idempotently into DB state", async () => {
    // In-memory mock database state
    const db = {
      helpRequests: new Map<string, any>(),
      contributions: new Map<string, any>(),
      milestones: new Map<string, any>(),
    };

    const mockTx: Partial<Prisma.TransactionClient> = {
      helpRequest: {
        upsert: vi.fn().mockImplementation(({ where, update, create }) => {
          const id = where.id.toString();
          if (db.helpRequests.has(id)) {
            const existing = db.helpRequests.get(id);
            db.helpRequests.set(id, { ...existing, ...update });
          } else {
            db.helpRequests.set(id, create);
          }
          return Promise.resolve(db.helpRequests.get(id));
        }),
        updateMany: vi.fn().mockImplementation(({ where, data }) => {
          const id = where.id.toString();
          if (db.helpRequests.has(id)) {
            const existing = db.helpRequests.get(id);
            db.helpRequests.set(id, { ...existing, ...data });
          }
          return Promise.resolve({ count: 1 });
        }),
      } as any,
      contribution: {
        upsert: vi.fn().mockImplementation(({ where, update, create }) => {
          const txHash = where.txHash;
          if (db.contributions.has(txHash)) {
            const existing = db.contributions.get(txHash);
            db.contributions.set(txHash, { ...existing, ...update });
          } else {
            db.contributions.set(txHash, create);
          }
          return Promise.resolve(db.contributions.get(txHash));
        }),
      } as any,
      milestone: {
        upsert: vi.fn().mockImplementation(({ where, update, create }) => {
          const key = `${where.requestId_index.requestId}_${where.requestId_index.index}`;
          if (db.milestones.has(key)) {
            const existing = db.milestones.get(key);
            db.milestones.set(key, { ...existing, ...update });
          } else {
            db.milestones.set(key, create);
          }
          return Promise.resolve(db.milestones.get(key));
        }),
        updateMany: vi.fn().mockImplementation(({ where, data }) => {
          const key = `${where.requestId}_${where.index}`;
          if (db.milestones.has(key)) {
            const existing = db.milestones.get(key);
            db.milestones.set(key, { ...existing, ...data });
          }
          return Promise.resolve({ count: 1 });
        }),
      } as any,
    };

    // Recorded fixture stream representing a request lifecycle:
    // 1. created (goal: 1000)
    // 2. contributed (amount: 500, raised: 500)
    // 3. contributed (amount: 500, raised: 1000)
    // 4. funded
    // 5. milestone 0 submitted
    // 6. milestone 0 approved
    // 7. milestone 0 released (amount: 500)
    const eventStream: Array<{
      event: StellarAidEvent;
      context: { eventId: string; ledger: number; txHash?: string };
    }> = [
      {
        event: {
          type: "help_request.created",
          requestId: 42n,
          creator: "GCFGKLCBV5IGJYGRR7FJNU53HFV5674PMQNNJT6HRAFGUAHZ7V3ZELXR",
          token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          goal: 10000000000n,
          deadline: 1893456000n,
        },
        context: { eventId: "evt_1", ledger: 100, txHash: "tx_1" },
      },
      {
        event: {
          type: "help_request.contributed",
          requestId: 42n,
          contributor: "GBCONTRIBUTOR1",
          amount: 5000000000n,
          totalRaised: 5000000000n,
        },
        context: { eventId: "evt_2", ledger: 101, txHash: "tx_2" },
      },
      {
        event: {
          type: "help_request.contributed",
          requestId: 42n,
          contributor: "GBCONTRIBUTOR2",
          amount: 5000000000n,
          totalRaised: 10000000000n,
        },
        context: { eventId: "evt_3", ledger: 102, txHash: "tx_3" },
      },
      {
        event: {
          type: "help_request.funded",
          requestId: 42n,
          totalRaised: 10000000000n,
        },
        context: { eventId: "evt_4", ledger: 103, txHash: "tx_4" },
      },
      {
        event: {
          type: "help_request.milestone_submitted",
          requestId: 42n,
          index: 0,
          evidenceHash: "0123456789abcdef",
        },
        context: { eventId: "evt_5", ledger: 104, txHash: "tx_5" },
      },
      {
        event: {
          type: "help_request.milestone_approved",
          requestId: 42n,
          index: 0,
          approver: "GCFGKLCBV5IGJYGRR7FJNU53HFV5674PMQNNJT6HRAFGUAHZ7V3ZELXR",
        },
        context: { eventId: "evt_6", ledger: 105, txHash: "tx_6" },
      },
      {
        event: {
          type: "help_request.milestone_released",
          requestId: 42n,
          index: 0,
          amount: 5000000000n,
        },
        context: { eventId: "evt_7", ledger: 106, txHash: "tx_7" },
      },
    ];

    // First playback
    for (const item of eventStream) {
      await handleHelpRequestEvent(item.event, mockTx as Prisma.TransactionClient, item.context);
    }

    const statePass1 = {
      request: JSON.parse(JSON.stringify(db.helpRequests.get("42"), (_, v) => typeof v === "bigint" ? v.toString() : v)),
      contributionsCount: db.contributions.size,
      milestone: JSON.parse(JSON.stringify(db.milestones.get("42_0"), (_, v) => typeof v === "bigint" ? v.toString() : v)),
    };

    expect(statePass1.request.status).toBe("releasing");
    expect(statePass1.request.raised).toBe("10000000000");
    expect(statePass1.contributionsCount).toBe(2);
    expect(statePass1.milestone.status).toBe("released");
    expect(statePass1.milestone.amount).toBe("5000000000");

    // Second playback (simulating complete replay of the same event stream)
    for (const item of eventStream) {
      await handleHelpRequestEvent(item.event, mockTx as Prisma.TransactionClient, item.context);
    }

    const statePass2 = {
      request: JSON.parse(JSON.stringify(db.helpRequests.get("42"), (_, v) => typeof v === "bigint" ? v.toString() : v)),
      contributionsCount: db.contributions.size,
      milestone: JSON.parse(JSON.stringify(db.milestones.get("42_0"), (_, v) => typeof v === "bigint" ? v.toString() : v)),
    };

    // Assert identical DB state after replay
    expect(statePass2).toEqual(statePass1);
  });

  it("handles Horizon giveaway claimable balances and claims idempotently", async () => {
    const giveaways = new Map<string, any>();
    const claims = new Map<string, any>();

    const mockTx: Partial<Prisma.TransactionClient> = {
      giveaway: {
        upsert: vi.fn().mockImplementation(({ where, update, create }) => {
          const balanceId = where.balanceId;
          if (giveaways.has(balanceId)) {
            giveaways.set(balanceId, { ...giveaways.get(balanceId), ...update });
          } else {
            giveaways.set(balanceId, create);
          }
          return Promise.resolve(giveaways.get(balanceId));
        }),
        updateMany: vi.fn().mockImplementation(({ where, data }) => {
          const balanceId = where.balanceId;
          if (giveaways.has(balanceId)) {
            giveaways.set(balanceId, { ...giveaways.get(balanceId), ...data });
          }
          return Promise.resolve({ count: 1 });
        }),
      } as any,
      giveawayClaim: {
        upsert: vi.fn().mockImplementation(({ where, update, create }) => {
          const txHash = where.txHash;
          if (claims.has(txHash)) {
            claims.set(txHash, { ...claims.get(txHash), ...update });
          } else {
            claims.set(txHash, create);
          }
          return Promise.resolve(claims.get(txHash));
        }),
      } as any,
    };

    const record = {
      id: "00000000abc123",
      asset: "native",
      amount: "50.0000000",
      sponsor: "GCSPONSOR",
      last_modified_ledger: 500,
      last_modified_time: "2026-10-27T12:00:00Z",
      claimants: [
        { destination: "GBCLAIMER1", predicate: { unconditional: true } },
      ],
      paging_token: "500-1",
    };

    await handleGiveawayRecord(record, mockTx as Prisma.TransactionClient);

    expect(giveaways.get("00000000abc123")).toMatchObject({
      balanceId: "00000000abc123",
      creator: "GCSPONSOR",
      asset: "native",
      amount: 500000000n,
      status: "open",
    });

    // Record claim
    await handleGiveawayClaim(
      {
        balanceId: "00000000abc123",
        claimer: "GBCLAIMER1",
        txHash: "claim_tx_999",
        ledger: 505,
      },
      mockTx as Prisma.TransactionClient,
    );

    expect(claims.get("claim_tx_999")).toMatchObject({
      balanceId: "00000000abc123",
      claimer: "GBCLAIMER1",
      txHash: "claim_tx_999",
      ledger: 505n,
    });
    expect(giveaways.get("00000000abc123").status).toBe("claimed");
  });
});
