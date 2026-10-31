# ⚙️ stellar-aid / api

**The off-chain backend for StellarAid: profiles, posts, comments, reports, search, SEP-10 wallet authentication, and the indexer that syncs on-chain events into Postgres.**

![Node](https://img.shields.io/badge/node-20%2B-green)
![Fastify](https://img.shields.io/badge/Fastify-API-black)
![Postgres](https://img.shields.io/badge/PostgreSQL-16-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Table of contents

1. [Purpose](#purpose)
2. [Architecture](#architecture)
3. [Tech stack](#tech-stack)
4. [Prerequisites](#prerequisites)
5. [Getting started](#getting-started)
6. [Environment variables](#environment-variables)
7. [Project structure](#project-structure)
8. [Authentication (SEP-10)](#authentication-sep-10)
9. [API overview](#api-overview)
10. [Data model](#data-model)
11. [The indexer](#the-indexer)
12. [Moderation and trust](#moderation-and-trust)
13. [Rate limiting and abuse prevention](#rate-limiting-and-abuse-prevention)
14. [Database and migrations](#database-and-migrations)
15. [Running in production](#running-in-production)
16. [Observability](#observability)
17. [Testing](#testing)
18. [Scripts](#scripts)
19. [Security](#security)
20. [Contributing](#contributing)
21. [License](#license)

---

## Purpose

The blockchain should hold **money and rules**, not a social feed. This service holds everything else:

- Profiles, avatars, bios, follows
- Posts, comments, reactions
- Search, filters, sorting, and notifications
- Reports and moderation state
- A **fast mirror of on-chain data** (requests, contributions, giveaways, reputation) so the app can query it quickly

> **Source of truth rule:** for anything involving funds, **the chain wins**. The database is a cache and index. If the two disagree, the indexer reconciles toward chain state.

---

## Architecture

```
          web (Next.js)
               │  REST + OpenAPI (JWT from SEP-10)
               ▼
┌────────────────────────────── api ──────────────────────────────┐
│                                                                 │
│  ┌───────────────┐    ┌──────────────────┐   ┌───────────────┐  │
│  │ HTTP server   │    │ Domain services  │   │ Auth (SEP-10) │  │
│  │ (Fastify)     │───►│ profiles, posts, │   │ JWT sessions  │  │
│  │ OpenAPI       │    │ comments, search │   └───────────────┘  │
│  └───────────────┘    └────────┬─────────┘                      │
│                                ▼                                │
│                          ┌──────────┐      ┌────────────────┐   │
│                          │ Postgres │◄─────│ Indexer worker │   │
│                          │ (Prisma) │      │ events → rows  │   │
│                          └──────────┘      └───────┬────────┘   │
└───────────────────────────────────────────────────┼────────────┘
                                                    │
                        Soroban RPC (events) · Horizon (claimable balances, payments)
```

Two runtime processes ship from this repo:

| Process | Command | Role |
|---|---|---|
| **server** | `pnpm start:server` | HTTP API |
| **indexer** | `pnpm start:indexer` | Long-running worker that consumes chain events |

They share code and the database but scale independently. If the indexer needs its own repo later, it can be split out, since it only depends on `@stellar-aid/sdk` and the DB schema.

---

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20+, TypeScript (strict) |
| HTTP framework | Fastify (plugins, schema validation, OpenAPI via `@fastify/swagger`) |
| Database | PostgreSQL 16 |
| ORM | Prisma |
| Validation | zod (shared schemas from `@stellar-aid/sdk`) |
| Chain access | `@stellar-aid/sdk` |
| Queue and jobs | BullMQ on Redis (notifications, media processing, reindex jobs) |
| Cache and rate limiting | Redis |
| Search | Postgres full-text search to start, with the option to move to Meilisearch or Typesense |
| Media | IPFS pinning (Pinata or similar) |
| Logging | pino |
| Tests | Vitest + Testcontainers |
| Hosting | Railway or Fly.io (container) |

---

## Prerequisites

- Node.js 20+ and pnpm 9+
- Docker and Docker Compose (for Postgres and Redis)
- Access to a Soroban RPC and Horizon endpoint (public testnet endpoints work for development)

---

## Getting started

```bash
git clone https://github.com/StellarAid-network/api.git
cd api
pnpm install

cp .env.example .env
# edit .env (see below)

docker compose up -d db redis        # Postgres + Redis (or `docker compose up --build -d` for db + redis + api + indexer)
pnpm prisma migrate dev              # apply migrations
pnpm prisma db seed                  # optional: testnet-shaped demo data

pnpm dev                             # server with hot reload
pnpm dev:indexer                     # indexer with hot reload (separate terminal)
```

- API: <http://localhost:4000>
- Interactive docs (Swagger UI): <http://localhost:4000/docs>
- OpenAPI JSON: <http://localhost:4000/openapi.json>
- Health: <http://localhost:4000/healthz>

### Generate a SEP-10 server signing key (development)

```bash
stellar keys generate sep10-server --network testnet
stellar keys secret sep10-server   # put in SEP10_SIGNING_SECRET (never commit)
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | ✅ | `development`, `test`, or `production` |
| `PORT` | ➖ | HTTP port (default `4000`) |
| `DATABASE_URL` | ✅ | Postgres connection string |
| `REDIS_URL` | ✅ | Redis connection string |
| `STELLAR_NETWORK` | ✅ | `testnet`, `mainnet`, or `local` |
| `SOROBAN_RPC_URL` | ✅ | Soroban RPC endpoint |
| `HORIZON_URL` | ✅ | Horizon endpoint |
| `SEP10_SIGNING_SECRET` | ✅ | Server account secret used to sign SEP-10 challenges |
| `SEP10_HOME_DOMAIN` | ✅ | Domain that hosts `stellar.toml` (usually the web app domain) |
| `SEP10_WEB_AUTH_DOMAIN` | ➖ | Domain of this API, if different from the home domain |
| `JWT_SECRET` | ✅ | Secret for signing session tokens |
| `JWT_EXPIRES_IN` | ➖ | Token lifetime (default `1h`) |
| `CORS_ORIGINS` | ✅ | Comma-separated allowed web origins |
| `INDEXER_START_LEDGER` | ➖ | Ledger to begin from on first run |
| `INDEXER_POLL_INTERVAL_MS` | ➖ | Poll interval (default `3000`) |
| `IPFS_PINNING_JWT` | ➖ | Pinning service token |
| `SENTRY_DSN` | ➖ | Error reporting |
| `LOG_LEVEL` | ➖ | `info` by default |
| `ADMIN_ADDRESSES` | ➖ | Comma-separated Stellar addresses with admin and moderator rights |
| `MIN_ACCOUNT_AGE_SECONDS` | ➖ | Minimum local profile age required before posting/commenting (default `0`) |
| `METRICS_INTERNAL_TOKEN` | ➖ | Optional shared `X-Internal-Token` header allowing Prometheus scrapes of `/metrics` |

Secrets must come from your platform's secret manager, never from committed files.

---

## Project structure

```
api/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── src/
│   ├── server.ts                  # Fastify bootstrap
│   ├── indexer.ts                 # Indexer bootstrap
│   ├── config/                    # Env parsing (zod)
│   ├── plugins/                   # auth, cors, rate-limit, swagger, error handler
│   ├── modules/
│   │   ├── auth/                  # SEP-10 routes, JWT
│   │   ├── profiles/
│   │   ├── posts/
│   │   ├── comments/
│   │   ├── follows/
│   │   ├── giveaways/             # Read models of claimable balances
│   │   ├── requests/              # Read models of help requests
│   │   ├── contributions/
│   │   ├── reputation/
│   │   ├── reports/
│   │   ├── moderation/
│   │   ├── notifications/
│   │   ├── search/
│   │   └── uploads/
│   ├── indexer/
│   │   ├── runner.ts              # Poll loop and cursor management
│   │   ├── handlers/              # One handler per event type
│   │   ├── reconcile.ts           # Chain-vs-DB reconciliation
│   │   └── backfill.ts            # Historical backfill (Horizon)
│   ├── jobs/                      # BullMQ workers
│   ├── lib/                       # db, redis, logger, errors
│   └── types/
├── test/
├── docker-compose.yml
├── Dockerfile
├── openapi/                       # Generated spec output
└── .github/workflows/
```

---

## Authentication (SEP-10)

Users sign in with their Stellar wallet. No passwords.

```
1. GET  /auth/challenge?account=G...        → server returns a challenge transaction (XDR)
2. client signs the challenge in the wallet
3. POST /auth/token { transaction: <signed XDR> } → server verifies and returns a JWT
4. Authenticated requests send: Authorization: Bearer <JWT>
```

Rules:

- Challenge transactions are time-bound (minutes) and single use.
- JWTs are short-lived (default 1h), with a refresh through re-signing or a refresh-token cookie handled in `web`.
- JWT `sub` is the Stellar address. Authorization checks always compare against `sub`, never against a client-provided address.
- Implementation uses helpers from `@stellar-aid/sdk/auth`.

---

## API overview

> The OpenAPI spec at `/openapi.json` is the authoritative reference. `web` generates its typed client from it.

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/auth/challenge` | none | Get a SEP-10 challenge |
| POST | `/auth/token` | none | Exchange a signed challenge for a JWT |
| GET | `/auth/me` | JWT | Current session info |

### Profiles and social

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/profiles/:address` | none | Public profile with reputation and stats |
| PUT | `/profiles/me` | JWT | Update display name, bio, avatar, links |
| POST | `/profiles/:address/follow` | JWT | Follow or unfollow |
| GET | `/feed` | optional | Feed (global, following, or by tag) with cursor pagination |
| POST | `/posts` | JWT | Create a post (text and media hashes) |
| GET | `/posts/:id` | none | Read a post |
| DELETE | `/posts/:id` | JWT (owner) | Delete or hide your own post |
| GET | `/posts/:id/comments` | none | List comments |
| POST | `/posts/:id/comments` | JWT | Add a comment |

### Giveaways and help requests (read models from chain)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/giveaways` | none | List and filter open giveaways |
| GET | `/giveaways/:id` | none | Giveaway detail and claim status |
| GET | `/requests` | none | List and filter (status, nearing goal, ending soon, tag) |
| GET | `/requests/:id` | none | Request detail, progress, milestones |
| GET | `/requests/:id/contributions` | none | Public contribution history |
| POST | `/requests/:id/metadata` | JWT (creator) | Attach off-chain description and media referenced by on-chain hash |

### Trust and moderation

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/reports` | JWT | Report a post, comment, request, or user |
| GET | `/admin/reports` | JWT (moderator) | Review queue |
| POST | `/admin/reports/:id/resolve` | JWT (moderator) | Resolve and optionally hide content |
| GET | `/reputation/:address` | none | Score and badges |
| GET | `/attestations/:subject` | none | Attestations for a user or request |

### Notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/notifications` | JWT | List own in-app notifications (`?unreadOnly=`) |
| POST | `/notifications/:id/read` | JWT (owner) | Mark own notification as read |

### Search and utility

| Method | Path | Description |
|---|---|---|
| GET | `/search?q=` | Search requests, giveaways, and profiles |
| POST | `/uploads` | Upload media (JWT), returns an IPFS hash |
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness (DB, Redis, RPC reachability, indexer lag) |
| GET | `/metrics` | Prometheus metrics (internal IP or `X-Internal-Token` only) |

**Conventions:** JSON, cursor-based pagination (`?cursor=&limit=`), RFC 7807-style error bodies, `X-Request-Id` on every response.

---

## Data model

Core tables (Prisma models). See `prisma/schema.prisma` for the full schema.

| Model | Key fields | Source |
|---|---|---|
| `User` | `address` (PK), displayName, bio, avatarHash, createdAt | off-chain |
| `Follow` | followerAddress, followeeAddress | off-chain |
| `Post` | id, author, body, mediaHashes[], status, createdAt | off-chain |
| `Comment` | id, postId, author, body, status | off-chain |
| `Report` | id, reporter, targetType, targetId, reason, status, resolvedBy | off-chain |
| `ModerationAuditLog` | id, reportId, moderator, action, targetType, targetId, previousStatus, newStatus | off-chain |
| `HelpRequest` | id (on-chain id), creator, token, goal, raised, deadline, status, contentHash, metadata | **indexed** |
| `Milestone` | requestId, index, amount, status, evidenceHash | **indexed** |
| `Contribution` | requestId, contributor, amount, txHash, ledger, createdAt | **indexed** |
| `Giveaway` | balanceId, creator, asset, amount, claimants, predicates, status | **indexed** |
| `GiveawayClaim` | balanceId, claimer, txHash, ledger | **indexed** |
| `ReputationEvent` | subject, delta, newScore, refId, ledger | **indexed** |
| `Attestation` | id, attestor, subject, kind, contentHash, expiresAt, revoked | **indexed** |
| `Notification` | id, recipient, kind, title, body, refId, read, createdAt | off-chain (BullMQ) |
| `IndexerCursor` | stream, lastLedger, lastCursor, updatedAt | system |
| `ProcessedEvent` | eventId (unique), ledger | system (idempotency) |

Notes:

- Indexed tables are **read-only for the HTTP layer**. Only the indexer writes them.
- Off-chain metadata (title, description, images) is stored in `metadata` JSON and validated against the **content hash** committed on-chain. Mismatches are flagged in the API response.
- Index fields used by the feed and search: `(status, deadline)`, `(creator)`, GIN full-text index on request text.

---

## The indexer

The indexer turns blockchain events into queryable rows.

### How it works

1. Reads the stored **cursor** (last processed ledger or event id).
2. Polls **Soroban RPC `getEvents`** for contract events from the StellarAid contracts, and **Horizon** for claimable balances and payments.
3. Decodes events with `@stellar-aid/sdk/events`.
4. Runs the matching **handler** inside a DB transaction, together with the cursor update.
5. Is **idempotent**: `ProcessedEvent.eventId` is unique, so replays are safe.

### Important behaviors

- **Soroban RPC keeps events for a limited window** (on the order of days). The indexer must run continuously, and alerts fire if lag grows. For older history, use `backfill` (Horizon-based or your own archive).
- **Reorg safety:** Stellar has deterministic finality, so there are no chain reorganizations to unwind, but the indexer still tolerates restarts and duplicate delivery.
- **Reconciliation job:** periodically compares DB aggregates (for example `raised`) against contract state, and repairs drift.
- **Backpressure:** batches events per ledger range, and exposes `indexer_lag_ledgers` as a metric.

### Commands

```bash
pnpm start:indexer                         # run continuously
pnpm indexer:backfill --from <ledger>      # backfill a range
pnpm indexer:reconcile                     # one-off reconciliation
pnpm indexer:reset --stream help_request   # rebuild a stream from scratch (careful)
```

### Adding a new event type

1. Add the decoder in `@stellar-aid/sdk/events` (and release the SDK).
2. Add a handler in `src/indexer/handlers/`.
3. Add or extend a Prisma model and migration.
4. Add tests with a recorded event fixture.
5. Document the new fields in the OpenAPI spec if exposed.

---

## Moderation and trust

Decentralized money, moderated conversation:

- **Moderators can hide posts, comments, and request descriptions in the UI layer.**
- **Moderators can never move, freeze, or redirect funds.** Escrow behavior is controlled only by the contracts.
- Reports go through a queue with statuses `open → reviewing → actioned | dismissed`, and every action is recorded in an **audit log**.
- Hidden content stays retrievable by the author and by moderators, with a reason recorded.
- Repeated upheld reports can trigger a **reputation event** through the reporter flow (only via authorized on-chain paths).
- Moderator addresses come from `ADMIN_ADDRESSES` or a role table, and every admin route requires a JWT whose `sub` matches.

---

## Rate limiting and abuse prevention

| Control | Default |
|---|---|
| Global per-IP rate limit | 120 requests/min |
| Authenticated per-address limit | 300 requests/min |
| Post and comment creation | stricter limits plus minimum account age checks |
| Upload size and types | image types only, size-capped, content-type sniffed |
| Auth challenges | limited per IP and per account |
| Request body size | capped globally |

All limits are configurable and enforced with Redis.

---

## Database and migrations

```bash
pnpm prisma migrate dev --name <change>    # create and apply a migration (dev)
pnpm prisma migrate deploy                 # apply in CI and production
pnpm prisma generate                       # regenerate the client
pnpm prisma studio                         # inspect data
```

Rules:

- Migrations are **forward-only** and reviewed in PRs.
- Destructive changes use the **expand, migrate, contract** pattern across releases.
- Never edit an applied migration.
- Take backups before running migrations in production, and test them on a restored copy.

---

## Running in production

Build from the workspace root so the local `@stellar-aid/sdk` dependency is bundled cleanly:

```bash
docker build -f api/Dockerfile -t stellar-aid-api ..
docker run --env-file .env -p 4000:4000 stellar-aid-api pnpm start:server
docker run --env-file .env stellar-aid-api pnpm start:indexer
```

Or launch Postgres, Redis, API server, and indexer together via Docker Compose:

```bash
docker compose up --build -d
```

Deployment checklist:

- [ ] Managed Postgres with backups and point-in-time recovery
- [ ] Managed Redis
- [ ] `server` and `indexer` deployed as **separate services**, with a **single** active indexer instance per stream (use a lock) or a leader election
- [ ] Secrets in the platform secret manager
- [ ] Migrations run as a release step (`prisma migrate deploy`)
- [ ] Dedicated Soroban RPC and Horizon provider, not public endpoints
- [ ] Alerts on indexer lag, error rate, and DB health
- [ ] `SEP10_HOME_DOMAIN` matches a domain serving a valid `stellar.toml`
- [ ] CORS restricted to production web origins

---

## Observability

- **Logs:** structured JSON via pino, with request ids and no secrets or PII.
- **Metrics (Prometheus format at `/metrics`, internal only):** request latency and counts, `indexer_lag_ledgers`, events processed per minute, queue depth, DB pool usage.
- **Errors:** Sentry.
- **Health:** `/healthz` (process alive), `/readyz` (dependencies ok and indexer lag under threshold).

---

## Testing

| Layer | Approach |
|---|---|
| Unit | Vitest for services, validators, and handler logic |
| Integration | Testcontainers spin up real Postgres and Redis. HTTP tests use Fastify's `inject` |
| Indexer | Recorded event fixtures replayed into handlers, with idempotency and cursor tests |
| Contract tests | Validate the OpenAPI spec and make sure `web`'s generated client still compiles |
| E2E (cross-repo) | Run in CI against testnet or a local quickstart with the full stack |

```bash
pnpm test
pnpm test:integration
pnpm test:coverage
```

---

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Dev server with reload |
| `pnpm dev:indexer` | Dev indexer with reload |
| `pnpm build` | Compile TypeScript |
| `pnpm start:server` / `pnpm start:indexer` | Run compiled processes |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Quality checks |
| `pnpm test` / `pnpm test:integration` | Tests |
| `pnpm loadtest` | HTTP latency & 1,000-event indexer replay benchmark (see [docs/performance.md](./docs/performance.md)) |
| `pnpm openapi:export` | Write `openapi/openapi.json` |
| `pnpm prisma db seed` | Seed realistic testnet-shaped demo data |
| `pnpm prisma ...` | Prisma commands |

---

## Security

- All inputs validated with zod and Fastify JSON schemas. Parameterized queries only (Prisma).
- Authentication through SEP-10 and short-lived JWTs. Authorization is always derived from the token, never from request bodies (see [docs/authz-matrix.md](./docs/authz-matrix.md)).
- Strict CORS, security headers (`@fastify/helmet`), and request size limits.
- User content is stored raw and **escaped or sanitized on output**. Uploads are type-checked.
- Secrets never logged. PII minimized. Only wallet addresses and user-provided profile data are stored.
- Dependencies are monitored (Dependabot or Renovate, `pnpm audit` in CI).
- Report vulnerabilities privately. See [SECURITY.md](https://github.com/StellarAid-network/.github/blob/main/SECURITY.md).

---

## Contributing

1. Open or claim an issue from [docs/backlog.md](./docs/backlog.md). API changes that affect `web` should mention the needed client changes.
2. Branch from `main`. Add or update tests and migrations.
3. Run `pnpm lint && pnpm typecheck && pnpm test` and, for DB changes, `pnpm test:integration`.
4. Regenerate and commit the OpenAPI spec (`pnpm openapi:export`) if routes changed.
5. Follow Conventional Commits and the PR template.

See [docs/CONTRIBUTING-api.md](./docs/CONTRIBUTING-api.md) and the org [Contributing guide](https://github.com/StellarAid-network/.github/blob/main/CONTRIBUTING.md).

---

## License

MIT. See [LICENSE](./LICENSE).
