import type { OptimizeTripRequest } from './optimizeRequest';

/** The same backend lib/api.ts talks to. */
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Ask the backend to search the trip's home flights now, during the chat, so
 * the plan finds them in its cache (POST /api/optimize/prewarm; prototype,
 * exp/optimizer-speed). Fire-and-forget: answers at once, never throws, and a
 * failure only means the plan searches them itself, as it always did. Send
 * the same trip the plan will send (lib/optimizeRequest.ts).
 *
 * Its own module, not lib/api.ts: nothing waits on it, and the planner's
 * tests replace lib/api.ts wholesale.
 */
export function prewarmOptimize(request: OptimizeTripRequest): void {
  try {
    void fetch(`${BASE_URL}/api/optimize/prewarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // No fetch here (tests, old browsers): the plan searches them itself.
  }
}
