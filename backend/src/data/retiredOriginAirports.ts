/**
 * Every answer the hand-written origin-airport table gave, frozen at the
 * moment it was deleted.
 *
 * `originAirports.ts` was 348 lines of lookup logic with a hand-maintained
 * TWIN in the frontend, kept honest by a parity test that compared their
 * source text. The resolver replaced it: measured over all 132 inputs it
 * answered, the resolver reproduces the leading airport on every one and
 * returns nothing on none. So the code is gone.
 *
 * Its KNOWLEDGE is not, and that is what this file is. Those 132 keys plus
 * the qualified shapes its comma walk handled are a record of decisions a
 * human made about which airports a traveller flies from — the only
 * independent check on the resolver that exists, because everything else is
 * derived from the same artifact the resolver reads.
 *
 * ── DO NOT REGENERATE THIS ──────────────────────────────────────────────────
 *
 * It is a snapshot, not a build output. Regenerating it from the resolver
 * would make the gate below compare the resolver to itself, which is how a
 * regression test quietly becomes a tautology. The table it came from no
 * longer exists, so there is nothing to regenerate it FROM.
 *
 * Two things read it:
 *
 *  - `locationLiveGate.test.ts`, which fails if the resolver stops
 *    reproducing a leading airport. That is the whole safety net now.
 *  - `build-location-hotset.ts`, which seeds the browser hot set from these
 *    keys so the 60 KB budget can never be spent somewhere that leaves a
 *    historically-answerable input unanswerable offline.
 *
 * Changing an entry means deciding that the old answer was wrong. That is
 * allowed — `Vancouver, WA` is already recorded in the gate's ledger as a
 * case where the resolver corrects the table, Portland being 7 km away where
 * the table said Seattle at 250 — but it is a decision, written down, not a
 * number edited to make a suite go green.
 */

import frozen from './generated/retiredOriginAirports.json';

export type RetiredOriginAirports = {
  /** The day the table was deleted. */
  frozenAt: string;
  source: string;
  entries: number;
  /** Input as it was written, exactly → the IATA codes it returned, in order. */
  answers: Record<string, string[]>;
};

export const RETIRED_ORIGIN_AIRPORTS = frozen as RetiredOriginAirports;

/** Every input the retired table could answer. */
export function retiredInputs(): string[] {
  return Object.keys(RETIRED_ORIGIN_AIRPORTS.answers);
}

/**
 * What the retired table answered, or `[]`.
 *
 * Deliberately NOT a reimplementation of its normalisation — a lookup of
 * exactly the strings it was asked. Anything else would be the table back
 * again, in a file that claims to be a snapshot.
 */
export function retiredAnswer(input: string): string[] {
  return RETIRED_ORIGIN_AIRPORTS.answers[input] ?? [];
}
