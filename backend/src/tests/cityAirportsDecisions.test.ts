/**
 * The thirteen destination-side decisions in `data/cityAirports.ts`, locked in.
 *
 * `cityAirports.ts` is the last hand-written lookup table left. It answers the
 * DESTINATION side — city name to one IATA code that `getIataCode` hands to
 * Duffel as a search endpoint — and the resolver answers the same question as
 * `metro ?? airports[0]`. Measured over all 169 keys, the resolver reproduced
 * 156 of them; the other 13 needed a person to decide which answer is right,
 * because they are metro-code-versus-single-airport calls and the data cannot
 * settle them. Seven went to the resolver, three to the table (and are now
 * carried by the curated layer), two stay hand-written, and `washington` was
 * already decided by a curated alias before this pass.
 *
 * This suite is the decisions as runnable evidence. It does three things:
 *
 *  1. asserts each of the 13 outcomes individually, in the terms that decided
 *     it — the airport a traveller would actually fly into, not the data shape;
 *  2. re-measures the WHOLE table on every run, so the set of entries the
 *     resolver cannot reproduce is a committed list rather than a memory. A
 *     14th disagreement fails this suite instead of being discovered when
 *     someone deletes the file;
 *  3. holds the measured COST of the two decisions that were left open, so
 *     that closing one is a deliberate act: the `moscow` tests fail if a
 *     curated alias is added, because the Moscow, Idaho rescue they assert is
 *     exactly what such an alias would cost.
 *
 * NEGATIVE CONTROLS. Vacuous tests have shipped in this repo before, and the
 * failure mode here is specific: a suite that tests "the table and the
 * resolver agree" passes trivially against an artifact that answers nothing,
 * because an empty artifact reproduces nothing and a census with no entries
 * disagrees about nothing. Four guards:
 *
 *  - `expectDestination` THROWS when a query resolves to nothing, and a test
 *    proves it throws. Every single-case assertion goes through it.
 *  - the census asserts a COUNT as well as a set: 176 of 194 reproduced. An
 *    empty or truncated artifact fails it, and so does an empty table.
 *  - the census comparator is re-run over a deliberately corrupted copy of
 *    the table, and is required to report the corruption. A comparator that
 *    always returns the same two keys cannot pass that.
 *  - the two hand-written cases assert a DISAGREEMENT, which an artifact that
 *    answers nothing cannot produce either, since `expectDestination` would
 *    throw first.
 */

import { CITY_AIRPORTS, getStaticIata } from '../data/cityAirports';
import { locationArtifact } from '../data/locationArtifact';
import { retiredAnswer } from '../data/retiredOriginAirports';
import { buildIndex } from '../services/location/buildIndex';
import { resolve } from '../services/location/resolve';
import { resolveOriginAirports, setOriginIndex } from '../services/location/originAirports';
import { locateCode, resolveDestinationIata } from '../services/location/destinationAirport';
import type { Place, Resolution } from '../services/location/types';

const index = buildIndex(locationArtifact);

// `resolveOriginAirports` builds its own index lazily; hand it this one so the
// suite pays the 1.1 s build once.
setOriginIndex(index);

/** Moscow, Idaho — population 25,435, PUW 8.6 km away. */
const MOSCOW_IDAHO = { lat: 46.7324, lon: -117.0002 };

/**
 * The place a non-asking destination caller would land on.
 *
 * `ambiguous` takes the top candidate, which is what `fromResolution` serves
 * and what `getIataCode` would have to do: it is already spending money on
 * Duffel by the time it is called and cannot stop to ask.
 */
function chosenPlace(result: Resolution): Place | null {
  if (result.status === 'resolved') return result.place;
  if (result.status === 'ambiguous') return result.candidates[0]?.place ?? null;
  return null;
}

/**
 * The destination side's answer for a query, or null.
 *
 * `metro ?? airports[0]` is the destination contract from
 * docs/LOCATION_RESOLUTION.md: a metro code searches every airport in one
 * call, which is what a destination wants, while the origin side needs the
 * individual codes so fares can be compared per airport.
 */
function destinationIata(query: string): string | null {
  const place = chosenPlace(resolve(query, {}, index));
  if (!place) return null;
  return place.metro ?? place.airports[0]?.iata ?? null;
}

/**
 * The destination answer, or a throw naming the query.
 *
 * This is the negative control for every case below: an assertion about a
 * query the artifact cannot answer at all fails loudly instead of comparing
 * two nulls.
 */
function expectDestination(query: string): string {
  const iata = destinationIata(query);
  if (!iata) {
    throw new Error(`"${query}" resolves to nothing — the artifact cannot answer it`);
  }
  return iata;
}

/** One place by id, or a throw. */
function place(id: string): Place {
  const found = locationArtifact.places.find((p) => p.id === id);
  if (!found) throw new Error(`the artifact has no place ${id}`);
  return found;
}

function iatas(p: Place): string[] {
  return p.airports.map((a) => a.iata);
}

/** Every IATA code the artifact attaches to any place. */
function airportsInArtifact(): Set<string> {
  const codes = new Set<string>();
  for (const p of locationArtifact.places) for (const a of p.airports) codes.add(a.iata);
  return codes;
}

/** Keys where the resolver's destination answer differs from the table's. */
function census(table: Record<string, string> = CITY_AIRPORTS): {
  compared: number;
  reproduced: number;
  disagreed: Array<{ key: string; table: string; resolver: string | null }>;
} {
  const disagreed: Array<{ key: string; table: string; resolver: string | null }> = [];
  let compared = 0;
  for (const [key, expected] of Object.entries(table)) {
    compared++;
    const got = destinationIata(key);
    if (got !== expected) disagreed.push({ key, table: expected, resolver: got });
  }
  return { compared, reproduced: compared - disagreed.length, disagreed };
}

// ─── The things every other test here rests on ───────────────────────────────

describe('cityAirports decisions: the table and the artifact are both real', () => {
  it('is not a stub on either side', () => {
    expect(locationArtifact.places.length).toBeGreaterThan(30_000);
    // 169 when the thirteen were decided; `lagos` has since gone to the
    // resolver and 26 demo and preset keys have come in, both asserted below.
    expect(Object.keys(CITY_AIRPORTS).length).toBe(194);
    expect(getStaticIata('Kyoto')).toBeTruthy();
  });

  it('proves the destination lookup fails loudly rather than returning nothing', () => {
    expect(() => expectDestination('Zzyzx Not A Real Place')).toThrow(/resolves to nothing/);
  });
});

// ─── Seven decisions went to the resolver ────────────────────────────────────

describe('cityAirports decisions: the seven where the resolver wins', () => {
  /**
   * The table now holds the resolver's answer, so deleting the file is a
   * no-op for these keys. Both sides are asserted on every row: the table's
   * value AND the resolver's, so a future edit to either one fails here.
   */
  const AGREED: Array<[key: string, iata: string, why: string]> = [
    ['kyoto', 'OSA', 'the Osaka metro covers Kansai and the Itami shuttle'],
    ['nara', 'OSA', 'same pool as Kyoto, reached through Kansai or Itami'],
    ['kobe', 'OSA', 'Kobe Airport alone is a small domestic field'],
    ['seoul', 'SEL', 'Gimpo carries the domestic and shuttle traffic'],
    ['beijing', 'BJS', 'Daxing now carries a large share of Beijing'],
    ['siem reap', 'SAI', 'REP closed when Siem Reap-Angkor opened'],
    ['phnom penh', 'KTI', 'Phnom Penh International stopped taking flights'],
  ];

  it.each(AGREED)('"%s" is %s — %s', (key, iata) => {
    expect(getStaticIata(key)).toBe(iata);
    expect(expectDestination(key)).toBe(iata);
  });

  it('gives Kyoto, Nara and Kobe every airport a KIX-only search would drop', () => {
    // The traveller test: on a multi-city Japan trip the leg into Kyoto is
    // flown from Tokyo, and that service is overwhelmingly Haneda-Itami. A
    // destination search pinned to Kansai cannot return it.
    for (const id of ['gn:1857910', 'gn:1855612', 'gn:1859171']) {
      const p = place(id);
      expect(p.metro).toBe('OSA');
      expect(iatas(p)).toEqual(expect.arrayContaining(['KIX', 'ITM', 'UKB']));
    }
  });

  it('still leads the ORIGIN fan-out with Kansai, which is the opposite decision', () => {
    // Widening the destination must not touch the origin pin: `airports[0]`
    // is what `estimateHomeLegCost` prices permutations from, and Itami is
    // nearer than Kansai from both Kyoto (39 km vs 81) and Nara (35 vs 59).
    expect(resolveOriginAirports('kyoto').airports[0]).toBe('KIX');
    expect(resolveOriginAirports('nara').airports[0]).toBe('KIX');
    expect(place('adm:JP.22').airports[0].iata).toBe('KIX');
    expect(place('adm:JP.28').airports[0].iata).toBe('KIX');
    // Kobe is not pinned and must not be: its own airport is 8 km away.
    expect(resolveOriginAirports('kobe').airports[0]).toBe('UKB');
  });

  it('gives Seoul Gimpo and Beijing Daxing, which the gateway codes drop', () => {
    const seoul = place('gn:1835848');
    expect(seoul.metro).toBe('SEL');
    expect(iatas(seoul)).toEqual(expect.arrayContaining(['ICN', 'GMP']));
    const beijing = place('gn:1816670');
    expect(beijing.metro).toBe('BJS');
    expect(iatas(beijing)).toEqual(expect.arrayContaining(['PEK', 'PKX']));
    // And the origin side keeps the gateway in front, as the retired table had.
    expect(retiredAnswer('seoul')).toEqual(['ICN', 'GMP']);
    expect(resolveOriginAirports('seoul').airports[0]).toBe('ICN');
    expect(resolveOriginAirports('beijing').airports[0]).toBe('PEK');
  });

  it('no longer names the two Cambodian airports that stopped taking flights', () => {
    // This is the decision's evidence, not a style point: REP has no row left
    // in OurAirports at all and PNH is filed `scheduled_service: "no"`, so
    // the pipeline drops both — a search against either returns nothing.
    const live = airportsInArtifact();
    expect(live.has('REP')).toBe(false);
    expect(live.has('PNH')).toBe(false);
    expect(live.has('SAI')).toBe(true);
    expect(live.has('KTI')).toBe(true);
    expect(iatas(place('gn:1822214'))).toContain('SAI');
    expect(iatas(place('gn:1821306'))).toContain('KTI');
  });

  it('points every table value at something the artifact knows, bar the stub', () => {
    // A ratchet over the whole table rather than the 13: the next airport to
    // close fails here. `IEV` is the one documented exception, and it is
    // exempted by name so that removing the exemption is a decision.
    const live = airportsInArtifact();
    const metros = new Set(
      locationArtifact.places.map((p) => p.metro).filter((m): m is string => m !== null),
    );
    const unknown = Object.entries(CITY_AIRPORTS)
      .filter(([, iata]) => !live.has(iata) && !metros.has(iata))
      .map(([key, iata]) => `${key}=${iata}`);
    expect(unknown).toEqual(['kyiv=IEV']);
  });
});

// ─── Three decisions went to the table, and the curated layer carries them ───

describe('cityAirports decisions: the three where the table wins', () => {
  it('buenos aires is the CITY and keeps the BUE metro code', () => {
    expect(getStaticIata('buenos aires')).toBe('BUE');
    expect(expectDestination('buenos aires')).toBe('BUE');
    const chosen = chosenPlace(resolve('buenos aires', {}, index))!;
    // The province (adm:AR.01) used to win on prominence, because a region's
    // population is the SUM of its member cities.
    expect(chosen.id).toBe('gn:3435910');
    expect(chosen.kind).toBe('city');
    expect(chosen.curatedAliases.map((a) => a.toLowerCase())).toContain('buenos aires');
    expect(place('adm:AR.01').metro).toBeNull();
  });

  it('prices Buenos Aires from Ezeiza and Aeroparque, not from a beach strip', () => {
    // The origin-side half of the same decision, and the reason it is worth
    // making: from the PROVINCE centroid the third capped slot went to SST,
    // Santa Teresita, 237 km away. The retired hand-written table answered
    // EZE, AEP — the city's own two.
    const airports = resolveOriginAirports('buenos aires').airports;
    expect(airports).toEqual(['EZE', 'AEP']);
    expect(airports).not.toContain('SST');
    expect(retiredAnswer('buenos aires')).toEqual(['EZE', 'AEP']);
  });

  it('leaves the province reachable, so the alias suppresses no real question', () => {
    // A curated alias narrows a key, and the cost has to be bounded: the
    // province is still a qualifier and still answerable by its full name.
    const province = chosenPlace(resolve('buenos aires province', {}, index))!;
    expect(province.id).toBe('adm:AR.01');
    const mdq = chosenPlace(resolve('mar del plata, buenos aires', {}, index))!;
    expect(mdq.name).toBe('Mar del Plata');
    expect(mdq.airports[0].iata).toBe('MDQ');
  });

  it('reykjavik keeps REK, which no dataset carries', () => {
    expect(getStaticIata('reykjavik')).toBe('REK');
    expect(expectDestination('reykjavik')).toBe('REK');
    const p = place('gn:3413829');
    expect(p.metro).toBe('REK');
    // Keflavík leads for an origin — it is the gateway and outranks RKV — but
    // Reykjavík Domestic has to be IN the pool, because the inter-Iceland leg
    // from Akureyri lands there and a KEF-only search cannot return it.
    expect(iatas(p)).toEqual(['KEF', 'RKV']);
    expect(resolveOriginAirports('reykjavik').airports[0]).toBe('KEF');
  });

  it('bucharest keeps BUH and stops leading with Băneasa', () => {
    expect(getStaticIata('bucharest')).toBe('BUH');
    expect(expectDestination('bucharest')).toBe('BUH');
    const city = place('gn:683506');
    expect(city.metro).toBe('BUH');
    // BBU (7.9 km) led OTP (15.5 km) on distance with both filed
    // large_airport. Băneasa is the business-aviation field; Henri Coandă is
    // the country's gateway, and it must lead both the city and the region.
    expect(city.airports[0].iata).toBe('OTP');
    expect(iatas(city)).toContain('BBU');
    expect(place('adm:RO.10').airports[0].iata).toBe('OTP');
    expect(resolveOriginAirports('bucharest').airports[0]).toBe('OTP');
  });

  it('answers the three metro codes themselves, which were unreachable before', () => {
    // A metro code is indexed as a key, so authoring one also makes `BUE`,
    // `REK` and `BUH` typeable — the shape `LAX` already worked in.
    expect(chosenPlace(resolve('BUE', {}, index))!.id).toBe('gn:3435910');
    expect(chosenPlace(resolve('REK', {}, index))!.id).toBe('gn:3413829');
    expect(chosenPlace(resolve('BUH', {}, index))!.id).toBe('gn:683506');
  });
});

// ─── Two decisions are not made, and the table cannot go until they are ──────

describe('cityAirports decisions: the two that stay hand-written', () => {
  it('moscow: the resolver answers Sheremetyevo alone, so the entry is load-bearing', () => {
    expect(getStaticIata('moscow')).toBe('MOW');
    const resolver = expectDestination('moscow');
    expect(resolver).toBe('SVO');
    expect(resolver).not.toBe(getStaticIata('moscow'));
    // WHY it answers SVO: the top candidate is the federal-city REGION, and a
    // region never carries a metro code. The city row that would answer MOW
    // exists and is shadowed by it.
    const chosen = chosenPlace(resolve('moscow', {}, index))!;
    expect(chosen.id).toBe('adm:RU.48');
    expect(chosen.metro).toBeNull();
    expect(place('gn:524901').metro).toBe('MOW');
  });

  it('moscow: the question a curated alias would suppress is real and answered today', () => {
    // THE MEASURED COST, and the reason this decision was left open. If
    // someone adds `{ alias: 'moscow', target: Moscow RU }` to curated.ts,
    // both assertions below fail — which is the point. Idaho's Moscow has its
    // own airport 8.6 km away, and the resolver gets it right from
    // coordinates, for free, today.
    const bare = resolve('moscow', {}, index);
    expect(bare.status).toBe('ambiguous');
    if (bare.status === 'ambiguous') {
      expect(bare.reason).toBe('multi-country');
      expect(bare.candidates.map((c) => c.place.country)).toContain('US');
    }
    const local = resolve('moscow', { userLatLon: MOSCOW_IDAHO }, index);
    expect(local.status).toBe('resolved');
    if (local.status === 'resolved') {
      expect(local.place.country).toBe('US');
      expect(local.place.admin).toBe('ID');
      expect(local.place.airports[0].iata).toBe('PUW');
    }
  });

  it('kyiv: nothing in the artifact can answer it, and the build refuses to pin it', () => {
    expect(getStaticIata('kyiv')).toBe('IEV');
    expect(destinationIata('kyiv')).toBeNull();
    // The city is in the artifact; its airports are not, because OurAirports
    // files both IEV and KBP with `scheduled_service: "no"`. So the answer is
    // `unknown` with Kyiv itself as the near miss — the resolver knows the
    // place and knows there is no flight.
    const result = resolve('kyiv', {}, index);
    expect(result.status).toBe('unknown');
    if (result.status === 'unknown') {
      expect(result.suggestions.map((s) => s.place.name)).toContain('Kyiv');
    }
    const live = airportsInArtifact();
    expect(live.has('IEV')).toBe(false);
    expect(live.has('KBP')).toBe(false);
  });
});

// ─── The demo towns and the preset cities ────────────────────────────────────

describe('cityAirports decisions: the demo towns and preset cities', () => {
  /**
   * Ten rows hold the artifact's own answer. Both sides are asserted, so a
   * rebuild that moves one of these demo cities fails here.
   */
  const AGREED: Array<[key: string, iata: string]> = [
    ['bath', 'BRS'],
    ['sintra', 'LIS'],
    ['siena', 'FLR'],
    ['lucerne', 'ZRH'],
    ['cozumel', 'CZM'],
    ['la fortuna', 'SJO'],
    ['luxor', 'LXR'],
    ['krabi', 'KBV'],
    ['taichung', 'RMQ'],
    ['tainan', 'TNN'],
  ];

  it.each(AGREED)('"%s" is %s, and so is the artifact', (key, iata) => {
    expect(getStaticIata(key)).toBe(iata);
    expect(expectDestination(key)).toBe(iata);
  });

  /**
   * Thirteen keys the artifact cannot answer: the reason each row exists.
   * The code is asserted to be a live airport or metro in the right country,
   * which is the whole of what Duffel's guesses got wrong.
   */
  const UNANSWERED: Array<[key: string, iata: string, country: string]> = [
    ['interlaken', 'ZRH', 'CH'],
    ['zermatt', 'ZRH', 'CH'],
    ['cinque terre', 'PSA', 'IT'],
    ['positano', 'NAP', 'IT'],
    ['lake como', 'MIL', 'IT'],
    ['hallstatt', 'SZG', 'AT'],
    ['hakone', 'TYO', 'JP'],
    ['mount cook village', 'ZQN', 'NZ'],
    ['monteverde', 'SJO', 'CR'],
    ['manuel antonio', 'SJO', 'CR'],
    ['flåm', 'BGO', 'NO'],
    ['flam', 'BGO', 'NO'],
    ['koh phi phi', 'HKT', 'TH'],
  ];

  it.each(UNANSWERED)('"%s" is %s, in %s, where the artifact has nothing', (key, iata, country) => {
    expect(getStaticIata(key)).toBe(iata);
    expect(destinationIata(key)).toBeNull();
    expect(locateCode(iata)?.country).toBe(country);
  });

  it('answers Flåm however its å arrives', () => {
    expect(getStaticIata('Flåm')).toBe('BGO');
    expect(getStaticIata('Flåm')).toBe('BGO'); // a + combining ring
    expect(getStaticIata('Flam')).toBe('BGO');
  });

  it('naxos: the island\'s own JNX, not Santorini\'s JTR across the sea', () => {
    expect(getStaticIata('naxos')).toBe('JNX');
    expect(expectDestination('naxos')).toBe('JTR');
    // The artifact's evidence, and why it cannot see the problem: JTR leads
    // on rank (large over small) at 79 km; JNX is 2.8 km. Nothing in the data
    // says there is sea in between.
    const naxos = place('gn:256632');
    const km = (iata: string) => naxos.airports.find((a) => a.iata === iata)?.km ?? NaN;
    expect(naxos.airports[0].iata).toBe('JTR');
    expect(km('JTR')).toBeGreaterThan(70);
    expect(km('JNX')).toBeLessThan(5);
  });

  it('playa del carmen: Cancún by road, not Cozumel by ferry', () => {
    expect(getStaticIata('playa del carmen')).toBe('CUN');
    expect(expectDestination('playa del carmen')).toBe('CZM');
    // Both "large"; CZM won on distance, and CZM is Cozumel's own airport.
    expect(place('gn:3530103').airports[0].iata).toBe('CZM');
    const playa = place('gn:3521342');
    expect(playa.airports.map((a) => a.iata).slice(0, 2)).toEqual(['CZM', 'CUN']);
  });

  it('oxford: London, where a 0.8 km tie handed it to Luton', () => {
    expect(getStaticIata('oxford')).toBe('LON');
    expect(expectDestination('oxford')).toBe('LTN');
    const oxford = place('gn:2640729');
    const [first, second] = oxford.airports;
    expect([first.iata, second.iata]).toEqual(['LTN', 'LHR']);
    expect(Math.abs(first.km - second.km)).toBeLessThan(1);
    // The metro code covers Heathrow and Gatwick, where the coaches run.
    const london = chosenPlace(resolve('london', {}, index))!;
    expect(london.metro).toBe('LON');
    expect(iatas(london)).toEqual(expect.arrayContaining(['LHR', 'LGW']));
  });

  it('guadalajara: no row, because the trip has to be able to say Spain', () => {
    expect(getStaticIata('guadalajara')).toBeUndefined();
    expect(resolveDestinationIata('Guadalajara')).toBe('GDL');
    expect(resolveDestinationIata('Guadalajara', { tripDestinationNames: ['Madrid'] })).toBe('MAD');
  });
});

// ─── A row removed, so the trip can decide ───────────────────────────────────

describe('cityAirports decisions: lagos goes to the resolver', () => {
  /**
   * `getIataCode` now asks the artifact after this table, and a caller may
   * pass the trip's other stops. A row is consulted FIRST and the trip is not
   * allowed to overrule it, so a row that only repeats the artifact's answer
   * for an ambiguous name does nothing but silence the trip.
   */
  it('has no row, and bare Lagos still answers LOS', () => {
    expect(getStaticIata('lagos')).toBeUndefined();
    // Both the raw census reading and the served one: Nigeria, as the row said.
    expect(expectDestination('lagos')).toBe('LOS');
    expect(resolveDestinationIata('Lagos')).toBe('LOS');
  });

  it('answers FAO when the trip is in Portugal', () => {
    // Lagos, Faro is 190 km from Lisbon and 63 km from Faro airport, which
    // leads its list as the larger field over Portimão (10 km).
    expect(resolveDestinationIata('Lagos', { tripDestinationNames: ['Lisbon', 'Porto'] })).toBe('FAO');
    expect(resolveDestinationIata('Lagos', { tripDestinationNames: ['Lisbon'] })).toBe('FAO');
  });

  it('keeps Nigeria when the trip is not near Portugal', () => {
    // Paris -> Lagos is a real route to Nigeria. The resolver's trip rule
    // would pick Portugal from Paris (1,700 km against 4,700), but a reading
    // more than 1,000 km from every other stop is not taken on that evidence.
    expect(resolveDestinationIata('Lagos', { tripDestinationNames: ['Paris'] })).toBe('LOS');
    expect(resolveDestinationIata('Lagos', { tripDestinationNames: ['Accra'] })).toBe('LOS');
  });
});

// ─── The whole table, re-measured on every run ───────────────────────────────

/** Every key whose row the artifact does not reproduce, sorted. */
const LOAD_BEARING = [
  'cinque terre',
  'flam',
  'flåm',
  'hakone',
  'hallstatt',
  'interlaken',
  'koh phi phi',
  'kyiv',
  'lake como',
  'manuel antonio',
  'monteverde',
  'moscow',
  'mount cook village',
  'naxos',
  'oxford',
  'playa del carmen',
  'positano',
  'zermatt',
];

describe('cityAirports decisions: the census', () => {
  it('reproduces 176 of the 194 entries, and names the eighteen it does not', () => {
    // The ratchet. A new disagreement — an upstream reclassification, a new
    // airport, a changed pin — fails here with the key named, instead of
    // surfacing when someone deletes the table.
    //
    // The eighteen are every row that is load-bearing: the two hand-written
    // cases, and sixteen keys from the demo-and-preset pass — thirteen the
    // artifact cannot answer and three it answers wrongly. Each is asserted
    // on its own terms above.
    //
    // Non-vacuous twice over: the count fails against a truncated artifact,
    // and against an empty one EVERY key would be listed rather than these.
    const { compared, reproduced, disagreed } = census();
    expect(compared).toBe(194);
    expect(reproduced).toBe(176);
    expect(disagreed.map((d) => d.key).sort()).toEqual(LOAD_BEARING);
  });

  it('would notice one more disagreement — the comparator is not hard-coded', () => {
    // Negative control on the census itself: corrupt one entry and require it
    // to be reported. A comparator that always returned the same two keys, or
    // one that compared nothing, cannot pass this.
    const corrupted = { ...CITY_AIRPORTS, kyoto: 'ZZZ', barcelona: 'ZZZ' };
    const { disagreed } = census(corrupted);
    expect(disagreed.map((d) => d.key).sort()).toEqual(
      [...LOAD_BEARING, 'barcelona', 'kyoto'].sort(),
    );
    expect(disagreed.find((d) => d.key === 'kyoto')?.resolver).toBe('OSA');
  });
});
