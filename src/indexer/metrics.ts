/**
 * Metrics tracking for the chain indexer.
 */

export const MAX_INDEXER_LAG_THRESHOLD = 500;

interface IndexerMetricsState {
  eventsProcessedTotal: number;
  latestLedger: number;
  lastIndexedLedger: number;
}

const state: IndexerMetricsState = {
  eventsProcessedTotal: 0,
  latestLedger: 0,
  lastIndexedLedger: 0,
};

export function recordProcessedEvents(count: number = 1): void {
  state.eventsProcessedTotal += count;
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

export function getIndexerMetrics(): {
  indexer_lag_ledgers: number;
  events_processed_total: number;
  latest_ledger: number;
  last_indexed_ledger: number;
} {
  const lag =
    state.latestLedger > 0 && state.lastIndexedLedger > 0
      ? Math.max(0, state.latestLedger - state.lastIndexedLedger)
      : 0;

  return {
    indexer_lag_ledgers: lag,
    events_processed_total: state.eventsProcessedTotal,
    latest_ledger: state.latestLedger,
    last_indexed_ledger: state.lastIndexedLedger,
  };
}

export function isIndexerLagAcceptable(
  threshold: number = MAX_INDEXER_LAG_THRESHOLD,
): boolean {
  const metrics = getIndexerMetrics();
  return metrics.indexer_lag_ledgers <= threshold;
}

export function resetIndexerMetricsForTesting(): void {
  state.eventsProcessedTotal = 0;
  state.latestLedger = 0;
  state.lastIndexedLedger = 0;
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
    "# HELP latest_ledger Latest network ledger observed",
    "# TYPE latest_ledger gauge",
    `latest_ledger ${m.latest_ledger}`,
    "",
    "# HELP last_indexed_ledger Latest ledger indexed into database",
    "# TYPE last_indexed_ledger gauge",
    `last_indexed_ledger ${m.last_indexed_ledger}`,
    "",
  ].join("\n");
}
