/**
 * The browser resolver.
 *
 * Two things matter here and only one of them is "does it answer":
 *
 *  1. it answers the common inputs SYNCHRONOUSLY, because a typeahead that
 *     round-trips on every keystroke is slower than the hand-written table
 *     this replaces — which would make the whole exercise a regression
 *  2. it DEFERS whenever the hot set cannot be trusted to agree with the
 *     server: a miss, or a contested key when the caller has context the
 *     server would have used first
 *
 * The second is the one that protects a booking, so it gets the most tests.
 * The hot set's own correctness — that a stored answer equals the server's —
 * is asserted against the full artifact in
 * `backend/src/tests/locationHotSet.test.ts`, which is the only place both
 * are available.
 */

import {
  DEFAULT_MAX_AIRPORTS,
  hotSetInfo,
  originAirportsForCity,
  originAirportsLocally,
  resolveLocally,
  resolveLocation,
} from '@/lib/locationResolver';
import { MULTI_AIRPORT_CITY_KEYS, getOriginAirports } from '@/lib/originAirports';

describe('answers the common inputs without a round trip', () => {
  it.each([
    ['nyc', 'New York City'],
    ['la', 'Los Angeles'],
    ['the bay area', 'San Francisco Bay Area'],
    ['silicon valley', 'Silicon Valley'],
    ['New Jersey', 'New Jersey'],
    ['nj', 'New Jersey'],
    ['Chicago', 'Chicago'],
    ['Tokyo', 'Tokyo'],
  ])('%s -> %s', (query, expected) => {
    const answer = resolveLocally(query);
    expect(answer?.status).toBe('resolved');
    if (answer?.status !== 'resolved') return;
    expect(answer.place.name).toBe(expected);
    expect(answer.airports.length).toBeGreaterThan(0);
  });

  it('normalises the way the server does', () => {
    // The whole reason `locationKeys.ts` is a byte-for-byte copy. If these
    // diverge, the browser looks up a key the generator never wrote.
    for (const query of ['NEW JERSEY', 'new jersey', '  New Jersey  ', 'N.J.']) {
      expect(resolveLocally(query)?.status).toBe('resolved');
    }
  });

  it('reads a three-letter code as an airport, not a town', () => {
    const answer = resolveLocally('LAX');
    expect(answer?.status).toBe('resolved');
    if (answer?.status !== 'resolved') return;
    expect(answer.place.name).toBe('Los Angeles');
    expect(answer.via).toBe('iata-code');
  });

  it('caps the airport list, and defaults to what the old table gave', () => {
    expect(DEFAULT_MAX_AIRPORTS).toBe(3);
    const answer = resolveLocally('New York', undefined, 1);
    expect(answer?.status === 'resolved' && answer.airports).toHaveLength(1);
  });

  it('asks rather than guessing when a name has two real readings', () => {
    const answer = resolveLocally('Washington');
    expect(answer?.status).toBe('ambiguous');
    if (answer?.status !== 'ambiguous') return;
    expect(answer.candidates.length).toBeGreaterThan(1);
    // Each candidate has to be answerable on its own: something to read, an
    // id to persist, and airports to price from.
    for (const candidate of answer.candidates) {
      expect(candidate.label).toMatch(/\w/);
      expect(candidate.placeId).toBeTruthy();
      expect(candidate.airports.length).toBeGreaterThan(0);
    }
  });

  it('builds a label that distinguishes without repeating itself', () => {
    const answer = resolveLocally('Washington');
    if (answer?.status !== 'ambiguous') throw new Error('expected a question');
    const labels = answer.candidates.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    // "Georgia, Georgia, United States" is the failure this guards.
    for (const label of labels) {
      const parts = label.split(', ');
      expect(new Set(parts).size).toBe(parts.length);
    }
  });
});

describe('defers to the server exactly when it must', () => {
  it('returns null for an input it does not hold', () => {
    expect(resolveLocally('Nizhnekamsk')).toBeNull();
    expect(resolveLocally('zzzzqqqq')).toBeNull();
  });

  it('returns null for nothing at all, rather than throwing', () => {
    for (const query of ['', '   ', null, undefined]) {
      expect(resolveLocally(query)).toBeNull();
    }
  });

  it('defers a contested key as soon as the caller has context', () => {
    // `Tokyo` is stored as resolved-by-prominence, meaning the resolver had
    // rivals and context would have been consulted BEFORE prominence. So the
    // stored answer is only valid for a caller with nothing to offer.
    expect(resolveLocally('Tokyo')?.status).toBe('resolved');
    expect(resolveLocally('Tokyo', { userLatLon: { lat: 40.71, lon: -74.0 } })).toBeNull();
    expect(resolveLocally('Tokyo', { tripDestinationNames: ['Osaka'] })).toBeNull();
  });

  it('still answers an UNcontested key when the caller has context', () => {
    // The other half, and the reason the `via` is stored at all: a key the
    // resolver reached with one candidate cannot be swayed, so holding it
    // back would cost a round trip for nothing. Measured on the current
    // artifact, this is the overwhelming majority of keys.
    const withContext = { userLatLon: { lat: 40.71, lon: -74.0 } };
    expect(resolveLocally('nyc', withContext)?.status).toBe('resolved');
    expect(resolveLocally('nj', withContext)?.status).toBe('resolved');
    expect(resolveLocally('the bay area', withContext)?.status).toBe('resolved');
  });

  it('defers an ambiguous key when context could settle it', () => {
    // A question the server can answer should not be asked of the traveller.
    expect(resolveLocally('Washington')?.status).toBe('ambiguous');
    expect(resolveLocally('Washington', { userLatLon: { lat: 47.6, lon: -122.3 } })).toBeNull();
  });

  it('treats a country on its own as not enough context to defer for', () => {
    // `userCountry` is deliberately not a resolution rule on the server — a
    // traveller in the United States typing `Paris` means France far more
    // often than Texas — so it must not trigger a round trip either.
    expect(resolveLocally('Tokyo', { userCountry: 'US' })?.status).toBe('resolved');
  });
});

describe('resolveLocation always answers', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not call the server when the hot set can answer', async () => {
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    const answer = await resolveLocation('nyc');
    expect(answer.status).toBe('resolved');
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls the server for the long tail, and passes the context on', async () => {
    const spy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'unknown', suggestions: [] }),
    });
    global.fetch = spy as unknown as typeof fetch;

    await resolveLocation('Nizhnekamsk', { userLatLon: { lat: 1, lon: 2 } });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/api/locations/resolve');
    expect(init.method).toBe('POST');
    // POST, and the coordinates in the BODY: a query string would put them in
    // access logs and proxy logs.
    expect(String(url)).not.toContain('lat');
    const body = JSON.parse(init.body);
    expect(body.query).toBe('Nizhnekamsk');
    expect(body.userLatLon).toEqual({ lat: 1, lon: 2 });
  });

  it('degrades to a question when the server is unreachable', async () => {
    // This runs inside a keystroke handler. An exception there breaks the
    // field; an `unknown` just means the traveller is asked.
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(resolveLocation('Nizhnekamsk')).resolves.toEqual({
      status: 'unknown',
      suggestions: [],
    });
  });

  it('degrades the same way on a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;
    await expect(resolveLocation('Nizhnekamsk')).resolves.toEqual({
      status: 'unknown',
      suggestions: [],
    });
  });

  it('answers an empty query without asking the server', async () => {
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    expect(await resolveLocation('  ')).toEqual({ status: 'unknown', suggestions: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('originAirportsLocally — the drop-in for getOriginAirports', () => {
  it('returns IATA codes, best-first', () => {
    expect(originAirportsLocally('nj')[0]).toBe('EWR');
    expect(originAirportsLocally('nyc')[0]).toBe('JFK');
    expect(originAirportsLocally('la')[0]).toBe('LAX');
  });

  it('returns the best reading for an ambiguous name, as the table did', () => {
    const codes = originAirportsLocally('Washington');
    expect(codes.length).toBeGreaterThan(0);
  });

  it('returns an empty array rather than throwing, like the table', () => {
    for (const query of ['', '   ', null, undefined, 'zzzzqqqq']) {
      expect(originAirportsLocally(query)).toEqual([]);
    }
  });

  it('honours the max', () => {
    expect(originAirportsLocally('nyc', 1)).toHaveLength(1);
    expect(originAirportsLocally('nyc', 2)).toHaveLength(2);
  });
});

describe('the shipped hot set', () => {
  it('reports what it was built from', () => {
    expect(hotSetInfo.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(hotSetInfo.artifact.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(hotSetInfo.keys).toBeGreaterThan(3_000);
    expect(hotSetInfo.places).toBeGreaterThan(300);
  });
});

/**
 * The rollout composition, and the two regressions that found it.
 *
 * Both were found by rendering the real planner and driving the origin step,
 * not by a unit test — which is why they are pinned here now that the throwaway
 * probe that found them is gone.
 *
 * Negative control: both cases fail if `originAirportsForCity` stops leading
 * with the table and calls `originAirportsLocally` directly.
 */
describe('originAirportsForCity — the table leads, the resolver fills gaps', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    // No network at all. The point of leading with the table is that these
    // answers do not depend on a round trip, so a test that allowed one would
    // not be testing the thing that broke.
    global.fetch = jest.fn(() => {
      throw new Error('originAirportsForCity must not touch the network');
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('answers a comma-qualified city offline, which is what regressed', () => {
    // `Newark, NJ` came back with NO airports through the planner: the hot set
    // carries no `newark nj` key, so it needed the server, and without it the
    // traveller got nothing. The table has always answered this offline.
    expect(originAirportsForCity('Newark, NJ')).toEqual(getOriginAirports('Newark, NJ'));
    expect(originAirportsForCity('Newark, NJ').length).toBeGreaterThan(0);
    expect(originAirportsForCity('Newark, NJ')[0]).toBe('EWR');

    for (const input of ['Jersey City, NJ', 'Brooklyn, NY', 'Hartford, CT', 'Portland, Oregon']) {
      expect(originAirportsForCity(input)).toEqual(getOriginAirports(input));
      expect(originAirportsForCity(input).length).toBeGreaterThan(0);
    }
  });

  it('keeps the table’s reading where the two disagree', () => {
    // `Washington` is the one key of 132 where the resolver and the table
    // genuinely disagree about WHICH PLACE is meant: the table chose DC, the
    // resolver asks and leads with Washington state. Until the flip is
    // justified by the shadow log, the table's answer is the one served —
    // the frontend's value wins, because optimizer.ts uses it verbatim.
    expect(originAirportsForCity('Washington')).toEqual(getOriginAirports('Washington'));
    expect(originAirportsForCity('Washington')[0]).toBe('IAD');
    // And the resolver alone would have said otherwise, which is what makes
    // this assertion worth having rather than a tautology.
    expect(originAirportsLocally('Washington')[0]).not.toBe('IAD');
  });

  it('falls through to the resolver only where the table is silent', () => {
    // The whole value of the change: inputs the table never answered.
    for (const input of ['Paris, Texas', 'Baton Rouge, LA', 'Tbilisi, Georgia']) {
      expect(getOriginAirports(input)).toEqual([]);
    }
    // These need the server, which is blocked here, so the sync path is empty
    // — the honest offline outcome. `resolveLocation` is what reaches them.
    expect(originAirportsForCity('Paris, Texas')).toEqual([]);
  });

  it('agrees with the table on every key the table answers', () => {
    // The phase-5 gate, from the browser's side: the composition can never be
    // worse than the table it leads with.
    let compared = 0;
    for (const key of MULTI_AIRPORT_CITY_KEYS) {
      const table = getOriginAirports(key);
      if (table.length === 0) continue;
      expect(originAirportsForCity(key)).toEqual(table);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(130);
  });
});
