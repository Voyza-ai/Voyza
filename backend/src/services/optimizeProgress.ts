/**
 * Live progress of an optimize run, for the planner's search screen.
 *
 * The planner sends a random `progressId` with POST /api/optimize and polls
 * GET /api/optimize/progress/:id while the request is open. Every number
 * here is counted from work the run actually did (see `createRunContext` in
 * optimizer.ts) — nothing is estimated — so the screen can say "9 of 12
 * legs priced" and mean it.
 *
 * In memory, per process: a lost entry only costs the screen its counts (it
 * falls back to plain step names). Entries hold no trip data beyond counts
 * and city names the caller sent, and expire after PROGRESS_TTL_MS.
 */

export type OptimizeStage = 'airports' | 'routes' | 'finishing' | 'done';

export type OptimizeProgress = {
  stage: OptimizeStage;
  /** Candidate city orders the run is pricing (0 until known). */
  orderings: number;
  /** Distinct city-to-city legs (train AND flight compared) asked for so far. */
  legsAsked: number;
  /** Of those, how many have answered. */
  legsPriced: number;
  /** Distinct flight searches the run asked for (inter-city and home). */
  flightSearches: number;
  /** The winning order, once ranking is done. */
  bestOrder?: string[];
  updatedAt: number;
};

export type ProgressSink = (patch: Partial<Omit<OptimizeProgress, 'updatedAt'>>) => void;

export const PROGRESS_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

/** Client-made ids only: uuid-ish, so the map cannot be used as a key-value store. */
export const PROGRESS_ID = /^[A-Za-z0-9-]{8,64}$/;

const entries = new Map<string, OptimizeProgress>();

function sweep(now: number) {
  for (const [id, p] of entries) {
    if (now - p.updatedAt > PROGRESS_TTL_MS) entries.delete(id);
  }
  // Oldest first (Map keeps insertion order).
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Start tracking a run; returns the sink optimize() reports into. */
export function startProgress(id: string, now: () => number = Date.now): ProgressSink {
  const t = now();
  sweep(t);
  entries.set(id, {
    stage: 'airports',
    orderings: 0,
    legsAsked: 0,
    legsPriced: 0,
    flightSearches: 0,
    updatedAt: t,
  });
  return (patch) => {
    const cur = entries.get(id);
    if (!cur) return;
    entries.set(id, { ...cur, ...patch, updatedAt: now() });
  };
}

export function readProgress(id: string, now: number = Date.now()): OptimizeProgress | null {
  const p = entries.get(id);
  if (!p) return null;
  if (now - p.updatedAt > PROGRESS_TTL_MS) {
    entries.delete(id);
    return null;
  }
  return p;
}

/** Tests only. */
export function _resetProgress() {
  entries.clear();
}
