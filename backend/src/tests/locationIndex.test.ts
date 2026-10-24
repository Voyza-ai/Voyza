/**
 * The four indexes.
 *
 * The rule under test here is a RESTRICTION: a city key never enters
 * `qualifier`. Everything in the must-never set depends on it, so it is
 * asserted directly as well as through behaviour.
 *
 * Negative control: the `qualifier` suite fails if `QUALIFIER_KINDS` gains
 * 'city'; the `iata` suite fails if the claim rule reverts to "most prominent
 * place wins", which resolved LAX to the United States.
 */

import { buildIndex } from '../services/location/buildIndex';
import { FIXTURE_ARTIFACT } from '../services/location/fixtures/artifact';
import type { KeyTier } from '../services/location/types';

const index = buildIndex(FIXTURE_ARTIFACT);

/** Place ids under a key, provenance dropped. */
const at = (key: string): string[] => (index.exact.get(key) ?? []).map((m) => m.id);

/** The provenance a given place's match under a key carries. */
const tierAt = (key: string, id: string): KeyTier | undefined =>
  index.exact.get(key)?.find((m) => m.id === id)?.tier;

describe('exact — normalised key to place ids, multi-valued', () => {
  it('holds every spelling of one place', () => {
    for (const key of ['koln', 'koeln', 'cologne']) {
      expect(at(key)).toEqual(['p-koln']);
    }
  });

  it('holds every place sharing one name', () => {
    const ids = at('paris');
    expect(ids).toContain('p-paris-fr');
    expect(ids).toContain('p-paris-tx');
    expect(ids).toContain('p-paris-ky');
  });

  it('derives two-letter keys from the typed fields, not from aliases', () => {
    // Nothing in the fixture lists "DE" or "TX" as an alias. The index reads
    // `country` on a country place and `admin` on a state.
    expect(at('de')).toEqual(expect.arrayContaining(['c-de', 's-us-de']));
    expect(at('tx')).toEqual(['s-us-tx']);
    expect(at('ny')).toEqual(['s-us-ny']);
    // And a code is CANONICAL, so it is not outranked by another place's
    // alternate name for the same letters — only by a curated decision.
    expect(tierAt('de', 'c-de')).toBe('canonical');
    expect(tierAt('de', 's-us-de')).toBe('canonical');
  });

  it('indexes a bare state so it can offer every airport that serves it', () => {
    expect(at('new york')).toEqual(expect.arrayContaining(['s-us-ny', 'm-nyc']));
  });
});

describe('qualifier — multi-valued, and cities are excluded', () => {
  it('holds Georgia the state AND Georgia the country', () => {
    const ids = index.qualifier.get('georgia') ?? [];
    expect(ids).toContain('c-ge');
    expect(ids).toContain('s-us-ga');
    // A single-valued map could not express this, which is the wrong-continent
    // bug the contract's comment is about.
    expect(ids.length).toBe(2);
  });

  it('holds both readings of every two-letter collision in the must-never set', () => {
    const both = (key: string, countryId: string, stateId: string): void => {
      const ids = index.qualifier.get(key) ?? [];
      expect(ids).toContain(countryId);
      expect(ids).toContain(stateId);
    };
    both('de', 'c-de', 's-us-de');
    both('il', 'c-il', 's-us-il');
    both('ma', 'c-ma', 's-us-ma');
    both('la', 'c-la', 's-us-la');
    both('co', 'c-co', 's-us-co');
    both('ca', 'c-ca', 's-us-ca');
  });

  it('never lets a city key act as a qualifier', () => {
    // "LA" is a real alias of Los Angeles the city. If it were a qualifier,
    // "Baton Rouge, LA" would narrow to a city and Louisiana would lose.
    expect(index.qualifier.get('la')).not.toContain('p-losangeles');
    expect(index.qualifier.get('los angeles')).toBeUndefined();
    expect(index.qualifier.get('paris')).toBeUndefined();
    expect(index.qualifier.get('berlin')).toBeUndefined();
    // Not even a metro, whose keys are colloquial rather than administrative.
    expect(index.qualifier.get('the bay area')).toBeUndefined();
  });

  it('holds region names and codes', () => {
    expect(index.qualifier.get('ile de france')).toEqual(['r-fr-idf']);
    expect(index.qualifier.get('idf')).toEqual(['r-fr-idf']);
  });

  it('is a subset of exact', () => {
    for (const key of index.qualifier.keys()) expect(index.exact.has(key)).toBe(true);
  });
});

describe('iata — mandatory, and not optional for a reason', () => {
  it('gives a code to the city it primarily serves', () => {
    expect(index.iata.get('LAX')).toBe('p-losangeles');
    expect(index.iata.get('CDG')).toBe('p-paris-fr');
    expect(index.iata.get('BUF')).toBe('p-buffalo-ny');
    expect(index.iata.get('PAS')).toBe('p-paros');
  });

  it('gives a shared code to the place whose first airport it is', () => {
    // Los Angeles lists BUR second; Burbank lists it first.
    expect(index.iata.get('BUR')).toBe('p-burbank');
    // New York lists JFK first; Newark lists EWR first.
    expect(index.iata.get('JFK')).toBe('m-nyc');
    expect(index.iata.get('EWR')).toBe('p-newark');
  });

  it('never gives a code to a country or a state when a city claims it', () => {
    // The first version of the builder resolved LAX to the United States,
    // which legitimately lists LAX among its airports and outweighs every city.
    for (const code of ['LAX', 'ORD', 'JFK', 'CDG', 'TLV', 'BOG', 'CMN']) {
      const owner = index.byId.get(index.iata.get(code)!)!;
      expect(owner.kind).toBe('city');
    }
  });

  it('falls back to a region when no city in the artifact claims the code', () => {
    // DEN has no city in this fixture. Something real beats nothing.
    expect(index.byId.get(index.iata.get('DEN')!)!.id).toBe('s-us-co');
  });

  it('holds metropolitan codes alongside airport codes', () => {
    expect(index.iata.get('NYC')).toBe('m-nyc');
    expect(index.iata.get('TYO')).toBe('p-tokyo');
    expect(index.iata.get('PAR')).toBe('p-paris-fr');
  });
});

describe('byId and prominence', () => {
  it('holds every place exactly once', () => {
    expect(index.byId.size).toBe(FIXTURE_ARTIFACT.places.length);
  });

  it('scores an origin by airport size ahead of population', () => {
    const score = (id: string) => index.prominence.get(id)!;
    // Portland OR over Portland ME, and by more than the near-tie margin.
    expect(score('p-portland-or') - score('p-portland-me')).toBeGreaterThan(0.1);
    // Springfield MO over Springfield IL, and by less.
    expect(score('p-springfield-mo') - score('p-springfield-il')).toBeLessThan(0.1);
  });

  it('keeps every score inside 0..1 so the margin means something', () => {
    for (const value of index.prominence.values()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
