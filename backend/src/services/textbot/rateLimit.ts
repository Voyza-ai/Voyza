/**
 * Sliding-window limits for the group-text bot. In memory: one backend
 * process today. Each AI call costs money and every reply costs a text, so
 * the limits are on both the sender and the thread.
 */
type Window = { limit: number; ms: number };

export const TEXT_LIMITS = {
  perPhone: { limit: 8, ms: 60_000 } as Window, // a person: 8 msgs / min
  perThread: { limit: 30, ms: 10 * 60_000 } as Window, // a group: 30 AI turns / 10 min
  perThreadDaily: { limit: 200, ms: 24 * 60 * 60_000 } as Window,
  /** Wrong link codes per phone before it is locked out for the window. */
  badCodes: { limit: 5, ms: 60 * 60_000 } as Window,
};

export const MAX_INBOUND_CHARS = 800;

export class SlidingLimiter {
  private hits = new Map<string, number[]>();

  /** Records a hit and returns true if it is within the limit. */
  take(key: string, w: Window, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => t > now - w.ms);
    if (arr.length >= w.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  /** Over the limit already? Does not record a hit. */
  blocked(key: string, w: Window, now = Date.now()): boolean {
    return (this.hits.get(key) ?? []).filter((t) => t > now - w.ms).length >= w.limit;
  }
}
