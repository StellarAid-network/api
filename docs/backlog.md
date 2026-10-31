# Contributor Issue Backlog — `api`

Ready-to-claim tasks for `@stellar-aid/api`. Comment on the corresponding GitHub Issue before starting work, and follow [`docs/CONTRIBUTING-api.md`](./CONTRIBUTING-api.md).

---

### 1. `[good first issue]` Add `POST /notifications/read-all` bulk mark-as-read endpoint

- **Labels:** `good first issue`, `notifications`
- **Scope:** `src/modules/notifications/routes.ts`, `docs/authz-matrix.md`, `openapi/openapi.json`
- **Acceptance Criteria:**
  - Marks all unread notifications where `recipient === request.user.address` with `readAt = new Date()` and returns `{ updatedCount }`.
  - Covered by 401/200 unit tests and regenerated `openapi.json`.

### 2. `[good first issue]` Enqueue `milestone_released` and `request_failed` notification events

- **Labels:** `good first issue`, `indexer`, `notifications`
- **Scope:** `src/indexer/handlers/help-request.ts`, `src/jobs/notifications.ts`
- **Acceptance Criteria:**
  - Notify contributors when a milestone is released on a funded request or when a request transitions to `failed` so they know a refund is claimable.
  - Preserve idempotency on event replay.

### 3. `[good first issue]` Add cursor pagination to `GET /reputation/:address` event history

- **Labels:** `good first issue`, `reputation`
- **Scope:** `src/modules/reputation/routes.ts`, `test/unit/day6-trust-reconcile-authz.test.ts`
- **Acceptance Criteria:**
  - Support `?cursor=<id>&limit=<1..50>` on the `events` array returned by `GET /reputation/:address` while keeping `score` and `badges` at the top level.

### 4. `[good first issue]` Add `token` and `minGoal`/`maxGoal` query filters to `GET /requests`

- **Labels:** `good first issue`, `requests`
- **Scope:** `src/modules/requests/routes.ts`, `test/unit/day5-routes.test.ts`
- **Acceptance Criteria:**
  - Validate optional `token`, `minGoal`, and `maxGoal` query parameters with Zod and document them in OpenAPI.

### 5. `[help wanted]` PostgreSQL `tsvector` GIN full-text ranking on `GET /search`

- **Labels:** `help wanted`, `search`, `database`
- **Scope:** `prisma/migrations/`, `src/modules/search/routes.ts`
- **Acceptance Criteria:**
  - Add a generated `tsvector` column + GIN index over `HelpRequest.metadata` (`title`, `description`, `tags`) and `User` (`displayName`, `bio`), ranking matches with `ts_rank_cd` and falling back cleanly when queries contain punctuation.

### 6. `[help wanted]` Extend chain-vs-DB reconciliation (`reconcile.ts`) to `Milestone` statuses

- **Labels:** `help wanted`, `indexer`, `reliability`
- **Scope:** `src/indexer/reconcile.ts`, `test/unit/day6-trust-reconcile-authz.test.ts`
- **Acceptance Criteria:**
  - Compare each indexed `Milestone` row's `status` and `evidenceHash` against `aid.helpRequests.get(id)` and repair drifted milestone rows automatically while incrementing `reconcileRepairedCount`.

### 7. `[good first issue]` Moderator audit-log read endpoint (`GET /admin/audit-logs`)

- **Labels:** `good first issue`, `moderation`
- **Scope:** `src/modules/moderation/routes.ts`, `docs/authz-matrix.md`
- **Acceptance Criteria:**
  - Moderator-gated (`ADMIN_ADDRESSES`) cursor-paginated read endpoint over `ModerationAuditLog` with optional `moderator` and `reportId` filters.

### 8. `[help wanted]` Dead-letter queue inspection & retry CLI (`pnpm jobs:dlq`) for BullMQ notifications

- **Labels:** `help wanted`, `jobs`, `observability`
- **Scope:** `src/jobs/notifications.ts`, `scripts/dlq.ts`
- **Acceptance Criteria:**
  - CLI command listing failed BullMQ notification jobs and optionally retrying or purging them safely, plus exposing `bullmq_failed_jobs_total` on `/metrics`.

### 9. `[good first issue]` WebP/AVIF dimension & EXIF orientation stripping check on `POST /uploads`

- **Labels:** `good first issue`, `security`, `uploads`
- **Scope:** `src/modules/uploads/routes.ts`
- **Acceptance Criteria:**
  - Strip GPS/EXIF metadata from uploaded JPEG/WebP images prior to IPFS pinning so community members do not inadvertently publish location metadata.

### 10. `[help wanted]` OpenAPI breaking-change diff check in `ci.yml`

- **Labels:** `help wanted`, `ci`, `dx`
- **Scope:** `.github/workflows/ci.yml`
- **Acceptance Criteria:**
  - Run `oasdiff breaking` against `origin/main:openapi/openapi.json` on pull requests and post a clear summary when a breaking response/parameter change is detected.
