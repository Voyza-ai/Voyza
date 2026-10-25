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
    // `Melbourne`, not `Washington`: the latter is now a curated decision
    // (the capital), so it no longer exercises the asking path at all.
    const answer = resolveLocally('Melbourne');
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
    const answer = resolveLocally('Melbourne');
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

  it('settles an ambiguous key from the traveller’s position, offline', () => {
    // This used to assert a DEFERRAL. It no longer defers, and that is the
    // fix: the hot set carries coordinates for every place it ships and the
    // dominance constants come from the generated file, so the position rule
    // runs here instead of being posted to the server.
    //
    // It has to run here. `lib/nearestAirport.ts` promises that geolocation
    // coordinates never leave the device, and the "use my location" flow
    // rests on that — deferring WITH the coordinates attached would break it.
    //
    // That the answers match the server's is asserted where both are
    // importable: `backend/src/tests/locationHotSet.test.ts`.
    expect(resolveLocally('Melbourne')?.status).toBe('ambiguous');

    const australia = resolveLocally('Melbourne', { userLatLon: { lat: -37.8136, lon: 144.9631 } });
    expect(australia?.status).toBe('resolved');
    expect(australia?.status === 'resolved' && australia.place.country).toBe('AU');
    expect(australia?.status === 'resolved' && australia.via).toBe('user-location');

    const florida = resolveLocally('Melbourne', { userLatLon: { lat: 28.0836, lon: -80.6081 } });
    expect(florida?.status === 'resolved' && florida.place.admin).toBe('FL');
  });

  it('still defers when the only context is a trip', () => {
    // The one signal that cannot be reproduced offline: the server resolves
    // each destination name to a centroid, which is a second resolution pass
    // this module deliberately does not do.
    expect(resolveLocally('Melbourne', { tripDestinationNames: ['Sydney'] })).toBeNull();
  });

  it('does not let a far-away position decide', () => {
    // Beyond `userLocalKm` a position is evidence about nothing. A traveller
    // in Manhattan is 2,057 km from Paris, Texas and 5,837 km from France,
    // which clears any ratio — so this must stay a question rather than
    // resolving to a town of 24,782.
    const answer = resolveLocally('Paris', { userLatLon: { lat: 40.7831, lon: -73.9712 } });
    expect(answer === null || answer.status === 'ambiguous').toBe(true);
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
describe('originAirportsForCity — the resolver leads, the table is the net', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    // No network at all. The point of this function is that it answers
    // synchronously, so a test that allowed a round trip would not be testing
    // the thing the synchronous call sites depend on.
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
    // traveller got nothing. Both sides answer it offline now.
    //
    // Compared on the LEADING airport rather than the whole array: the
    // resolver leads now, and it knows about fallback airports the table
    // never listed. `airports[0]` is the slot that decides anything.
    for (const input of [
      'Newark, NJ',
      'Jersey City, NJ',
      'Brooklyn, NY',
      'Hartford, CT',
      'Portland, Oregon',
    ]) {
      expect(originAirportsForCity(input).length).toBeGreaterThan(0);
      expect(originAirportsForCity(input)[0]).toBe(getOriginAirports(input)[0]);
    }
    expect(originAirportsForCity('Newark, NJ')[0]).toBe('EWR');
  });

  it('agrees with the table on the one input where it used to disagree', () => {
    // `Washington` was the single input of 132 where the two differed about
    // WHICH PLACE is meant. The table chose DC; the resolver read it as
    // ambiguous and led with Washington State, 3,700 km away on the other
    // coast. It is now a curated decision — the capital — so the flip to
    // resolver-first carries no regression at all.
    expect(originAirportsForCity('Washington')[0]).toBe('IAD');
    // Asserted on the resolver ALONE, so the table cannot be what makes this
    // pass. That is the difference between this test and a tautology.
    expect(originAirportsLocally('Washington')[0]).toBe('IAD');
    expect(getOriginAirports('Washington')[0]).toBe('IAD');
  });

  it('still reaches the state, and lets a qualifier beat the decision', () => {
    // The curated decision must not swallow the other readings: a traveller
    // who names one gets it. `Washington, Utah` returned NOTHING for a while
    // because provenance was being narrowed before the qualifier.
    expect(originAirportsForCity('Washington State')[0]).toBe('SEA');
    expect(originAirportsForCity('WA')[0]).toBe('SEA');
    // Through the composition, not the resolver alone: Washington, Utah is
    // not one of the 410 places the 60 KB hot set ships, so the browser
    // cannot answer it offline and the table net catches it. That is the
    // fallback earning its place rather than being ceremony.
    expect(originAirportsForCity('Washington, Utah').length).toBeGreaterThan(0);
    expect(originAirportsLocally('Washington, Utah')).toEqual([]);
  });

  it('falls through to the resolver where the table is silent', () => {
    // The whole value of the change: inputs the table never answered.
    for (const input of ['Paris, Texas', 'Baton Rouge, LA', 'Tbilisi, Georgia']) {
      expect(getOriginAirports(input)).toEqual([]);
    }

    // And the comma-qualified ones are now answered OFFLINE. This assertion
    // used to require `[]` here, on the grounds that a comma form needed the
    // server: the hot set keys answers by their normalised form, and
    // normalisation turns `,` into a space, so `Paris, Texas` had no key.
    // The generator now emits those forms, and the resolver gained a
    // space-separated qualifier pass so `Paris Texas` and `Paris, Texas`
    // agree — which is what makes storing the key safe.
    expect(originAirportsForCity('Paris, Texas')).toEqual(['TYR', 'TXK']);
    expect(originAirportsForCity('Newark, NJ')[0]).toBe('EWR');
    expect(originAirportsForCity('Berlin, DE')[0]).toBe('BER');
  });

  it('answers a qualifier written without a comma, the way people type it', () => {
    // `originAirports.ts` hand-keys `washington dc` precisely because the
    // comma-less form arrives often enough to matter. Both forms now reach
    // the same place.
    for (const [spaced, commaed] of [
      ['Newark NJ', 'Newark, NJ'],
      ['Paris Texas', 'Paris, Texas'],
      ['Berlin DE', 'Berlin, DE'],
    ]) {
      // Compared on the LEADING airport, not the whole list. `Newark, NJ` is
      // a table key and `Newark NJ` is not, so one answer comes from the
      // table's hand order (EWR, JFK, LGA) and the other from the artifact's
      // derived order (EWR, LGA, JFK). Same airport priced from, same place
      // resolved — and `airports[0]` is the slot that decides anything.
      expect(originAirportsForCity(spaced)[0]).toBe(originAirportsForCity(commaed)[0]);
      expect(originAirportsForCity(spaced).length).toBeGreaterThan(0);
    }
  });

  it('does not take a real multi-word name apart', () => {
    // The guard that makes the space-separated pass safe: it runs only after
    // an exact miss, so a name that IS a key is never split. Without that,
    // `new jersey` becomes a search for "New" in Jersey the country.
    expect(originAirportsForCity('new jersey')[0]).toBe('EWR');
    expect(originAirportsForCity('salt lake city')[0]).toBe('SLC');
    expect(originAirportsForCity('jersey city')[0]).toBe('EWR');
    expect(originAirportsForCity('new york')[0]).toBe('JFK');
  });

  it('leads with the same airport as the table on every key it answers', () => {
    // The flip's safety property, from the browser's side: the resolver now
    // answers first, so it must not change WHICH airport a trip is priced
    // from on anything the table knew.
    //
    // Compared on the lead, not the whole array: the resolver knows about
    // fallback airports the table never listed (`chicago` gains GYY,
    // `boston` gains PVD and BED), which widens the search rather than
    // changing it. `buildHomeLeg` prices every survivor of the
    // MAX_HOME_AIRPORTS cap and takes the cheapest.
    const differing: string[] = [];
    let compared = 0;
    for (const key of MULTI_AIRPORT_CITY_KEYS) {
      const table = getOriginAirports(key);
      if (table.length === 0) continue;
      const got = originAirportsForCity(key);
      if (got[0] !== table[0]) differing.push(`${key}: ${table[0]} -> ${got[0]}`);
      compared++;
    }
    expect(differing).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(130);
  });
});
