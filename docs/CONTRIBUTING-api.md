# Contributing to `@stellar-aid/api`

`@stellar-aid/api` provides the off-chain Fastify REST service, SEP-10 wallet authentication, BullMQ background jobs, and the Soroban/Horizon indexer worker.

---

## 1. Non-Negotiable Architecture Rules

1. **The chain wins on money:** `HelpRequest` (financial fields), `Milestone`, `Contribution`, `Giveaway`, `GiveawayClaim`, `ReputationEvent`, and `Attestation` are **read-only** to HTTP routes. Only `src/indexer/` mutates them, and `src/indexer/reconcile.ts` repairs any DB drift toward on-chain contract state.
2. **Moderators can never touch funds:** Moderation endpoints (`src/modules/moderation/routes.ts`) only update `Report.status`, write `ModerationAuditLog` entries, and hide off-chain text (`Post`, `Comment`, `HelpRequest.metadata.hidden`).
3. **Authorization comes solely from JWT `sub`:** Use `requireAuth(request, reply)` and read `request.user.address`. Never trust a Stellar address in a body or query parameter as proof of caller identity.
4. **Never import from `web`:** Shared types, event decoders, and SEP-10 helpers come exclusively from `@stellar-aid/sdk`.

---

## 2. Adding an HTTP Module

1. Create `src/modules/<domain>/routes.ts` exporting an async Fastify plugin (`export async function <domain>Routes(app: FastifyInstance)`).
2. Define Fastify route `schema` (`tags`, `summary`, `params`/`querystring`/`body`, `response`) AND validate untrusted inputs with `zod`.
3. Register the route plugin in `src/app.ts` and document its auth rules in [`docs/authz-matrix.md`](./authz-matrix.md).
4. Export the updated OpenAPI specification:
   ```bash
   pnpm openapi:export
   ```
   CI (`openapi-drift` job in `.github/workflows/ci.yml`) fails if `openapi/openapi.json` is out of date.
5. Add unit/HTTP `app.inject` tests in `test/unit/` (and Testcontainers integration tests in `test/integration/` when changing SQL queries).

---

## 3. Adding an Indexer Event Handler

1. Ensure the event topic & payload are decoded in `@stellar-aid/sdk/events` (`decodeEvent`).
2. Add or update the handler in `src/indexer/handlers/<contract>.ts` and wire it in `src/indexer/handlers/index.ts`.
3. Execute all row mutations + `ProcessedEvent` idempotency insert + `IndexerCursor` advancement inside a single `prisma.$transaction(...)` so duplicate event delivery is a safe no-op.
4. Add replay and idempotency tests in `test/unit/`.

---

## 4. Database Migration Rules

- Migrations under `prisma/migrations/` are **forward-only**. Never edit an already-committed migration.
- Use the **expand → migrate → contract** pattern for breaking column changes so rolling deployments of `server` and `indexer` remain compatible.

---

## 5. Pre-PR Verification Checklist

```bash
pnpm openapi:export
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
