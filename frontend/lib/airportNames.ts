'use client';

import { useEffect, useState } from 'react';

/**
 * IATA code -> human-readable airport name, from the generated pipeline.
 *
 * ── What this replaced, and why it had to go ────────────────────────────────
 *
 * This file used to be a hand-written table of ~100 codes whose own header
 * said it covered "the airports listed in `originAirports.ts`" — a file phase
 * 5 deleted. The resolver that replaced it can return any of 4,008 scheduled
 * IATA airports, so every code outside that ~100 rendered as a bare code with
 * no name above it. The reproducible case: choose a different reading of an
 * ambiguous origin in the clarification banner, the home card re-points from
 * PDX to PWM, and the name vanishes — because `PWM` was never in the table.
 *
 * The names are now generated from the same OurAirports dump the airports
 * themselves come from (`backend/scripts/location-data/build.ts`, whose
 * `deriveAirportDisplayName` holds the shortening rules and their reasons),
 * emitted to `backend/src/data/generated/airportNames.json` and copied here
 * byte-for-byte by `npm run build:location-hotset`. Nothing in this file is
 * hand-maintained; `airportNames.test.ts` in both packages asserts that.
 *
 * ── One name per code, not the old short/full pair ──────────────────────────
 *
 * The table this replaced carried both a short `name` ("Portland Intl.") and a
 * `full` one ("Portland International Airport"). Checked against what actually
 * renders: all three consumers — `Flowchart`'s `HomeCard`, `CanvasHomeCard`,
 * and a chip tooltip in `HomeEditModal` — read only the short form, and
 * `getAirportFullName` had no callers at all. Shipping both measures +16.1 KiB
 * gzipped on a payload the budget note below is already the hard part of, for
 * a field nothing reads, so only the short form is generated and the dead
 * export is gone. If a formal name is ever needed, the generator has the raw
 * column and emitting a second field is a few lines — the decision is
 * recorded, not closed off.
 *
 * ── Why the lookup is lazy, which is the one awkward part ───────────────────
 *
 * The table is 4,008 codes: 105.7 KiB raw, 44.5 KiB gzipped. That cannot go
 * into the browser hot set — the hot set is 59.5 KiB of a 60 KiB gzipped
 * budget, so it has 487 bytes of headroom, and even names for just the 188
 * codes in its own `iata` index would put it 1.8 KiB over. The measurement,
 * and the two alternatives it rejected, are recorded in
 * `backend/scripts/build-location-hotset.ts`.
 *
 * So the table is a DEFERRED CHUNK, reached by `import()` the first time
 * something asks for a name. A visitor who never sees an airport card never
 * downloads it. The cost is that the first render has no names yet, which is
 * why the API below is shaped the way it is:
 *
 *   getAirportName(iata)  synchronous, `null` until the chunk has landed.
 *                         Safe to call from a render body; never throws, never
 *                         returns a placeholder.
 *   useAirportNames()     the same lookup, plus the load and a re-render when
 *                         it arrives. This is what a component should use.
 *
 * `null` is deliberate, in both. A caller that wants to fall back to the bare
 * code already has the code, and a lookup that invents "undefined" or
 * "Unknown Airport" is exactly how a missing name reaches a traveller as
 * text. Every consumer renders the code and treats the name as an optional
 * line above it, so a miss — unknown code, chunk not loaded yet, chunk failed
 * to load — degrades to the code and nothing else changes.
 */

/** The emitted file's shape. Mirrors `GeneratedAirportNames` in the backend. */
type AirportNameTable = {
  schemaVersion: number;
  generatedAt: string;
  basis: string;
  names: Record<string, string>;
};

/** `null` until the chunk lands, and still `null` if it never does. */
let names: Record<string, string> | null = null;
let inFlight: Promise<Record<string, string>> | null = null;

/** Hooks waiting for the chunk, so one load re-renders every card. */
const waiting = new Set<() => void>();

/**
 * An airport's name, or `null`.
 *
 * Synchronous and total: an unknown code, a code from a trip saved before any
 * of this existed, and a chunk that has not arrived yet all give `null`.
 */
export function getAirportName(iata: string): string | null {
  if (!iata || !names) return null;
  return names[iata.toUpperCase()] ?? null;
}

/**
 * Fetch the table, once per page.
 *
 * Exported so a caller that knows it is about to show airports can warm the
 * chunk (a route transition, say) rather than waiting for first paint.
 */
export function preloadAirportNames(): Promise<Record<string, string>> {
  if (names) return Promise.resolve(names);
  if (!inFlight) {
    inFlight = import('./generated/airportNames.json')
      .then((module) => {
        const table = ((module as { default?: AirportNameTable }).default ??
          module) as AirportNameTable;
        names = table.names ?? {};
        // `forEach` rather than `for..of`: the frontend tsconfig targets ES5
        // and will not iterate a Set without --downlevelIteration. It is also
        // the safe shape here — a listener that unsubscribes while this runs
        // is simply not visited, and no listener adds another.
        waiting.forEach((notify) => notify());
        return names;
      })
      .catch(() => {
        // A chunk that fails to load must not take the card with it. Clearing
        // `inFlight` lets the next mount try again; until one succeeds every
        // lookup returns null and every card shows its bare code.
        inFlight = null;
        return {};
      });
  }
  return inFlight;
}

/**
 * The lookup, with the chunk loaded and a re-render when it arrives.
 *
 * Returns a FUNCTION rather than one name so a component can look up several
 * codes — `HomeEditModal` maps over a list of airport chips — without calling
 * a hook per item.
 */
export function useAirportNames(): (iata: string) => string | null {
  // Only a version counter: the names live in the module, shared by every
  // card on the page, so there is nothing per-component to hold.
  const [, bump] = useState(0);

  useEffect(() => {
    if (names) return;
    let mounted = true;
    const notify = () => {
      if (mounted) bump((version) => version + 1);
    };
    waiting.add(notify);
    void preloadAirportNames();
    return () => {
      mounted = false;
      waiting.delete(notify);
    };
  }, []);

  return getAirportName;
}

/**
 * Test seam: forget the loaded table.
 *
 * Exported so a test can exercise the not-yet-loaded state, which is a real
 * state every first render passes through and the one that has to degrade to
 * a bare code.
 */
export function resetAirportNamesForTests(): void {
  names = null;
  inFlight = null;
  waiting.clear();
}
