import { env } from '../config/env';

/**
 * True when flight searches go to Duffel's LIVE mode (a `duffel_live_` token).
 *
 * Production runs a TEST token today, and test mode answers some questions
 * differently, not just with made-up prices: a search on a metro code (CHI,
 * NYC) comes back with test-airline placeholders under the metro code itself,
 * never one of its airports (measured 2026-11-02). The optimizer only ranks
 * home flights on a metro code in live mode, where the answer covers the
 * metro's airports (see optimizer.ts searchHomeOffers).
 *
 * Read at call time, not import time, so a test can switch modes.
 */
export function duffelLiveMode(): boolean {
  return (env.DUFFEL_ACCESS_TOKEN ?? '').startsWith('duffel_live_');
}
