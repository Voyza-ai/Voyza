/**
 * The browser hot set.
 *
 * One property matters more than everything else here: **a key in the hot set
 * must resolve exactly as the full artifact resolves it.** A subset of the
 * data is not a subset of the answers — a browser holding Venice, Italy but
 * not Venice, Florida would answer `Venice` confidently while the server
 * asked, and the two would disagree about a booking.
 *
 * That is asserted over every key, not sampled, because it is the only reason
 * it is safe to answer anything in the browser at all.
 *
 * The second property is coverage: the hot set is replacing a hand-written
 * table, so it has to answer what that table answered without a round trip.
 * Anything less is a latency regression dressed up as an upgrade.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { locationArtifact } from '../data/locationArtifact';
import { MULTI_AIRPORT_CITY_KEYS } from '../data/originAirports';
import { buildIndex } from '../services/location/buildIndex';
import { keysForQuery } from '../services/location/normalize';
import { DEFAULT_OPTIONS } from '../services/location/options';
import { resolve } from '../services/location/resolve';
import type { Resolution } from '../services/location/types';
import hotSetJson from '../data/generated/locationHotSet.json';

type HotEntry = { s: 'ok' | 'ask'; ids: string[]; v?: string };
type HotSet = {
  schemaVersion: number;
  artifact: { schemaVersion: number; generatedAt: string };
  places: Record<string, { n: string; c: string; a: string | null; ap: unknown[] }>;
  exact: Record<string, HotEntry>;
  iata: Record<string, string>;
  countryNames: Record<string, string>;
  adminNames: Record<string, string>;
};

const set = hotSetJson as unknown as HotSet;
const index = buildIndex(locationArtifact);

const FRONTEND_COPY = join(__dirname, '../../../frontend/lib/generated/locationHotSet.json');

describe('the property that makes a hot set safe', () => {
  it('resolves every one of its keys exactly as the full artifact does', () => {
    const mismatches: string[] = [];

    for (const [key, entry] of Object.entries(set.exact)) {
      const truth = resolve(key, {}, index);

      if (entry.s === 'ok') {
        if (truth.status !== 'resolved' || truth.place.id !== entry.ids[0]) {
          mismatches.push(
            `${key}: hot set says ${entry.ids[0]}, artifact says ${
              truth.status === 'resolved' ? truth.place.id : truth.status
            }`,
          );
        }
        continue;
      }

      if (truth.status !== 'ambiguous') {
        mismatches.push(`${key}: hot set asks, artifact says ${truth.status}`);
        continue;
      }
      const truthIds = truth.candidates.map((c) => c.place.id);
      // ORDER matters, not just membership: `ids[0]` is the answer a
      // non-asking caller takes, and the rest is the order the question is
      // asked in.
      if (truthIds.join(',') !== entry.ids.join(',')) {
        mismatches.push(`${key}: ${entry.ids.join(',')} vs ${truthIds.join(',')}`);
      }
    }

    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(mismatches).toHaveLength(0);
  });

  it('describes every place its own answers name', () => {
    // An answer pointing at a place the browser cannot render is worse than
    // no answer: it would show a blank candidate in a question.
    const dangling = Object.values(set.exact)
      .flatMap((entry) => entry.ids)
      .filter((id) => !set.places[id]);
    expect(dangling).toEqual([]);
  });

  it('marks a contested answer so the browser knows when to defer', () => {
    // `prominence` is the only `via` reachable with rivals in hand, and it is
    // what tells the browser that context could have changed the answer. If
    // this ever stops being true, `resolveLocally` starts serving stale
    // answers to callers that had a position or a trip to offer.
    for (const [key, entry] of Object.entries(set.exact)) {
      if (entry.s !== 'ok' || entry.v !== 'prominence') continue;
      const truth = resolve(key, {}, index);
      expect(truth.status).toBe('resolved');
    }

    const contested = Object.values(set.exact).filter((e) => e.v === 'prominence');
    // Non-vacuity: if this were empty the assertion above would pass while
    // testing nothing, and the deferral logic would be dead code.
    expect(contested.length).toBeGreaterThan(10);
  });

  it('never ships an uncontested answer that context could change', () => {
    // The inverse, and the one that actually protects the traveller: every
    // key the browser will answer WITH context in hand must be one the
    // resolver reached with a single candidate.
    const contextProof = new Set(['exact-unique', 'curated-alias', 'qualifier-pinned', 'iata-code']);
    for (const [key, entry] of Object.entries(set.exact)) {
      if (entry.s !== 'ok' || !entry.v || !contextProof.has(entry.v)) continue;
      // A single-candidate key cannot be swayed: assert there is genuinely
      // only one place under it after the resolver's own narrowing.
      const truth = resolve(key, {}, index);
      expect(truth.status).toBe('resolved');
      if (truth.status === 'resolved') expect(truth.place.id).toBe(entry.ids[0]);
    }
  });
});

describe('the browser builds the same label the server builds', () => {
  /** `locationResolver.ts`'s `labelOf`, reimplemented from the shipped data. */
  const browserLabel = (id: string): string => {
    const place = set.places[id];
    const country = place.c.toUpperCase();
    const parts = [place.n];
    const push = (part: string | null | undefined): void => {
      if (part && !parts.includes(part)) parts.push(part);
    };
    if (place.a) push(set.adminNames[`${country}:${place.a.toUpperCase()}`] ?? place.a);
    push(set.countryNames[country] ?? place.c);
    return parts.join(', ');
  };

  it('matches for every place it ships', () => {
    // The label IS the question put to the traveller, so a browser-rendered
    // question and a server-rendered one must not read differently for the
    // same place. This is also what justifies shipping the name tables at
    // all: without them the browser can only say "Paris, 11, FR".
    const mismatches: string[] = [];
    for (const id of Object.keys(set.places)) {
      const place = index.byId.get(id);
      if (!place) {
        mismatches.push(`${id}: not in the artifact`);
        continue;
      }
      // The server's label, via the only path that produces one.
      const truth = resolve(place.name, {}, index);
      const serverLabel =
        truth.status === 'ambiguous'
          ? truth.candidates.find((c) => c.place.id === id)?.label
          : undefined;
      if (!serverLabel) continue;
      const mine = browserLabel(id);
      if (mine !== serverLabel) mismatches.push(`${id}: "${mine}" vs "${serverLabel}"`);
    }
    expect(mismatches.slice(0, 15)).toEqual([]);
    expect(mismatches).toHaveLength(0);
  });

  it('spells out the admin region rather than its code', () => {
    // Non-vacuity, and the actual user-visible point: if the name tables were
    // empty every label would still "match" by both sides falling back to the
    // code, and the question would read "Paris, 11, FR".
    expect(Object.keys(set.adminNames).length).toBeGreaterThan(100);
    expect(Object.keys(set.countryNames).length).toBeGreaterThan(50);
    const labelled = Object.keys(set.places)
      .map(browserLabel)
      .filter((label) => /, [A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F' -]{3,}, /.test(label));
    expect(labelled.length).toBeGreaterThan(200);
  });
});

describe('coverage of the table it replaces', () => {
  it('answers every key the hand-written table answers, offline', () => {
    const missing = MULTI_AIRPORT_CITY_KEYS.filter(
      (key) => !keysForQuery(key).some((normalised) => set.exact[normalised]),
    );
    expect(missing).toEqual([]);
    // Non-vacuity: the table really does have keys to cover.
    expect(MULTI_AIRPORT_CITY_KEYS.length).toBeGreaterThan(100);
  });

  it('carries the curated inputs no dataset covers', () => {
    // These are the whole reason a hand-written table existed. If they ever
    // fall out of the hot set, the budget has been spent on the wrong places.
    for (const key of ['nyc', 'la', 'the bay area', 'silicon valley', 'dc', 'long island']) {
      expect(set.exact[key]).toBeDefined();
      expect(set.exact[key].s).toBe('ok');
    }
  });

  it('carries the state abbreviations, including the colliding ones', () => {
    for (const key of ['nj', 'ny', 'ca', 'ma', 'de', 'il']) {
      expect(set.exact[key]).toBeDefined();
    }
  });
});

describe('budget and freshness', () => {
  it('stays inside the 60 KB gzipped budget', () => {
    const bytes = gzipSync(readFileSync(FRONTEND_COPY)).byteLength;
    expect(bytes).toBeLessThanOrEqual(60 * 1024);
  });

  it('is byte-identical in both packages', () => {
    // Not two copies anyone maintains — one build output, written twice. The
    // comparison is what keeps that true.
    const backend = readFileSync(join(__dirname, '../data/generated/locationHotSet.json'));
    expect(readFileSync(FRONTEND_COPY).equals(backend)).toBe(true);
  });

  it('was built from the artifact that is checked in beside it', () => {
    // A hot set generated from an older artifact is the worst kind of stale:
    // every test here passes against the data it was built from while the
    // server answers from something else.
    expect(set.artifact.generatedAt).toBe(locationArtifact.generatedAt);
    expect(set.artifact.schemaVersion).toBe(locationArtifact.schemaVersion);
  });
});

/**
 * The browser's own resolution, cross-checked against the server.
 *
 * `frontend/lib/locationResolver.ts` answers from the hot set without a round
 * trip, and it applies ONE context rule locally: the traveller's own
 * position. That is the rule that cannot be deferred, because
 * `frontend/lib/nearestAirport.ts` promises geolocation coordinates never
 * leave the device — sending them to the server to disambiguate would break
 * the promise the "use my location" affordance rests on.
 *
 * Reproducing a server rule in a second implementation is exactly the kind of
 * duplication that drifts, so it is checked here rather than asserted in
 * prose: this is the only suite where both implementations are importable.
 * The browser may DEFER (a key it does not hold), but it must never disagree.
 *
 * The case that motivated it: the `AIRPORT_CITIES` row for Washington DC is
 * named exactly `Washington`, so every "use my location" tap in the DC metro
 * produces that string. It is ambiguous between the District and Washington
 * State, and the more prominent reading is the state — 3,700 km away on the
 * other coast.
 */
describe('the browser agrees with the server, or defers', () => {
  // Required lazily: it reads the hot set and pulls in the frontend package.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveLocally } = require('../../../frontend/lib/locationResolver') as {
    resolveLocally: (
      q: string,
      ctx?: { userLatLon?: { lat: number; lon: number } },
    ) => { status: string; place?: { placeId: string } } | null;
  };

  const POINTS = {
    dc: { lat: 38.9072, lon: -77.0369 },
    seattle: { lat: 47.6062, lon: -122.3321 },
    manhattan: { lat: 40.7831, lon: -73.9712 },
    london: { lat: 51.5072, lon: -0.1276 },
    perth: { lat: -31.95, lon: 115.86 },
  };

  const shape = (r: Resolution | null): string => {
    if (r === null) return 'defer';
    if (r.status === 'resolved') return `resolved:${r.place.id}`;
    return r.status;
  };
  const browserShape = (r: { status: string; place?: { placeId: string } } | null): string => {
    if (r === null) return 'defer';
    if (r.status === 'resolved') return `resolved:${r.place!.placeId}`;
    return r.status;
  };

  it.each([
    ['Washington', 'dc'],
    ['Washington', 'seattle'],
    ['Paris', 'manhattan'],
    ['Paris', 'london'],
    ['Melbourne', 'perth'],
    ['Venice', 'london'],
    ['Springfield', 'manhattan'],
    ['Delaware', 'dc'],
    ['nyc', 'manhattan'],
    ['Rome', 'london'],
    ['Florence', 'london'],
  ])('%s, from %s', (query, point) => {
    const context = { userLatLon: POINTS[point as keyof typeof POINTS] };
    const browser = browserShape(resolveLocally(query, context));
    if (browser === 'defer') return; // deferring is always allowed
    expect(browser).toBe(shape(resolve(query, context, index)));
  });

  it('resolves Washington to the District for someone standing in it', () => {
    // The whole point, asserted directly rather than only through the table
    // above — and asserted on the PLACE, because "it resolved" is not the
    // claim. Before the position rule ran in the browser, this was the state.
    const answer = resolveLocally('Washington', { userLatLon: POINTS.dc });
    expect(answer?.status).toBe('resolved');
    expect(answer?.place?.placeId).toBe(
      (() => {
        const truth = resolve('Washington', { userLatLon: POINTS.dc }, index);
        return truth.status === 'resolved' ? truth.place.id : 'NOT-RESOLVED';
      })(),
    );
    const place = index.byId.get(answer!.place!.placeId);
    expect(place?.admin).toBe('DC');
    expect(place?.airports[0].iata).toBe('IAD');
  });

  it('does not let a far-away position decide, on either side', () => {
    // 2,057 km to Paris, Texas and 5,837 km to France clears any ratio, which
    // is why `userLocalKm` exists. Both implementations must honour it.
    const context = { userLatLon: POINTS.manhattan };
    expect(resolveLocally('Paris', context)?.status).toBe('ambiguous');
    expect(resolve('Paris', context, index).status).toBe('ambiguous');
  });

  it('reads its dominance constants from the artifact, not a copy', () => {
    // Three numbers the browser needs to reproduce the rule. Emitted by the
    // generator so they cannot drift from `options.ts`.
    const emitted = (set as unknown as { options: Record<string, number> }).options;
    expect(emitted).toEqual({
      locationDominanceRatio: DEFAULT_OPTIONS.locationDominanceRatio,
      locationDominanceKm: DEFAULT_OPTIONS.locationDominanceKm,
      userLocalKm: DEFAULT_OPTIONS.userLocalKm,
    });
  });
});
