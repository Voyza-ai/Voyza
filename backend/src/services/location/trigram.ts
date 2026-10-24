/**
 * Fuzzy matching: a trigram inverted index.
 *
 * Decided by measurement at 50,000 terms, and NOT up for re-litigation:
 *
 * | method            | heap     | p50     | p95     |
 * |-------------------|----------|---------|---------|
 * | trigram inverted  | 7.2 MiB  | 1.04 ms | 1.94 ms |
 * | SymSpell prefix-7 | 105 MiB  | 0.04 ms | 0.13 ms |
 * | length bucket     | 0.5 MiB  | 4.38 ms | 7.00 ms |
 * | brute force       | 0        | 4.69 ms | 7.27 ms |
 * | BK-tree           | 11.4 MiB | 9.62 ms | 14.29 ms |
 *
 * SymSpell buys latency nobody can perceive for 14x the memory; BK-tree is
 * strictly dominated (more memory than trigram AND slower than brute force).
 *
 * Trigram's one weakness is short strings: 65% recall under 5 characters, 100%
 * at or above. So keys shorter than `SHORT_KEY` take a brute-force path
 * instead, restricted to the length band that could possibly be within the
 * distance bound — for a 2-character query that is a handful of keys, not the
 * dictionary. `byLength` exists for exactly that.
 */

import type { FuzzyIndex } from './types';

/** Below this many characters, trigram recall is 65%, so brute force instead. */
const SHORT_KEY = 5;

/** Guards so a trigram carries position information at the word boundary. */
const HEAD = '\u0001';
const TAIL = '\u0002';

/**
 * Trigram candidates ranked by overlap, before the (more expensive) edit
 * distance runs. 200 is far above the point where a real match is still in the
 * list; it exists so a pathological query cannot turn into a full scan.
 */
const CANDIDATE_CAP = 200;

/** Rough per-entry overhead for a JS string / array slot, for `approxBytes`. */
const STRING_OVERHEAD = 24;
const ARRAY_OVERHEAD = 32;

function trigramsOf(key: string): string[] {
  const padded = `${HEAD}${HEAD}${key}${TAIL}`;
  const out: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
  return out;
}

/**
 * Levenshtein distance, banded and early-exiting. Returns `max + 1` as soon as
 * the answer is known to exceed `max`, which is the common case here: most
 * candidates are rejected, so the cheap rejection is the hot path.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length <= max ? b.length : max + 1;
  if (b.length === 0) return a.length <= max ? a.length : max + 1;

  // Keep the shorter string on the inner axis.
  if (a.length > b.length) [a, b] = [b, a];

  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    const from = Math.max(1, j - max);
    const to = Math.min(a.length, j + max);
    if (from > 1) curr[from - 1] = max + 1;
    let rowMin = curr[0] <= max ? curr[0] : max + 1;

    for (let i = from; i <= to; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        prev[i] + 1, // deletion
        curr[i - 1] + 1, // insertion
        prev[i - 1] + cost, // substitution
      );
      curr[i] = value;
      if (value < rowMin) rowMin = value;
    }
    if (to < a.length) curr[to + 1] = max + 1;
    if (rowMin > max) return max + 1;

    const swap = prev;
    prev = curr;
    curr = swap;
  }

  const distance = prev[a.length];
  return distance <= max ? distance : max + 1;
}

export type TrigramIndex = FuzzyIndex & {
  /** Number of distinct keys indexed. Reported by the perf test. */
  size(): number;
  /** Number of distinct trigrams. Reported by the perf test. */
  trigramCount(): number;
};

export function buildTrigramIndex(rawKeys: Iterable<string>): TrigramIndex {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of rawKeys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  keys.sort(); // deterministic ordering, so ties break the same way every run

  const postings = new Map<string, number[]>();
  const byLength = new Map<number, number[]>();

  keys.forEach((key, id) => {
    const lengthBucket = byLength.get(key.length);
    if (lengthBucket) lengthBucket.push(id);
    else byLength.set(key.length, [id]);

    // EVERY key is posted, short ones included. An earlier version skipped
    // keys under `SHORT_KEY` on the grounds that short strings take the
    // brute-force path — but that confuses a short QUERY with a short KEY. A
    // recall test caught it: `romez` is 5 characters, so it takes the trigram
    // path, and `rome` was not in it, so a one-letter typo on Rome could never
    // be found. The split belongs on the query side only.
    for (const gram of new Set(trigramsOf(key))) {
      const posting = postings.get(gram);
      if (posting) posting.push(id);
      else postings.set(gram, [id]);
    }
  });

  // Reused across queries: allocating a 50k-entry counter per call would cost
  // more than the search. `touched` keeps the reset O(candidates).
  const counts = new Int32Array(keys.length);
  const touched: number[] = [];

  function bruteForce(
    key: string,
    maxDistance: number,
    limit: number,
  ): Array<{ key: string; distance: number }> {
    const hits: Array<{ key: string; distance: number }> = [];
    for (let len = key.length - maxDistance; len <= key.length + maxDistance; len++) {
      for (const id of byLength.get(len) ?? []) {
        const distance = boundedLevenshtein(key, keys[id], maxDistance);
        if (distance <= maxDistance) hits.push({ key: keys[id], distance });
      }
    }
    return rank(hits, limit);
  }

  function rank(
    hits: Array<{ key: string; distance: number }>,
    limit: number,
  ): Array<{ key: string; distance: number }> {
    hits.sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
    return hits.slice(0, limit);
  }

  return {
    search(key, maxDistance, limit) {
      if (!key || limit <= 0 || maxDistance < 0) return [];
      if (key.length < SHORT_KEY) return bruteForce(key, maxDistance, limit);

      const queryGrams = new Set(trigramsOf(key));
      touched.length = 0;
      for (const gram of queryGrams) {
        for (const id of postings.get(gram) ?? []) {
          if (counts[id] === 0) touched.push(id);
          counts[id] += 1;
        }
      }

      // A single edit changes at most 3 of a string's trigrams, so a key
      // within `maxDistance` edits must share at least this many of the
      // query's trigrams. It is a lower bound, not a heuristic — recall is
      // unaffected, which the recall suite asserts over every key in the
      // artifact.
      //
      // This is also the difference between meeting the 5 ms budget and
      // missing it: without it, a query against a dictionary of similar names
      // builds a candidate list tens of thousands long and spends all its time
      // sorting one, measured at p95 6.9 ms versus 0.6 ms with it.
      const minOverlap = Math.max(1, queryGrams.size - 3 * maxDistance);

      const candidates: Array<{ id: number; overlap: number }> = [];
      for (const id of touched) {
        const overlap = counts[id];
        counts[id] = 0;
        if (overlap < minOverlap) continue;
        if (Math.abs(keys[id].length - key.length) > maxDistance) continue;
        candidates.push({ id, overlap });
      }
      candidates.sort((a, b) => b.overlap - a.overlap || a.id - b.id);

      const hits: Array<{ key: string; distance: number }> = [];
      const scanned = Math.min(candidates.length, CANDIDATE_CAP);
      for (let i = 0; i < scanned; i++) {
        const candidateKey = keys[candidates[i].id];
        const distance = boundedLevenshtein(key, candidateKey, maxDistance);
        if (distance <= maxDistance) hits.push({ key: candidateKey, distance });
      }
      return rank(hits, limit);
    },

    approxBytes() {
      // Structural estimate: string payload plus container overhead. The perf
      // test also measures real heap, because this number is a model and the
      // budget is about the machine.
      let bytes = ARRAY_OVERHEAD + counts.byteLength;
      for (const key of keys) bytes += key.length * 2 + STRING_OVERHEAD;
      for (const [gram, posting] of postings) {
        bytes += gram.length * 2 + STRING_OVERHEAD + ARRAY_OVERHEAD + posting.length * 8;
      }
      for (const [, bucket] of byLength) bytes += ARRAY_OVERHEAD + bucket.length * 8;
      return bytes;
    },

    size() {
      return keys.length;
    },

    trigramCount() {
      return postings.size;
    },
  };
}
