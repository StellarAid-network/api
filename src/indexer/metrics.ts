/**
 * Metrics tracking for the chain indexer and HTTP API (Prometheus format).
 */

export const MAX_INDEXER_LAG_THRESHOLD = 500;

interface IndexerMetricsState {
  eventsProcessedTotal: number;
  eventTimestampsMs: number[];
  latestLedger: number;
  lastIndexedLedger: number;
  httpRequestsTotal: number;
  httpRequestDurationMsSum: number;
  httpRequestDurationMsCount: number;
  notificationsQueueDepth: number;
  dbPoolActive: number;
  reconciliationRunsTotal: number;
  reconciliationDiscrepanciesRepairedTotal: number;
}

const state: IndexerMetricsState = {
  eventsProcessedTotal: 0,
  eventTimestampsMs: [],
  latestLedger: 0,
  lastIndexedLedger: 0,
  httpRequestsTotal: 0,
  httpRequestDurationMsSum: 0,
  httpRequestDurationMsCount: 0,
  notificationsQueueDepth: 0,
  dbPoolActive: 0,
  reconciliationRunsTotal: 0,
  reconciliationDiscrepanciesRepairedTotal: 0,
};

function pruneOldEventTimestamps(nowMs: number): void {
  const cutoff = nowMs - 60_000;
  while (state.eventTimestampsMs.length > 0 && state.eventTimestampsMs[0]! < cutoff) {
    state.eventTimestampsMs.shift();
  }
}

export function recordProcessedEvents(count: number = 1): void {
  state.eventsProcessedTotal += count;
  const now = Date.now();
  pruneOldEventTimestamps(now);
  for (let i = 0; i < count; i++) {
    state.eventTimestampsMs.push(now);
  }
}

export function updateLatestLedger(ledger: number): void {
  if (ledger > state.latestLedger) {
    state.latestLedger = ledger;
  }
}

export function updateLastIndexedLedger(ledger: number): void {
  if (ledger > state.lastIndexedLedger) {
    state.lastIndexedLedger = ledger;
  }
}

export function recordHttpRequest(durationMs: number): void {
  state.httpRequestsTotal += 1;
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    state.httpRequestDurationMsSum += durationMs;
    state.httpRequestDurationMsCount += 1;
  }
}

export function setNotificationsQueueDepth(depth: number): void {
  state.notificationsQueueDepth = Math.max(0, depth);
}

export function setDbPoolActive(active: number): void {
  state.dbPoolActive = Math.max(0, active);
}

export function recordReconciliationRun(repairedCount: number): void {
  state.reconciliationRunsTotal += 1;
  if (repairedCount > 0) {
    state.reconciliationDiscrepanciesRepairedTotal += repairedCount;
  }
}

export function getIndexerMetrics(): {
  indexer_lag_ledgers: number;
  events_processed_total: number;
  events_processed_per_minute: number;
  latest_ledger: number;
  last_indexed_ledger: number;
  http_requests_total: number;
  http_request_duration_ms_sum: number;
  http_request_duration_ms_count: number;
  notifications_queue_depth: number;
  db_pool_active: number;
  reconciliation_runs_total: number;
  reconciliation_discrepancies_repaired_total: number;
} {
  pruneOldEventTimestamps(Date.now());
  const lag =
    state.latestLedger > 0 && state.lastIndexedLedger > 0
      ? Math.max(0, state.latestLedger - state.lastIndexedLedger)
      : 0;

  return {
    indexer_lag_ledgers: lag,
    events_processed_total: state.eventsProcessedTotal,
    events_processed_per_minute: state.eventTimestampsMs.length,
    latest_ledger: state.latestLedger,
    last_indexed_ledger: state.lastIndexedLedger,
    http_requests_total: state.httpRequestsTotal,
    http_request_duration_ms_sum: Number(state.httpRequestDurationMsSum.toFixed(2)),
    http_request_duration_ms_count: state.httpRequestDurationMsCount,
    notifications_queue_depth: state.notificationsQueueDepth,
    db_pool_active: state.dbPoolActive,
    reconciliation_runs_total: state.reconciliationRunsTotal,
    reconciliation_discrepancies_repaired_total: state.reconciliationDiscrepanciesRepairedTotal,
  };
}

export function isIndexerLagAcceptable(threshold: number = MAX_INDEXER_LAG_THRESHOLD): boolean {
  const metrics = getIndexerMetrics();
  return metrics.indexer_lag_ledgers <= threshold;
}

export function resetIndexerMetricsForTesting(): void {
  state.eventsProcessedTotal = 0;
  state.eventTimestampsMs = [];
  state.latestLedger = 0;
  state.lastIndexedLedger = 0;
  state.httpRequestsTotal = 0;
  state.httpRequestDurationMsSum = 0;
  state.httpRequestDurationMsCount = 0;
  state.notificationsQueueDepth = 0;
  state.dbPoolActive = 0;
  state.reconciliationRunsTotal = 0;
  state.reconciliationDiscrepanciesRepairedTotal = 0;
}

export function formatPrometheusMetrics(): string {
  const m = getIndexerMetrics();
  return [
    "# HELP indexer_lag_ledgers Number of ledgers the indexer is behind latest network ledger",
    "# TYPE indexer_lag_ledgers gauge",
    `indexer_lag_ledgers ${m.indexer_lag_ledgers}`,
    "",
    "# HELP events_processed_total Total count of blockchain events processed by indexer",
    "# TYPE events_processed_total counter",
    `events_processed_total ${m.events_processed_total}`,
    "",
    "# HELP events_processed_per_minute Blockchain events processed in the trailing 60s window",
    "# TYPE events_processed_per_minute gauge",
    `events_processed_per_minute ${m.events_processed_per_minute}`,
    "",
    "# HELP latest_ledger Latest network ledger observed",
    "# TYPE latest_ledger gauge",
    `latest_ledger ${m.latest_ledger}`,
    "",
    "# HELP last_indexed_ledger Latest ledger indexed into database",
    "# TYPE last_indexed_ledger gauge",
    `last_indexed_ledger ${m.last_indexed_ledger}`,
    "",
    "# HELP http_requests_total Total HTTP requests served",
    "# TYPE http_requests_total counter",
    `http_requests_total ${m.http_requests_total}`,
    "",
    "# HELP http_request_duration_ms HTTP request latency summary in milliseconds",
    "# TYPE http_request_duration_ms summary",
    `http_request_duration_ms_sum ${m.http_request_duration_ms_sum}`,
    `http_request_duration_ms_count ${m.http_request_duration_ms_count}`,
    "",
    "# HELP notifications_queue_depth Pending BullMQ notification jobs",
    "# TYPE notifications_queue_depth gauge",
    `notifications_queue_depth ${m.notifications_queue_depth}`,
    "",
    "# HELP db_pool_active Active database connections",
    "# TYPE db_pool_active gauge",
    `db_pool_active ${m.db_pool_active}`,
    "",
    "# HELP reconciliation_runs_total Total chain-vs-DB reconciliation runs",
    "# TYPE reconciliation_runs_total counter",
    `reconciliation_runs_total ${m.reconciliation_runs_total}`,
    "",
    "# HELP reconciliation_discrepancies_repaired_total Total DB discrepancies repaired by reconciliation",
    "# TYPE reconciliation_discrepancies_repaired_total counter",
    `reconciliation_discrepancies_repaired_total ${m.reconciliation_discrepancies_repaired_total}`,
    "",
  ].join("\n");
}
