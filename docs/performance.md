# API & Indexer Performance Baselines (`v0.1.0-testnet`)

This document records reproducible HTTP throughput, latency percentiles, database index coverage, and indexer replay throughput for `@stellar-aid/api`.

## 1. Reproducing the Benchmark

```bash
pnpm loadtest
```

The benchmark harness (`scripts/load-test.ts`) boots the full Fastify application stack (`@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, SEP-10 JWT verification, Zod input schemas, and JSON serialization) against deterministic repository fixtures with 60 simulated concurrent Stellar wallet sessions, followed by a 1,000-event idempotent indexer replay loop (`ProcessedEvent` deduplication + `ReputationEvent` upsert + `IndexerCursor` advancement).

## 2. HTTP Route Latency & Throughput

Measured on Linux x86_64 (Node.js v24.13.0):

| Route                                         | Total Requests | Concurrency | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) |
| --------------------------------------------- | -------------: | ----------: | -----------------: | -------: | -------: | -------: |
| `GET /feed?limit=20`                          |            500 |          20 |              1,980 |     8.30 |    12.64 |    29.19 |
| `GET /requests?limit=20`                      |            500 |          20 |              1,615 |    10.36 |    25.43 |    33.59 |
| `GET /reputation/:address`                    |            500 |          20 |              6,056 |     2.98 |     4.65 |     6.65 |
| `POST /posts` (JWT + rate-limit + validation) |            300 |          10 |              1,019 |     7.02 |    20.47 |    60.19 |

All read routes remain well under a 35 ms p99 budget at 20x concurrency, and authenticated write paths sustain >1,000 req/s with JWT verification and input validation active.

## 3. Indexer Replay Throughput

| Stream / Handler                                                                                    | Events Replayed | Elapsed (ms) | Handler Ceiling (events/s) |
| --------------------------------------------------------------------------------------------------- | --------------: | -----------: | -------------------------: |
| `soroban:reputation` (`reputation.score_changed` + `ProcessedEvent` guard + `IndexerCursor` upsert) |           1,000 |          3.8 |                    264,523 |

With real PostgreSQL round-trips (~0.4–1.2 ms per single-event transaction on local SSD or ~2–4 ms on managed cloud Postgres), a 1,000-event historical catch-up completes in **0.5–4.0 seconds**, well ahead of Stellar's ~5-second ledger close interval.

## 4. PostgreSQL Index Audit

Every hot query path in `GET /feed`, `GET /requests`, `GET /reputation/:address`, `GET /notifications`, and the indexer has a matching composite or single-column index in `prisma/schema.prisma`:

| Query Path                                                                           | Prisma Model      | Index                                                           |
| ------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------- |
| Global feed pagination (`WHERE status = 'VISIBLE' ORDER BY createdAt DESC`)          | `Post`            | `@@index([status, createdAt])`                                  |
| Profile posts (`WHERE author = $1`)                                                  | `Post`            | `@@index([author])`                                             |
| Following lookup (`WHERE followerAddress = $1`)                                      | `Follow`          | `@@unique([followerAddress, followeeAddress])`                  |
| Post comment thread (`WHERE postId = $1 ORDER BY createdAt ASC`)                     | `Comment`         | `@@index([postId, createdAt])`                                  |
| Help request discovery (`WHERE status = $1 AND deadline <= $2`)                      | `HelpRequest`     | `@@index([status, deadline])`, `@@index([creator])`             |
| Reputation lookup (`WHERE subject = $1`)                                             | `ReputationEvent` | `@@index([subject])`                                            |
| Attestation lookup (`WHERE subject = $1`)                                            | `Attestation`     | `@@index([subject])`                                            |
| In-app notifications (`WHERE recipient = $1 ORDER BY createdAt DESC` / unread count) | `Notification`    | `@@index([recipient, createdAt])`, `@@index([recipient, read])` |
| Moderator report queue (`WHERE status = $1 ORDER BY createdAt ASC`)                  | `Report`          | `@@index([status, createdAt])`                                  |
| Event idempotency check (`WHERE eventId = $1`)                                       | `ProcessedEvent`  | `@id` (`eventId`) + `@@index([ledger])`                         |
