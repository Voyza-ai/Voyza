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

  it('is a narrowing, not a filter: it never empties the set', () => {
    // Paris KY has no airport at all, and with an explicit qualifier it is
    // still the right answer — the distance is shown, the traveller decides.
    const result = run('Paris, KY');
    expect(result.status).toBe('resolved');
    expect(ids(result)).toEqual(['p-paris-ky']);
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

  it('asks when a name is both a city and the state around it', () => {
    // "New York" is the city and the state, 250 km apart, with nothing in a
    // bare input to separate them. Context does separate them, which is the
    // ladder working rather than a special case for one name.
    expect(run('New York').status).toBe('ambiguous');
    expect(resolvedIds(run('New York', { userLatLon: POINTS.newYork }))).toEqual(['m-nyc']);
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

  it('includes the distance in the label when there is something to measure from', () => {
    const result = run('Paris', { userLatLon: POINTS.newYork });
    if (result.status !== 'ambiguous') throw new Error('expected a question');
    expect(result.candidates[0].label).toMatch(/Paris, Île-de-France, France · \d+ km away/);
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
