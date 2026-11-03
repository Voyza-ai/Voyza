/**
 * A virtual-time Duffel for the gate harness: what one cold plan costs in
 * requests and modelled wall time, cheap enough to run thousands of times.
 *
 * Production as measured on its test token (2026-11-02):
 *  - search latency: median 2.6 s, lognormal-ish, with occasional 5-10 s
 *    tails (here: σ = 0.35 around 2.6 s, and 5% of searches 5-10 s);
 *  - 6 searches in flight at once (flights.ts MAX_CONCURRENT_SEARCHES), the
 *    rest queue in order;
 *  - ~45 accepted requests per 60 s window per token: a window starts at the
 *    first request once the previous one is over; past 45, Duffel answers 429
 *    (150 ms) and every search waits for the window to reset (flights.ts'
 *    shared pause), then retries.
 *
 * Repeats of a search (same key) share one answer, as flights.ts' cache does.
 * Latency is a pure function of (seed, key), so two optimizers asking the
 * same search pay the same for it.
 *
 * The timing harness (timing.harness.ts) runs the REAL flights.ts under jest
 * fake timers instead; this is the same model with no flights.ts in the way,
 * for the gate's thousands of trials.
 */

import { unit } from '../../src/tests/helpers/fareModel';

export const SLOTS = 6;
export const WINDOW_LIMIT = 45;
export const WINDOW_MS = 60_000;
export const MEDIAN_LATENCY_MS = 2600;

/** One search's latency, ms: lognormal around 2.6 s, 5% of them 5-10 s. */
export function latencyMs(seed: number, key: string): number {
  if (unit(seed, `tail|${key}`) < 0.05) return 5000 + 5000 * unit(seed, `tailms|${key}`);
  // Box-Muller from two uniforms.
  const u1 = Math.max(1e-9, unit(seed, `lat1|${key}`));
  const u2 = unit(seed, `lat2|${key}`);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return MEDIAN_LATENCY_MS * Math.exp(0.35 * z);
}

type Timer = { at: number; seq: number; fire: () => void };

export type DuffelSim = {
  /** Answer one search after its modelled latency (repeats share the first answer). */
  search<T>(key: string, answer: () => T): Promise<T>;
  /** Run `fn` to completion in virtual time. */
  drive<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }>;
  readonly stats: { requests: number; accepted: number; rejected429: number; distinct: number };
};

export function createDuffelSim(seed: number): DuffelSim {
  let now = 0;
  let seq = 0;
  const timers: Timer[] = [];
  const schedule = (at: number, fire: () => void) => timers.push({ at, seq: seq++, fire });

  let active = 0;
  const queue: Array<() => void> = [];
  let windowStart = -Infinity;
  let accepted = 0;
  let pausedUntil = 0;
  const stats = { requests: 0, accepted: 0, rejected429: 0, distinct: 0 };
  const cache = new Map<string, Promise<unknown>>();

  const release = () => {
    active--;
    queue.shift()?.();
  };

  const search = <T>(key: string, answer: () => T): Promise<T> => {
    const hit = cache.get(key);
    if (hit) return hit as Promise<T>;
    stats.distinct++;
    const promise = new Promise<T>((resolve) => {
      const attempt = () => {
        if (active >= SLOTS) {
          queue.push(attempt);
          return;
        }
        if (now < pausedUntil) {
          // flights.ts: a paused call waits out the pause, with up to 1 s of spread.
          schedule(pausedUntil + 1000 * unit(seed, `spread|${key}|${now}`), attempt);
          return;
        }
        active++;
        stats.requests++;
        if (now >= windowStart + WINDOW_MS) {
          windowStart = now;
          accepted = 0;
        }
        if (accepted >= WINDOW_LIMIT) {
          stats.rejected429++;
          pausedUntil = Math.max(pausedUntil, windowStart + WINDOW_MS);
          schedule(now + 150, () => {
            release();
            attempt();
          });
          return;
        }
        accepted++;
        stats.accepted++;
        schedule(now + latencyMs(seed, key), () => {
          release();
          resolve(answer());
        });
      };
      attempt();
    });
    cache.set(key, promise);
    return promise;
  };

  const drive = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const start = now;
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    fn().then(
      (v) => {
        settled = true;
        value = v;
      },
      (e) => {
        settled = true;
        error = e;
      },
    );
    for (;;) {
      // Let every promise chain the last answer started run to its next search.
      await new Promise<void>((r) => setImmediate(r));
      if (settled) break;
      if (timers.length === 0) throw new Error('virtual Duffel: the run is waiting on nothing');
      let next = 0;
      for (let k = 1; k < timers.length; k++) {
        if (timers[k].at < timers[next].at || (timers[k].at === timers[next].at && timers[k].seq < timers[next].seq)) next = k;
      }
      const [t] = timers.splice(next, 1);
      now = Math.max(now, t.at);
      t.fire();
    }
    if (error) throw error;
    return { value: value as T, ms: now - start };
  };

  return { search, drive, stats };
}
