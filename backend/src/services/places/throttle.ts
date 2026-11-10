/**
 * Serial throttle: runs tasks one at a time, starting each at least
 * `minGapMs` after the previous one STARTED and never before it finished.
 *
 * Exists for Nominatim's usage policy (an absolute maximum of one request per
 * second, per application — not per user), so there is exactly one of these
 * per process for it. `maxQueued` bounds the backlog: a caller beyond it is
 * refused at once rather than queued minutes deep, so a burst of planning
 * can't build an unbounded tail of background lookups.
 */
export class ThrottleFullError extends Error {
  constructor() {
    super('throttle queue full');
  }
}

export type Throttle = {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks waiting or running. */
  size(): number;
};

export function createThrottle(
  minGapMs: number,
  opts: {
    maxQueued?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Throttle {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxQueued = opts.maxQueued ?? Infinity;
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;
  let queued = 0;

  return {
    size: () => queued,
    run<T>(task: () => Promise<T>): Promise<T> {
      if (queued >= maxQueued) return Promise.reject(new ThrottleFullError());
      queued++;
      const result = tail.then(async () => {
        const wait = lastStart + minGapMs - now();
        if (wait > 0) await sleep(wait);
        lastStart = now();
        try {
          return await task();
        } finally {
          queued--;
        }
      });
      // Keep the chain alive through failures.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
