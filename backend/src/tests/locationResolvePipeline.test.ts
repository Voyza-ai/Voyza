/**
 * The pipeline's mechanics: pruning, narrowing, the decision ladder, and the
 * shape of the two questions.
 *
 * Negative controls per suite are named in each `describe`.
 */

import { buildIndex } from '../services/location/buildIndex';
import { resolve, createResolver } from '../services/location/resolve';
import { DEFAULT_OPTIONS } from '../services/location/options';
import { FIXTURE_ARTIFACT, POINTS } from '../services/location/fixtures/artifact';
import type { Resolution } from '../services/location/types';

const index = buildIndex(FIXTURE_ARTIFACT);
const run = (input: string, context = {}, options = {}): Resolution =>
  resolve(input, context, index, options);

const ids = (result: Resolution): string[] => {
  if (result.status === 'ambiguous') return result.candidates.map((c) => c.place.id);
  if (result.status === 'unknown') return result.suggestions.map((c) => c.place.id);
  return [result.place.id];
};

/**
 * Asserts the status as well as the place.
 *
 * `ids` alone is not enough and a mutation proved it: an `unknown` whose
 * suggestions happen to start with the right place looked identical to a
 * `resolved`, so a test using `ids` survived a mutation that turned answers
 * into questions.
 */
const resolvedIds = (result: Resolution): string[] => {
  expect(result.status).toBe('resolved');
  return ids(result);
};

/**
 * Negative control: every case fails if `prune` is removed — each of these
 * inputs becomes an ambiguous question instead of an answer.
 */
describe('step 5 — pruning candidates with no airport in range', () => {
  // `via` is asserted, not just the answer: without the prune step these still
  // come out right, by prominence, and the test would be vacuous. 'exact-unique'
  // is only reachable when the twin has actually been removed.
  it('removes the airportless twin and resolves what is left', () => {
    const buffalo = run('Buffalo'); // not Buffalo MN
    expect(ids(buffalo)).toEqual(['p-buffalo-ny']);
    expect(buffalo.status === 'resolved' && buffalo.via).toBe('exact-unique');

    const providence = run('Providence'); // not Providence UT
    expect(ids(providence)).toEqual(['p-providence-ri']);
    expect(providence.status === 'resolved' && providence.via).toBe('exact-unique');
  });

  it('removes a candidate whose only airport is out of range', () => {
    // Hartford WI lists MKE at 210 km, past the 200 km rule.
    const result = run('Hartford');
    expect(ids(result)).toEqual(['p-hartford-ct']);
    expect(result.status === 'resolved' && result.via).toBe('exact-unique');
  });

  it('is a narrowing, not a filter: the pruned place can still be the answer', () => {
    // Paris KY has no airport at all, so the explicit qualifier reaches it —
    // pruning does not make a named place unreachable — but the answer cannot
    // be `resolved`, because `resolved` promises airports and there are none.
    // The pipeline's artifact carries 2,470 such places.
    const result = run('Paris, KY');
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') return;
    expect(result.suggestions.map((s) => s.place.id)).toEqual(['p-paris-ky']);
    expect(result.suggestions[0].airports).toEqual([]);
  });

  it('never answers `resolved` with an empty airport list', () => {
    // `airports[0]` is what estimateHomeLegCost prices from, so an empty list
    // is the original bug: a trip with no home flight and no explanation.
    for (const input of ['Paris, KY', 'Berlin, NH', 'Bogota, NJ', 'Providence, UT']) {
      const result = run(input);
      expect(result.status).not.toBe('resolved');
    }
  });

  it('keeps a far airport in the answer rather than hiding it', () => {
    const result = run('Hartford, WI');
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.airports[0].iata).toBe('MKE');
    expect(result.airports[0].km).toBe(210);
  });

  it('judges a state or country by having any airport, not by centroid range', () => {
    // The centre of a large country is far from everything. Measuring range
    // from it would answer `Georgia` with the US state every time.
    const result = run('Georgia');
    expect(result.status).toBe('ambiguous');
    expect(ids(result)).toEqual(expect.arrayContaining(['c-ge', 's-us-ga']));
  });

  it('respects a widened range', () => {
    // At 200 km Hartford WI is pruned and CT wins uncontested. At 250 km it
    // joins the contest and CT has to win it on prominence instead, which is
    // how we know the range is doing the work rather than the name.
    const tight = run('Hartford');
    const wide = run('Hartford', {}, { maxAirportKm: 250 });
    expect(tight.status === 'resolved' && tight.via).toBe('exact-unique');
    expect(wide.status === 'resolved' && wide.via).toBe('prominence');
    expect(ids(wide)).toEqual(['p-hartford-ct']);
  });
});

/**
 * Negative control: fails if the qualifier pass walks left to right, or if a
 * failed narrowing falls back to the unqualified candidates.
 */
describe('steps 2-4 — the qualifier pass, right to left', () => {
  it('consumes a trailing chain of qualifiers', () => {
    expect(resolvedIds(run('Paris, Texas, USA'))).toEqual(['p-paris-tx']);
    expect(resolvedIds(run('Paris, Île-de-France, France'))).toEqual(['p-paris-fr']);
  });

  it('ignores a segment that is not a qualifier at all', () => {
    // A postcode will never be in the qualifier index, and the traveller still
    // means Paris, France.
    expect(resolvedIds(run('Paris, 75001, France'))).toEqual(['p-paris-fr']);
  });

  it('never consumes the only segment, so a bare state still resolves', () => {
    expect(resolvedIds(run('France'))).toEqual(['c-fr']);
    expect(resolvedIds(run('Texas'))).toEqual(['s-us-tx']);
    expect(resolvedIds(run('NY'))).toEqual(['s-us-ny']);
    // The owner's rule: a bare state offers every airport that serves it.
    const ny = run('NY');
    expect(ny.status === 'resolved' && ny.airports.map((a) => a.iata)).toEqual([
      'SYR',
      'ALB',
      'JFK',
    ]);
  });

  it('prefers the city over the region around it, comparing no populations', () => {
    // A region's population is the SUM of its member cities, not a census
    // figure, so scoring it against a city's population would make every
    // region outrank every city inside it. The containment rule decides
    // instead: "New York" is the city, which is inside the state.
    expect(resolvedIds(run('New York'))).toEqual(['m-nyc']);
    const result = run('New York');
    expect(result.status === 'resolved' && result.airports.map((a) => a.iata)).toEqual([
      'JFK',
      'EWR',
      'LGA',
    ]);
  });

  it('still asks when a city and a region merely share a name', () => {
    // Washington DC is not inside Washington state: these are two different
    // places with one name, so the containment rule must not fire.
    const result = run('Washington');
    expect(result.status).toBe('ambiguous');
    expect(ids(result)).toEqual(expect.arrayContaining(['s-us-wa', 'p-washington-dc']));
    // Context still separates them.
    expect(resolvedIds(run('Washington', { userLatLon: POINTS.seattle }))).toEqual(['s-us-wa']);
  });

  it('asks rather than guessing when a qualifier reading is itself ambiguous', () => {
    // Bare DE is Delaware or Germany with nothing to separate them.
    const result = run('DE');
    expect(result.status).toBe('ambiguous');
    expect(ids(result)).toEqual(expect.arrayContaining(['c-de', 's-us-de']));
  });

  it('returns unknown, with the real places as suggestions, when the qualifier contradicts the head', () => {
    const result = run('Paris, Japan');
    expect(result.status).toBe('unknown');
    // Offering them is a question. Applying one would be a guess.
    expect(ids(result)).toEqual(expect.arrayContaining(['p-paris-fr']));
    expect(result.status === 'unknown' && result.suggestions[0].editDistance).toBeUndefined();
  });

  it('never lets a city name after a comma narrow or veto the head', () => {
    // A city key is not a qualifier, so it cannot consume the segment. If it
    // could, this would narrow Buffalo by Paris, match nothing and come back
    // unknown — which is how an AI parser handing back two cities would lose
    // the one place it got right.
    expect(resolvedIds(run('Buffalo, Paris'))).toEqual(['p-buffalo-ny']);
    expect(resolvedIds(run('Baton Rouge, Los Angeles'))).toEqual(['p-batonrouge']);
  });

  it('matches a state qualifier by code or by spelled-out admin value', () => {
    // The contract does not promise that a state place's `admin` is spelled
    // the same way as the code its cities carry, so both must work.
    expect(resolvedIds(run('Buffalo, New York'))).toEqual(['p-buffalo-ny']);
    expect(resolvedIds(run('Buffalo, NY'))).toEqual(['p-buffalo-ny']);
  });
});

/**
 * Negative control: fails if rules 2 and 3 are swapped, if the multi-country
 * rule is moved after the margin, or if the margin compares the top two
 * candidates instead of counting candidates within the margin.
 */
describe('step 7 — the decision ladder, in order', () => {
  it('1. a qualifier pins the answer', () => {
    const result = run('Vancouver, WA');
    expect(result.status === 'resolved' && result.via).toBe('qualifier-pinned');
  });

  it('2. the traveller decides a cross-country contest', () => {
    // Portland is 15 km from Vancouver WA and 530 km from Vancouver BC.
    const result = run('Vancouver', { userLatLon: POINTS.portland });
    expect(ids(result)).toEqual(['p-vancouver-wa']);
    expect(result.status === 'resolved' && result.via).toBe('user-location');
  });

  it('2. but only when one candidate is clearly nearest', () => {
    // Seattle is 190 km from Vancouver BC and 220 km from Vancouver WA. Near
    // both, so it separates neither, and the multi-country rule takes over.
    const result = run('Vancouver', { userLatLon: POINTS.seattle });
    expect(result.status).toBe('ambiguous');
    expect(result.status === 'ambiguous' && result.reason).toBe('multi-country');
  });

  it('2. and only within reach of the traveller', () => {
    // The bug this caught: from New York, Paris TX (2,100 km) beats Paris FR
    // (5,800 km) on any ratio, so `Paris` typed in Manhattan resolved to a
    // town of 24,782 people. Out of reach now decides nothing.
    const result = run('Paris', { userLatLon: POINTS.newYork });
    expect(result.status).toBe('ambiguous');
    // Raise the radius past New York and the old behaviour comes back, which
    // is how we know the radius is what changed it.
    expect(resolvedIds(run('Paris', { userLatLon: POINTS.newYork }, { userLocalKm: 3000 }))).toEqual([
      'p-paris-tx',
    ]);
  });

  it('3. the trip centroid decides, tolerating destinations it cannot resolve', () => {
    // Rome is ambiguous (Italy and Georgia) and Florence is ambiguous (Italy
    // and South Carolina); both still contribute a position.
    const result = run('Paris', { tripDestinationNames: ['Rome', 'Florence', 'Nowhereville'] });
    expect(ids(result)).toEqual(['p-paris-fr']);
    expect(result.status === 'resolved' && result.via).toBe('trip-context');
  });

  it('3. an unresolvable trip list leaves the ladder where it was', () => {
    const result = run('Paris', { tripDestinationNames: ['Nowhereville', '東京都'] });
    expect(result.status).toBe('ambiguous');
  });

  it('4. more than one country always asks, whatever the prominence gap', () => {
    // Paris has the WIDEST measured top-2 gap in the ambiguous set (0.255),
    // wider than Buffalo (0.164) which resolves. No scalar margin can do both.
    const paris = run('Paris');
    expect(paris.status).toBe('ambiguous');
    expect(paris.status === 'ambiguous' && paris.reason).toBe('multi-country');
    expect(ids(run('Buffalo'))).toEqual(['p-buffalo-ny']);
  });

  it('5. the margin resolves a clear same-country winner', () => {
    const result = run('Portland');
    expect(ids(result)).toEqual(['p-portland-or']);
    expect(result.status === 'resolved' && result.via).toBe('prominence');
  });

  it('5. and asks when more than one candidate sits inside the margin', () => {
    const result = run('Springfield');
    expect(result.status).toBe('ambiguous');
    expect(result.status === 'ambiguous' && result.reason).toBe('near-tie');
  });

  it('5. gates on the count within the margin, not on the top two', () => {
    // Thirty Springfields and two Portlands must be judged by one statistic.
    // With the margin at zero, every contest has exactly one top candidate.
    expect(resolvedIds(run('Springfield', {}, { nearTieEpsilon: 0 }))).toEqual(['p-springfield-mo']);
    // With the margin wide, even a clear winner becomes a question.
    expect(run('Portland', {}, { nearTieEpsilon: 0.9 }).status).toBe('ambiguous');
  });

  it('does not use the traveller\'s country as a tiebreaker', () => {
    // A traveller in the US typing Paris means France far more often than
    // Texas. userCountry is deliberately not a rule.
    const result = run('Paris', { userCountry: 'US' });
    expect(result.status).toBe('ambiguous');
  });
});

/**
 * Negative control: fails if the cap or the grouping is removed — the raw
 * candidate list for Springfield is five long in this fixture and 30+ in real
 * data.
 */
describe('the ambiguous list is grouped, capped and distanced', () => {
  it('ranks best-first', () => {
    const result = run('Springfield');
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    expect(result.candidates[0].place.id).toBe('p-springfield-mo');
  });

  it('groups by country, then by admin region', () => {
    const result = run('San Jose');
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    const countries = result.candidates.map((c) => c.place.country);
    // All of one country's candidates before the next country's.
    expect(countries).toEqual([...countries].sort((a, b) => countries.indexOf(a) - countries.indexOf(b)));
    expect(new Set(countries).size).toBe(2);
  });

  it('caps the list and caps each admin region inside it', () => {
    const result = run('Springfield', {}, { maxCandidates: 3 });
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    expect(result.candidates.length).toBe(3);

    const perAdmin = run('Springfield', {}, { maxPerAdminGroup: 1, maxCandidates: 99 });
    if (perAdmin.status !== 'ambiguous') throw new Error('expected a question');
    const admins = perAdmin.candidates.map((c) => c.place.admin);
    expect(new Set(admins).size).toBe(admins.length);
  });

  it('never repeats a name inside a label', () => {
    const result = run('Georgia');
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    expect(result.candidates.map((c) => c.label).sort()).toEqual([
      'Georgia',
      'Georgia, United States',
    ]);
  });

  it('labels each candidate so the question can be asked', () => {
    const result = run('Paris');
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    expect(result.candidates.map((c) => c.label)).toEqual([
      'Paris, Île-de-France, France',
      'Paris, Texas, United States',
    ]);
  });

  it('carries the distance as a number, and keeps the label a clean name', () => {
    const result = run('Paris', { userLatLon: POINTS.newYork });
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    const [first] = result.candidates;
    // The label is a distinguisher, not a sentence: formatting "2,057 km away"
    // is the UI's job in the UI's locale, and a question is easier to answer
    // sorted by distance than by prominence.
    expect(first.label).toBe('Paris, Île-de-France, France');
    expect(first.distanceKm).toBeGreaterThan(5_000);
    expect(first.distanceKm).toBeLessThan(6_500);
    for (const candidate of result.candidates) {
      expect(typeof candidate.distanceKm).toBe('number');
    }
  });

  it('omits the distance when there is nothing to measure from', () => {
    const result = run('Paris');
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    for (const candidate of result.candidates) {
      expect(candidate.distanceKm).toBeUndefined();
    }
  });

  it('carries the airports on every candidate, in the artifact order', () => {
    const result = run('Paris');
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    expect(result.candidates[0].airports.map((a) => a.iata)).toEqual(['CDG', 'ORY', 'BVA']);
  });
});

describe('input handling', () => {
  it('returns unknown for nothing, never throws', () => {
    for (const input of ['', '   ', ',,,']) {
      expect(run(input)).toEqual({ status: 'unknown', suggestions: [] });
    }
  });

  it('truncates a hostile input instead of scanning it', () => {
    const long = `${'Paris'}${'x'.repeat(5000)}`;
    expect(run(long).status).toBe('unknown');
    expect(DEFAULT_OPTIONS.maxInputLength).toBeLessThan(500);
  });

  it('is case and whitespace insensitive', () => {
    for (const input of ['  pArOs ', 'PAROS', 'paros']) {
      expect(resolvedIds(run(input))).toEqual(['p-paros']);
    }
  });

  it('exposes the same behaviour through createResolver', () => {
    const resolver = createResolver(index);
    expect(resolver.resolve('Buffalo, NY').status).toBe('resolved');
    expect(resolver.resolve('Paris').status).toBe('ambiguous');
  });

  it('never mutates the artifact or the index', () => {
    const before = JSON.stringify(FIXTURE_ARTIFACT.places.slice(0, 20));
    const sizes = [index.exact.size, index.qualifier.size, index.iata.size];
    run('Paris', { tripDestinationNames: ['Rome'] });
    run('Springfield');
    run('Zzzz');
    expect(JSON.stringify(FIXTURE_ARTIFACT.places.slice(0, 20))).toBe(before);
    expect([index.exact.size, index.qualifier.size, index.iata.size]).toEqual(sizes);
  });
});

/**
 * Key provenance — the narrowing that `KeyTier` exists for.
 *
 * Every fixture row these cases touch was added because the REAL artifact
 * behaves this way, so the fixture and `locationResolveArtifact.test.ts` test
 * the same rule from both ends: readable cases here, 36,009 real places there.
 *
 * Negative control: every case in this suite fails if `narrowToBestTier` stops
 * filtering (verified by mutation — it takes six tests across the two suites
 * down with it).
 */
describe('key provenance — a name outranks another place’s alternate name', () => {
  it('does not offer Lomé as a Rome', () => {
    // 'Rome' is a dataset alias on Lomé and its own name on three cities. In
    // the real artifact the prominence gap between Lomé and Rome, Italy is
    // 0.001, so nothing but provenance could ever have separated them.
    const result = run('Rome');
    expect(ids(result)).not.toContain('p-lome-tg');
    expect(ids(result)).toContain('p-rome-it');
  });

  it('still finds Lomé by its own name', () => {
    // The narrowing must not cost the place its own identity: it loses the
    // contest for `Rome`, it does not disappear.
    expect(resolvedIds(run('Lome'))).toEqual(['p-lome-tg']);
    expect(resolvedIds(run('Lomé'))).toEqual(['p-lome-tg']);
  });

  it('does not answer Venice with the more prominent Dayton', () => {
    // Dayton outranks both real Venices on prominence, so before provenance
    // existed it won outright — and poisoned any trip centroid built from it.
    const result = run('Venice');
    expect(ids(result)).not.toContain('p-dayton-oh');
    expect(ids(result)).toEqual(expect.arrayContaining(['p-venice-it', 'p-venice-fl']));
  });

  it('reads a trip through Florence and Venice as the Italian one', () => {
    const result = run('Rome', { tripDestinationNames: ['Florence', 'Venice'] });
    expect(resolvedIds(result)).toEqual(['p-rome-it']);
    if (result.status === 'resolved') expect(result.via).toBe('trip-context');
  });

  it('lets a curated alias beat an official code on the same letters', () => {
    // `LA` is Los Angeles by decision, Louisiana and Laos by ISO/USPS code.
    // A code is canonical and still loses, because curation is a choice
    // someone made about what travellers mean.
    const result = run('la');
    expect(resolvedIds(result)).toEqual(['p-losangeles']);
    if (result.status === 'resolved') expect(result.via).toBe('curated-alias');
  });

  it('does not let a curated alias leak into the qualifier pass', () => {
    // The guard that makes `Baton Rouge, LA` Louisiana is about KIND, not
    // tier, and curation must not create a back door into it.
    expect(resolvedIds(run('Baton Rouge, LA'))).toEqual(['p-batonrouge']);
  });

  it('narrows the field without deciding it', () => {
    // The point of the narrowing is to remove places that never had a claim,
    // not to pick a winner. Dayton goes; the two real Venices both own the
    // name, so the question survives and the traveller still chooses.
    const result = run('Venice');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') expect(result.reason).toBe('multi-country');
  });

  it('leaves a same-name contest to prominence when both names are the places’ own', () => {
    // Delaware the state against Delaware, Ohio: both canonical, so provenance
    // has nothing to say and the near-tie margin decides. Here the state wins
    // outright because the fixture's gap is wide.
    //
    // In the REAL artifact that gap is 0.033 and this same input ASKS, which
    // `locationResolveArtifact.test.ts` asserts. Both outcomes are correct for
    // their data, and that is the distinction worth keeping visible: this rule
    // is a measurement about two places, not a rule about states and cities.
    const result = run('Delaware');
    expect(resolvedIds(result)).toEqual(['s-us-de']);
    if (result.status === 'resolved') expect(result.via).toBe('prominence');
  });
});
