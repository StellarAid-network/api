import * as Sentry from "@sentry/node";
import { config } from "../config";

let initialized = false;

/**
 * Initialize Sentry error reporting when `SENTRY_DSN` is configured.
 * Safe no-op in development/test when `SENTRY_DSN` is omitted or placeholder.
 */
export function initSentry(): void {
  if (initialized) return;
  if (!config.sentryDsn || config.sentryDsn.includes("placeholder")) {
    return;
  }

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.nodeEnv === "production" ? 0.1 : 0,
  });
  initialized = true;
}

/**
 * Report an unhandled server exception to Sentry with request context (no secrets or PII).
 */
export function captureException(
  err: unknown,
  context?: { requestId?: string; method?: string; url?: string; userAddress?: string | null },
): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context?.requestId) scope.setTag("request_id", context.requestId);
    if (context?.method) scope.setTag("http.method", context.method);
    if (context?.url) scope.setExtra("url", context.url);
    if (context?.userAddress) scope.setUser({ id: context.userAddress });
    Sentry.captureException(err);
  });
}
