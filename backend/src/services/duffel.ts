import { Duffel } from '@duffel/api';
import { env } from '../config/env';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';

/**
 * Duffel client for flight search, booking, and order management.
 * Token is a secret — only ever used from the backend.
 *
 * Duffel is optional during early dev: if DUFFEL_ACCESS_TOKEN isn't set,
 * calling getDuffel() throws a descriptive 503 instead of crashing at startup.
 */
let client: Duffel | null = null;

/**
 * The longest any single Duffel HTTP call may take before the caller gives up.
 *
 * The SDK (3.3.0) calls node-fetch with no timeout and no signal, and its
 * Config takes neither — nor does the latest release (4.31.0), checked
 * 2026-10-30. So a Duffel call that never answered never returned: it held
 * one of flights.ts's six search slots for good, kept the optimize that
 * started it open with no response, and every search queued behind that slot
 * waited with it.
 *
 * The value is set so that no answer Duffel can legitimately give is cut off.
 * Duffel bounds its own side: an offer request waits for the airlines for at
 * most `supplier_timeout` — 20 s by default, 60 s at the most a caller may set
 * (Duffel API docs, create-offer-request) — and then answers with whatever
 * arrived. 90 s covers even that maximum with 30 s left for Duffel's overhead
 * and for the body, which runs to megabytes on a busy route. Through
 * production, four offer requests took 1.9–2.1 s each, but that is test mode;
 * live mode waits on real airlines, which is the wait `supplier_timeout`
 * bounds.
 *
 * This is per HTTP call, not per search or per optimize: time queued for a
 * search slot and withRetry's backoff sleeps happen outside it, so a long
 * optimize (a cold 5-city one measured 180.6 s in production) is never cut by
 * it — only a single call that has stopped answering is.
 */
export const DUFFEL_REQUEST_TIMEOUT_MS = 90_000;

/** Raised when a Duffel call outlives DUFFEL_REQUEST_TIMEOUT_MS. */
export class DuffelTimeoutError extends Error {
  constructor(method: string, path: string, ms: number) {
    super(`Duffel ${method} ${path} timed out after ${ms} ms`);
    this.name = 'DuffelTimeoutError';
  }
}

type RequestFn = (args: { method: string; path: string; [k: string]: unknown }) => Promise<unknown>;

/**
 * Put a deadline on every request the client makes.
 *
 * Every resource (`offerRequests`, `suggestions`, …) sends through the one
 * internal client's `request`, looked up at call time, so wrapping that one
 * function covers them all, `paginatedRequest` included. (`cards` is the
 * exception — the card vault has a client of its own — and nothing here uses
 * it.) That internal client is not in
 * the SDK's public typings, hence the guard: if an upgrade moves it, we log
 * and carry on without a deadline rather than break flight search.
 *
 * This bounds how long the CALLER waits; it cannot cancel the socket, because
 * the SDK gives us no way to hand node-fetch a signal. An abandoned request
 * finishes or fails on its own and its result is dropped. What matters is
 * that the search slot, the optimize and the user's request are released.
 *
 * The rejection carries no HTTP status on purpose: withRetry in flights.ts
 * retries only 429/502/503/504, so a call that has already taken 90 s is not
 * tried three more times.
 */
function withRequestDeadline(duffel: Duffel, ms: number): Duffel {
  const inner = (duffel as unknown as { client?: { request?: RequestFn } }).client;
  const original = inner?.request;
  if (!inner || typeof original !== 'function') {
    logger.warn('Duffel SDK internals changed — requests have no client-side timeout', {
      timeoutMs: ms,
    });
    return duffel;
  }
  inner.request = (args) => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DuffelTimeoutError(args.method, args.path, ms)), ms);
    });
    return Promise.race([original.call(inner, args), deadline]).finally(() => clearTimeout(timer));
  };
  return duffel;
}

export function getDuffel(): Duffel {
  if (!env.DUFFEL_ACCESS_TOKEN) {
    throw new AppError(
      503,
      'Duffel is not configured. Set DUFFEL_ACCESS_TOKEN in backend/.env',
    );
  }
  if (!client) {
    client = withRequestDeadline(
      new Duffel({ token: env.DUFFEL_ACCESS_TOKEN }),
      DUFFEL_REQUEST_TIMEOUT_MS,
    );
  }
  return client;
}
