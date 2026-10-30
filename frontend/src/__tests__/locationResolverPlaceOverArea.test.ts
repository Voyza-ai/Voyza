/**
 * The browser prefers a city over the region that shares its label — the
 * same rule the server applies in `fromResolution`.
 *
 * Why this matters more than it looks: the browser's answer is the one that
 * gets PRICED. `optimizer.ts` takes `originAirports` from the request body
 * verbatim whenever it is non-empty, and every planner path fills it from
 * `originAirportsForCity`. So when the server learned to answer `Moscow` with
 * the city (SVO, DME, VKO) instead of the federal-city region (SVO, VKO,
 * ZIA), real trips kept being priced from the region's list, because the hot
 * set stores the resolver's raw candidate order and the browser read
 * `candidates[0]` straight off it.
 *
 * Exhaustive agreement with the server, over every hot-set key, is asserted in
 * `backend/src/tests/originAirportsBrowserParity.test.ts` — the only suite
 * where both implementations are importable. This file holds the named cases
 * and the server-answer path, which that suite cannot reach.
 */

import {
  originAirportsForCity,
  resolveLocally,
  resolveLocation,
  type LocationAnswer,
  type LocationCandidate,
} from '@/lib/locationResolver';

describe('a city outranks the region that prints the same label', () => {
  it('prices Moscow from the city: Sheremetyevo, Domodedovo, Vnukovo', () => {
    // The region carries no metro code and orders its airports from a
    // centroid, so Zhukovsky took the third slot and Domodedovo — Russia's
    // second airport — was never priced.
    expect(originAirportsForCity('Moscow')).toEqual(['SVO', 'DME', 'VKO']);
  });

  it('asks the Moscow question with one card per reading, the city first', () => {
    const answer = resolveLocally('Moscow');
    expect(answer?.status).toBe('ambiguous');
    if (answer?.status !== 'ambiguous') return;
    const labels = answer.candidates.map((c) => c.label);
    // Two "Moscow, Russia" cards used to sit side by side.
    expect(new Set(labels).size).toBe(labels.length);
    expect(answer.candidates[0].kind).toBe('city');
    expect(answer.candidates[0].label).toBe('Moscow, Russia');
    expect(labels).toContain('Moscow, Idaho, United States');
    // The question is still asked: the reason is about the raw readings.
    expect(answer.reason).toBe('multi-country');
  });

  it('cannot touch Moscow, Idaho — a different label, so no collision', () => {
    // The reason this is a label rule and not a curated `moscow` alias: an
    // alias would have handed Idaho travellers Sheremetyevo. PUW is 9 km away.
    expect(originAirportsForCity('Moscow, Idaho')[0]).toBe('PUW');
  });

  it.each([
    ['Portland', 'PDX'],
    ['London', 'LHR'],
    ['Paris', 'CDG'],
    ['Melbourne', 'MEL'],
  ])('leaves %s, which has no colliding label, leading with %s', (query, lead) => {
    expect(originAirportsForCity(query)[0]).toBe(lead);
  });

  it('collapses a city and its same-label region to the one reading', () => {
    // `taipei` is the hot-set key where the two rows are the WHOLE candidate
    // set. One reading left is still an answer, not a deferral: the airports
    // are the city's, exactly as the server's `fromResolution` serves them.
    const answer = resolveLocally('Taipei');
    expect(answer?.status).toBe('ambiguous');
    if (answer?.status !== 'ambiguous') return;
    expect(answer.candidates).toHaveLength(1);
    expect(answer.candidates[0].kind).toBe('city');
    expect(originAirportsForCity('Taipei')).toEqual(['TPE', 'TSA', 'HUN']);
  });
});

describe('the same rule applies to an answer the server sends', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const candidate = (over: Partial<LocationCandidate>): LocationCandidate => ({
    placeId: 'x',
    name: 'San Juan',
    label: 'San Juan, Argentina',
    country: 'AR',
    admin: '18',
    kind: 'city',
    airports: [],
    ...over,
  });

  it('serves the city, not the province, for a long-tail name like San Juan', async () => {
    // `san juan` is not in the hot set, so the planner's fallback is the
    // server's answer — and `/api/locations/resolve` returns the resolver's
    // raw order, where the PROVINCE leads with Mendoza 145 km away. Measured
    // shape, trimmed to the two Argentine rows and one other reading.
    const serverAnswer = {
      status: 'ambiguous',
      reason: 'multi-country',
      candidates: [
        candidate({
          placeId: 'adm:AR.18',
          kind: 'region',
          admin: '18',
          airports: [
            { iata: 'MDZ', km: 145, servesPlace: true },
            { iata: 'UAQ', km: 10, servesPlace: true },
          ],
        }),
        candidate({
          placeId: 'gn:3837213',
          airports: [
            { iata: 'UAQ', km: 11, servesPlace: true },
            { iata: 'MDZ', km: 146, servesPlace: false },
          ],
        }),
        candidate({
          placeId: 'gn:4568127',
          label: 'San Juan, Puerto Rico',
          country: 'PR',
          admin: null,
          airports: [{ iata: 'SJU', km: 11, servesPlace: true }],
        }),
      ],
      attribution: { text: 'GeoNames' },
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => serverAnswer,
    }) as unknown as typeof fetch;

    const answer = await resolveLocation('San Juan');
    expect(answer.status).toBe('ambiguous');
    if (answer.status !== 'ambiguous') return;
    expect(answer.candidates.map((c) => c.placeId)).toEqual(['gn:3837213', 'gn:4568127']);
    expect(answer.candidates[0].airports[0].iata).toBe('UAQ');
    expect(answer.reason).toBe('multi-country');
  });

  it('dedupes the suggestions of an unknown answer the same way', async () => {
    const serverAnswer: LocationAnswer = {
      status: 'unknown',
      suggestions: [
        candidate({ placeId: 'adm:AR.18', kind: 'region' }),
        candidate({ placeId: 'gn:3837213' }),
      ],
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => serverAnswer,
    }) as unknown as typeof fetch;

    const answer = await resolveLocation('San Juann');
    expect(answer.status === 'unknown' && answer.suggestions.map((s) => s.placeId)).toEqual([
      'gn:3837213',
    ]);
  });

  it('keeps two cities that share a label in the server’s order', () => {
    // Only a point-like reading may displace an area-like one. Two cities
    // with one label keep the first, which is the more prominent row.
    // Checked through the hot set, where `resolveLocally` builds candidates.
    const answer = resolveLocally('Portland');
    expect(answer?.status).toBe('ambiguous');
    if (answer?.status !== 'ambiguous') return;
    expect(answer.candidates[0].label).toBe('Portland, Oregon, United States');
  });
});
