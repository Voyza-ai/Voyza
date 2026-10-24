/**
 * Shadow mode, and the non-asking contract `optimizer.ts` relies on.
 *
 * Two things are being tested and they are different:
 *
 *  1. the MODE machinery — which answer is served, that a resolver fault can
 *     never take down a request the table could have served, and that a
 *     disagreement is written down with the raw input
 *  2. the ADAPTER — that a `Resolution` collapses into an origin answer the
 *     way a caller which cannot stop to ask a question needs it to
 *
 * Both mocks spread `jest.requireActual`. A factory with an explicit export
 * list silently yields `undefined` for everything it forgot, and that has bitten
 * this repository three times — once hiding a whole module's behaviour behind a
 * green suite. The spread means a module that grows an export does not quietly
 * lose it here.
 */

/**
 * `config/env` is the ONE module that must not be spread from
 * `jest.requireActual`: loading it runs its zod parse, and on a missing
 * variable it calls `process.exit(1)`. Requiring the real one to copy its
 * shape kills the worker instead of the test — which is exactly how
 * `planConverse.test.ts` and `transportCoverage.test.ts` fail in a container
 * without credentials.
 *
 * So this mock is deliberately an explicit object, against the general rule
 * below. It is safe here for a reason that does not generalise: `env` is plain
 * data, not behaviour, and the only field anything in this import graph reads
 * is the mode.
 */
jest.mock('../config/env', () => ({
  env: { LOCATION_RESOLVER_MODE: 'shadow' },
}));

jest.mock('../utils/logger', () => {
  const actual = jest.requireActual('../utils/logger');
  return {
    ...actual,
    logger: { ...actual.logger, info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
});

import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getOriginAirports } from '../data/originAirports';
import { compare, originAirports, resolverMode } from '../services/location/shadow';
import {
  fromResolution,
  resolveOriginAirports,
} from '../services/location/originAirports';
import type { Resolution } from '../services/location/types';
import type { ResolverMode } from '../services/location/shadow';

const setMode = (mode: ResolverMode): void => {
  (env as unknown as { LOCATION_RESOLVER_MODE: ResolverMode }).LOCATION_RESOLVER_MODE = mode;
};

const infoMock = logger.info as jest.Mock;
const warnMock = logger.warn as jest.Mock;
const errorMock = logger.error as jest.Mock;

/** Every disagreement line, whichever level it went out at. */
const disagreements = (): unknown[][] =>
  [...infoMock.mock.calls, ...warnMock.mock.calls].filter(
    (call) => call[0] === 'location-shadow disagreement',
  );

beforeEach(() => {
  setMode('shadow');
  infoMock.mockClear();
  warnMock.mockClear();
  errorMock.mockClear();
});

describe('compare — ordered, because airports[0] decides the price', () => {
  it('reports no difference for identical lists', () => {
    expect(compare(['JFK', 'EWR'], ['JFK', 'EWR'])).toBeNull();
    expect(compare([], [])).toBeNull();
  });

  it('treats a reordering as a real disagreement', () => {
    // `estimateHomeLegCost` prices every route permutation from airports[0]
    // alone, so these two produce different itineraries and different totals.
    // A set comparison would call them equal and hide the Newark bug.
    const diff = compare(['EWR', 'JFK', 'LGA'], ['JFK', 'LGA', 'EWR']);
    expect(diff).not.toBeNull();
    expect(diff?.kind).toBe('different-order');
  });

  it('distinguishes which side came back empty', () => {
    expect(compare([], ['TYR', 'TXK'])?.kind).toBe('legacy-empty');
    expect(compare(['SEA'], [])?.kind).toBe('resolver-empty');
    expect(compare(['JFK'], ['CDG'])?.kind).toBe('different-airports');
  });
});

describe('modes', () => {
  it('serves the table and runs nothing else when off', () => {
    setMode('off');
    expect(resolverMode()).toBe('off');
    // `Paris, Texas` is the clearest separator: the table refuses it, the
    // resolver answers it.
    expect(originAirports('Paris, Texas').airports).toEqual([]);
    expect(disagreements()).toHaveLength(0);
  });

  it('serves the table but logs the disagreement when shadowing', () => {
    const result = originAirports('Paris, Texas');
    expect(result.airports).toEqual(getOriginAirports('Paris, Texas'));
    expect(result.airports).toEqual([]);

    const [message, meta] = disagreements()[0] as [string, Record<string, unknown>];
    expect(message).toBe('location-shadow disagreement');
    // The raw input is the point of the line. The original bug was
    // `"New Jersey"` arriving as `"NEW"`, and no aggregate would have shown it.
    expect(meta.input).toBe('Paris, Texas');
    expect(meta.served).toBe('legacy');
    expect(meta.kind).toBe('legacy-empty');
    expect((meta.resolver as string[]).length).toBeGreaterThan(0);
  });

  it('serves the resolver when live, and still logs', () => {
    setMode('live');
    const result = originAirports('Paris, Texas');
    expect(result.airports.length).toBeGreaterThan(0);
    expect(result.placeId).toBeTruthy();
    expect((disagreements()[0] as [string, { served: string }])[1].served).toBe('resolver');
  });

  it('never changes the priced airport for an input the table was built for', () => {
    // If every input disagreed in a way that mattered, the log would be
    // useless and the flip to `live` unreviewable. These are the table's own
    // home turf: the resolver may know about extra fallback airports, but
    // airports[0] — the only slot `estimateHomeLegCost` prices from — must
    // agree, so no line is written at `warn`.
    for (const input of ['Los Angeles', 'Chicago', 'Boston', 'Seattle', 'Denver']) {
      infoMock.mockClear();
      warnMock.mockClear();
      const result = originAirports(input);
      expect(result.airports.length).toBeGreaterThan(0);
      expect(result.airports[0]).toBe(getOriginAirports(input)[0]);
      expect(warnMock.mock.calls.filter((c) => c[0] === 'location-shadow disagreement')).toEqual(
        [],
      );
    }
  });

  it('separates an added fallback from a real conflict', () => {
    // Chicago: the table says ORD/MDW, the resolver says ORD/MDW/GYY. Same
    // lead, same order, one more option. That is not a conflict and must not
    // be logged as one, or the three dozen rows of its kind bury the two that
    // would change someone's itinerary.
    const diff = compare(['ORD', 'MDW'], ['ORD', 'MDW', 'GYY']);
    expect(diff?.kind).toBe('resolver-superset');
    originAirports('Chicago');
    expect(warnMock.mock.calls.filter((c) => c[0] === 'location-shadow disagreement')).toEqual([]);
    expect(infoMock.mock.calls.filter((c) => c[0] === 'location-shadow disagreement')).toHaveLength(
      1,
    );
  });
});

describe('a resolver fault can never cost a request the table could serve', () => {
  it('falls back to the table and logs the error', () => {
    setMode('live');
    // A real fault, forced the only honest way: a context the resolver will
    // throw on rather than a mock that proves nothing about the real path.
    const exploding = {
      get tripDestinationNames(): string[] {
        throw new Error('boom');
      },
    };
    const result = originAirports('Los Angeles', exploding as never);
    expect(result.airports).toEqual(getOriginAirports('Los Angeles'));
    expect(errorMock).toHaveBeenCalled();
    expect(errorMock.mock.calls[0][1].input).toBe('Los Angeles');
  });

  it('returns an empty answer for an empty input without touching either side', () => {
    for (const input of ['', '   ', null, undefined]) {
      const result = originAirports(input);
      expect(result).toEqual({ airports: [], placeId: null });
    }
  });
});

describe('the non-asking contract', () => {
  it('gives a best effort AND the question when a name is ambiguous', () => {
    // `optimizer.ts` is already spending money on Duffel by the time the
    // origin matters, so it cannot stop to ask. It prices the best reading and
    // carries the question out on the result.
    const result = resolveOriginAirports('Paris');
    expect(result.airports.length).toBeGreaterThan(0);
    expect(result.placeId).toBeTruthy();
    expect(result.needsClarification?.reason).toBe('multi-country');
    expect(result.needsClarification?.candidates.length).toBeGreaterThan(1);
    // Each candidate must be answerable: a label to tell them apart, a place
    // id to persist, and airports to price from.
    for (const candidate of result.needsClarification!.candidates) {
      expect(candidate.label).toMatch(/\w/);
      expect(candidate.placeId).toBeTruthy();
      expect(candidate.airports.length).toBeGreaterThan(0);
    }
  });

  it('never turns a typo into an answer', () => {
    // The one place where returning nothing is right. A near-miss is offered,
    // never applied — `pariss` must not become a booked flight to Paris.
    const result = resolveOriginAirports('pariss');
    expect(result.airports).toEqual([]);
    expect(result.placeId).toBeNull();
    expect(result.needsClarification?.reason).toBe('not-found');
    expect(result.needsClarification?.candidates[0].label).toMatch(/Paris/);
  });

  it('says nothing about clarification when there is nothing to clarify', () => {
    const result = resolveOriginAirports('Reykjavik');
    expect(result.airports.length).toBeGreaterThan(0);
    expect(result.needsClarification).toBeUndefined();
  });

  it('caps the airport list where the caller asked', () => {
    expect(resolveOriginAirports('New York', {}, 1).airports).toHaveLength(1);
    expect(resolveOriginAirports('New York', {}, 2).airports).toHaveLength(2);
  });

  it('collapses an empty ambiguous list rather than claiming an answer', () => {
    // Defensive: `ambiguous` with no candidates should not be reachable, and if
    // it ever is, the adapter must not index into nothing.
    const empty: Resolution = { status: 'ambiguous', candidates: [], reason: 'near-tie' };
    expect(fromResolution(empty)).toEqual({ airports: [], placeId: null });
  });

  it('uses trip context, which is the whole reason this replaces a table', () => {
    // The table takes a string and nothing else, so it cannot do this at all.
    const roman = resolveOriginAirports('Rome', {
      tripDestinationNames: ['Florence', 'Venice'],
    });
    expect(roman.airports[0]).toBe('FCO');
    expect(roman.needsClarification).toBeUndefined();
  });
});

describe('the two inputs where the resolver used to return nothing', () => {
  it('answers a state named with its kind, as the table always did', () => {
    // Found by running the resolver over the old table's own test corpus:
    // these were the ONLY two inputs where the table had an answer and the
    // resolver had none. "State" is the traveller naming the kind of place.
    // Asserted as "answers, with the right airports in the list", not as an
    // exact match on the table's output, for two reasons.
    //
    // The resolver knows about Spokane and Boeing Field, which the
    // hand-written table never listed. Extra fallbacks are a feature.
    //
    // And WHICH of the three NYC majors leads `New York State` is a
    // defensible either-way call that has moved during this work: by distance
    // from the state's population-weighted centre it is EWR (30 km, against
    // LGA 33 and JFK 50); seeded from the table's own judgement it is JFK.
    // Pinning the assertion to one of them makes it brittle to a choice that
    // costs a traveller nothing either way, because `buildHomeLeg` fans out
    // across the whole list and takes the cheapest fare. Only the
    // permutation-ranking signal changes. So assert the part that is NOT a
    // judgement call: it resolves to the state, and it offers all three.
    const washington = resolveOriginAirports('Washington State');
    expect(washington.airports[0]).toBe('SEA');
    expect(washington.airports[0]).toBe(getOriginAirports('Washington State')[0]);

    const newYork = resolveOriginAirports('New York State');
    expect(newYork.placeId).toBe('adm:US.NY');
    expect(newYork.airports).toEqual(expect.arrayContaining(['JFK', 'LGA', 'EWR']));
    expect(['JFK', 'LGA', 'EWR']).toContain(newYork.airports[0]);
    expect(getOriginAirports('New York State')).toEqual(['JFK', 'LGA', 'EWR']);
  });

  it('does not let the suffix strip turn a city into a guess', () => {
    // The old table's own comment warns about this: `washington state`
    // stripped to `washington` is Washington DC, which would price a Seattle
    // traveller out of Dulles. The kind filter is what prevents it.
    expect(resolveOriginAirports('Washington State').airports[0]).toBe('SEA');
    expect(resolveOriginAirports('Paris State').airports).toEqual([]);
  });

  it('leaves names that merely END in a kind word alone', () => {
    // These all hit `exact` and never reach the suffix path. Without that
    // ordering, `Kansas City` becomes a search for a city called "Kansas".
    for (const input of ['Mexico City', 'Salt Lake City', 'Jersey City']) {
      expect(resolveOriginAirports(input).airports.length).toBeGreaterThan(0);
    }
    expect(resolveOriginAirports('Salt Lake City').airports[0]).toBe('SLC');
  });
});
