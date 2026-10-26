/**
 * Golden-set assertions on the generated location artifact.
 *
 * These test the DATA, not the resolver — the resolver is built in parallel
 * against `services/location/types.ts` and is not imported here. Lookup below
 * is a deliberately dumb exact match on name and alias, so a failure points at
 * the pipeline rather than at someone else's scoring.
 *
 * NEGATIVE CONTROLS. A test that passes against an empty artifact tests
 * nothing, and vacuous tests have shipped in this repo before. Two guards:
 *
 *   1. `expectPlace` THROWS when nothing matches, and there is a test that
 *      proves it throws. Every golden case goes through it, so none of them
 *      can pass by matching nothing.
 *   2. The first test asserts the artifact is not a stub. Every other test
 *      asserts a specific IATA code at a specific position, which an empty or
 *      truncated artifact cannot satisfy.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  locationAirportRanks,
  locationArtifact,
  locationCodeLists,
} from '../data/locationArtifact';
import type { Place, PlaceKind } from '../services/location/types';

/**
 * Every key below is in `data/originAirports.ts` or `data/cityAirports.ts`
 * today, with that primary airport. The artifact has to keep answering each
 * one, or Phase 5 cannot delete those tables. A ratchet against silently
 * regressing a case someone already debugged.
 */
const LEGACY_PARITY: Array<{
  input: string;
  expectIata: string;
  country: string;
  /** Set where the legacy key meant a state or region, not a city. */
  kind?: PlaceKind;
}> = [
  { input: 'new york', expectIata: 'JFK', country: 'US' },
  { input: 'nyc', expectIata: 'JFK', country: 'US' },
  { input: 'newark', expectIata: 'EWR', country: 'US' },
  { input: 'brooklyn', expectIata: 'JFK', country: 'US' },
  { input: 'long island', expectIata: 'JFK', country: 'US' },
  { input: 'los angeles', expectIata: 'LAX', country: 'US' },
  { input: 'la', expectIata: 'LAX', country: 'US' },
  { input: 'san francisco', expectIata: 'SFO', country: 'US' },
  { input: 'bay area', expectIata: 'SFO', country: 'US' },
  { input: 'the bay area', expectIata: 'SFO', country: 'US' },
  { input: 'silicon valley', expectIata: 'SJC', country: 'US' },
  { input: 'oakland', expectIata: 'OAK', country: 'US' },
  { input: 'dc', expectIata: 'IAD', country: 'US' },
  { input: 'washington dc', expectIata: 'IAD', country: 'US' },
  { input: 'chicago', expectIata: 'ORD', country: 'US' },
  { input: 'houston', expectIata: 'IAH', country: 'US' },
  { input: 'dallas', expectIata: 'DFW', country: 'US' },
  { input: 'fort worth', expectIata: 'DFW', country: 'US' },
  { input: 'miami', expectIata: 'MIA', country: 'US' },
  { input: 'fort lauderdale', expectIata: 'FLL', country: 'US' },
  { input: 'philadelphia', expectIata: 'PHL', country: 'US' },
  { input: 'baltimore', expectIata: 'BWI', country: 'US' },
  { input: 'twin cities', expectIata: 'MSP', country: 'US' },
  { input: 'providence', expectIata: 'PVD', country: 'US' },
  { input: 'hartford', expectIata: 'BDL', country: 'US' },
  { input: 'london', expectIata: 'LHR', country: 'GB' },
  { input: 'paris', expectIata: 'CDG', country: 'FR' },
  { input: 'milan', expectIata: 'MXP', country: 'IT' },
  { input: 'rome', expectIata: 'FCO', country: 'IT' },
  { input: 'moscow', expectIata: 'SVO', country: 'RU' },
  { input: 'istanbul', expectIata: 'IST', country: 'TR' },
  { input: 'stockholm', expectIata: 'ARN', country: 'SE' },
  { input: 'tokyo', expectIata: 'HND', country: 'JP' },
  { input: 'kyoto', expectIata: 'KIX', country: 'JP' },
  { input: 'nara', expectIata: 'KIX', country: 'JP' },
  { input: 'osaka', expectIata: 'KIX', country: 'JP' },
  { input: 'kobe', expectIata: 'UKB', country: 'JP' },
  { input: 'seoul', expectIata: 'ICN', country: 'KR' },
  { input: 'beijing', expectIata: 'PEK', country: 'CN' },
  { input: 'shanghai', expectIata: 'PVG', country: 'CN' },
  { input: 'taipei', expectIata: 'TPE', country: 'TW' },
  { input: 'bangkok', expectIata: 'BKK', country: 'TH' },
  { input: 'jakarta', expectIata: 'CGK', country: 'ID' },
  { input: 'bali', expectIata: 'DPS', country: 'ID' },
  { input: 'hoi an', expectIata: 'DAD', country: 'VN' },
  { input: 'da nang', expectIata: 'DAD', country: 'VN' },
  { input: 'santorini', expectIata: 'JTR', country: 'GR' },
  { input: 'mykonos', expectIata: 'JMK', country: 'GR' },
  { input: 'zanzibar', expectIata: 'ZNZ', country: 'TZ' },
  { input: 'goa', expectIata: 'GOI', country: 'IN' },
  { input: 'sao paulo', expectIata: 'GRU', country: 'BR' },
  { input: 'rio de janeiro', expectIata: 'GIG', country: 'BR' },
  { input: 'buenos aires', expectIata: 'EZE', country: 'AR' },
  { input: 'mexico city', expectIata: 'MEX', country: 'MX' },
  { input: 'dubai', expectIata: 'DXB', country: 'AE' },
  { input: 'toronto', expectIata: 'YYZ', country: 'CA' },
  { input: 'montreal', expectIata: 'YUL', country: 'CA' },
  { input: 'basel', expectIata: 'BSL', country: 'CH' },
  { input: 'new england', expectIata: 'BOS', country: 'US' },
  // Delaware the state, not Delaware, Ohio — which is a real city with its
  // own airports and is what a bare city-preferring lookup finds.
  { input: 'delaware', expectIata: 'PHL', country: 'US', kind: 'state' },
];

const places = locationArtifact.places;
const ARTIFACT_PATH = join(__dirname, '..', 'data', 'generated', 'places.json');

/** The generator's fold, restated so the test does not import build-time code paths it is checking. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/đ/g, 'd')
    .replace(/þ/g, 'th')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Query = { name: string; country?: string; admin?: string; kind?: PlaceKind };

function findPlaces(query: Query): Place[] {
  const key = fold(query.name);
  return places.filter((place) => {
    if (query.country && place.country !== query.country) return false;
    if (query.admin && place.admin !== query.admin) return false;
    if (query.kind && place.kind !== query.kind) return false;
    if (fold(place.name) === key) return true;
    return place.aliases.some((alias) => fold(alias) === key);
  });
}

/**
 * Exactly one place, or throw with the near misses.
 *
 * Throwing is the negative control: a golden-set assertion cannot be satisfied
 * by an artifact that simply does not contain the place.
 */
function expectPlace(query: Query): Place {
  const matches = findPlaces(query);
  if (!matches.length) {
    throw new Error(
      `no place matched ${JSON.stringify(query)} — the artifact does not contain it`,
    );
  }
  // Several real places can share a name. Take the most prominent, which is
  // what every golden case below means.
  matches.sort(
    (a, b) => (b.population ?? 0) - (a.population ?? 0) || (b.airportRank ?? 0) - (a.airportRank ?? 0),
  );
  return matches[0];
}

function iatas(place: Place): string[] {
  return place.airports.map((a) => a.iata);
}

function airport(place: Place, iata: string) {
  const found = place.airports.find((a) => a.iata === iata);
  if (!found) {
    throw new Error(
      `${place.name} (${place.id}) has no ${iata}; it has [${iatas(place).join(', ')}]`,
    );
  }
  return found;
}

// ─── The artifact is real ────────────────────────────────────────────────────

describe('location artifact: shape and scale', () => {
  it('is not a stub', () => {
    // Guards every other test in this file: an empty artifact would let the
    // structural assertions below pass vacuously.
    expect(locationArtifact.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(locationArtifact.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(locationArtifact.sources.ourAirports).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(locationArtifact.sources.geoNames).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(places.length).toBeGreaterThan(20_000);
    const withAirports = places.filter((p) => p.airports.length > 0);
    expect(withAirports.length).toBeGreaterThan(3_000);
  });

  it('proves the lookup helper fails loudly on a missing place', () => {
    expect(() => expectPlace({ name: 'Zzyzx Not A Real Place', country: 'ZZ' })).toThrow(
      /does not contain it/,
    );
  });

  it('every place satisfies the Place contract', () => {
    const kinds: PlaceKind[] = ['city', 'metro', 'region', 'state', 'country'];
    const problems: string[] = [];
    for (const place of places) {
      if (typeof place.id !== 'string' || !place.id) problems.push(`bad id: ${place.id}`);
      if (typeof place.name !== 'string' || !place.name) problems.push(`${place.id}: bad name`);
      if (!Array.isArray(place.aliases)) problems.push(`${place.id}: aliases not an array`);
      if (!Array.isArray(place.curatedAliases)) {
        problems.push(`${place.id}: curatedAliases not an array (${place.curatedAliases})`);
      }
      if (!kinds.includes(place.kind)) problems.push(`${place.id}: bad kind ${place.kind}`);
      if (!/^[A-Z]{2}$/.test(place.country)) problems.push(`${place.id}: bad country ${place.country}`);
      if (place.admin !== null && typeof place.admin !== 'string') {
        problems.push(`${place.id}: bad admin`);
      }
      if (!Number.isFinite(place.lat) || place.lat < -90 || place.lat > 90) {
        problems.push(`${place.id}: bad lat ${place.lat}`);
      }
      if (!Number.isFinite(place.lon) || place.lon < -180 || place.lon > 180) {
        problems.push(`${place.id}: bad lon ${place.lon}`);
      }
      if (place.population !== null && !Number.isInteger(place.population)) {
        problems.push(`${place.id}: population is not a raw integer: ${place.population}`);
      }
      if (place.airportRank !== null && !Number.isInteger(place.airportRank)) {
        problems.push(`${place.id}: airportRank is not raw: ${place.airportRank}`);
      }
      if (place.metro !== null && !/^[A-Z]{3}$/.test(place.metro)) {
        problems.push(`${place.id}: bad metro ${place.metro}`);
      }
      if (!Array.isArray(place.airports)) problems.push(`${place.id}: airports not an array`);
      if (problems.length > 20) break;
    }
    expect(problems).toEqual([]);
    // Non-vacuous: an empty array satisfies "no problems" trivially.
    expect(places.length).toBeGreaterThan(20_000);
  });

  it('stores population and airportRank RAW, never normalised to 0..1', () => {
    const populated = places.filter((p) => p.population !== null);
    expect(populated.length).toBeGreaterThan(10_000);
    // A normalised weight would put every value in [0,1]; raw counts do not.
    expect(populated.some((p) => (p.population ?? 0) > 1_000_000)).toBe(true);
    expect(populated.every((p) => Number.isInteger(p.population))).toBe(true);
    const ranked = places.filter((p) => p.airportRank !== null);
    expect(ranked.length).toBeGreaterThan(3_000);
    expect(new Set(ranked.map((p) => p.airportRank))).toEqual(new Set([1, 2, 3]));
  });

  it('has no duplicate ids', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const place of places) {
      if (seen.has(place.id)) duplicates.push(place.id);
      seen.add(place.id);
    }
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(places.length);
    expect(seen.size).toBeGreaterThan(20_000);
  });

  it('every iata is three uppercase letters, and unique within a place', () => {
    const bad: string[] = [];
    for (const place of places) {
      const seen = new Set<string>();
      for (const entry of place.airports) {
        if (!/^[A-Z]{3}$/.test(entry.iata)) bad.push(`${place.id}: ${entry.iata}`);
        if (seen.has(entry.iata)) bad.push(`${place.id}: duplicate ${entry.iata}`);
        seen.add(entry.iata);
        if (!Number.isFinite(entry.km) || entry.km < 0) bad.push(`${place.id}: km ${entry.km}`);
        if (typeof entry.servesPlace !== 'boolean') bad.push(`${place.id}: servesPlace`);
      }
      if (bad.length > 20) break;
    }
    expect(bad).toEqual([]);
    expect(places.reduce((n, p) => n + p.airports.length, 0)).toBeGreaterThan(50_000);
  });
});

// ─── The golden set ──────────────────────────────────────────────────────────

describe('location artifact: golden set', () => {
  it('Paris FR has CDG and ORY, and outranks Paris TX on population', () => {
    const parisFr = expectPlace({ name: 'Paris', country: 'FR', kind: 'city' });
    expect(iatas(parisFr)).toContain('CDG');
    expect(iatas(parisFr)).toContain('ORY');
    expect(airport(parisFr, 'CDG').servesPlace).toBe(true);

    const parisTx = findPlaces({ name: 'Paris', country: 'US', admin: 'TX', kind: 'city' });
    expect(parisTx).toHaveLength(1);
    expect(parisFr.population ?? 0).toBeGreaterThan(parisTx[0].population ?? 0);
    // And the Texas one is a real place with its own airport, not a stub to
    // be thrown away: the resolver needs it to be able to ask.
    expect(parisTx[0].name).toBe('Paris');
  });

  it('Paros GR exists and has PAS — the trim-rule canary', () => {
    // Paros is population 5,289 and absent from GeoNames cities15000. A
    // population floor silently converts a real Greek island with scheduled
    // service into a clean typo correction to Paris. This single assertion is
    // the reason the trim rule is a union and not a threshold.
    const paros = expectPlace({ name: 'Paros', country: 'GR' });
    expect(iatas(paros)).toContain('PAS');
    expect(airport(paros, 'PAS').servesPlace).toBe(true);
    expect(airport(paros, 'PAS').km).toBeLessThan(25);
    expect(paros.population).toBeLessThan(15_000);
  });

  it('keeps the other airport-serving towns a cities15000 floor would drop', () => {
    for (const [name, country, iata] of [
      ['Campbeltown', 'GB', 'CAL'],
      ['Unalaska', 'US', 'DUT'],
      ['Kununurra', 'AU', 'KNX'],
      ['Gaspé', 'CA', 'YGP'],
      ['Emerald', 'AU', 'EMD'],
    ] as const) {
      const place = expectPlace({ name, country });
      expect(iatas(place)).toContain(iata);
    }
  });

  it('Buffalo US-NY has BUF, not JFK', () => {
    const buffalo = expectPlace({ name: 'Buffalo', country: 'US', admin: 'NY', kind: 'city' });
    expect(iatas(buffalo)).toContain('BUF');
    expect(iatas(buffalo)).not.toContain('JFK');
    expect(iatas(buffalo)[0]).toBe('BUF');
    // Measured on the live table, Buffalo used to relocate the traveller to
    // the state hub hundreds of miles away.
    expect(airport(buffalo, 'BUF').km).toBeLessThan(30);
  });

  it('New York has EWR with servesPlace true, as the city and as the state', () => {
    // servesPlace is the owner's rule and is NOT "inside the border": Newark
    // is in New Jersey and is one of New York City's three airports.
    const city = expectPlace({ name: 'New York City', country: 'US', kind: 'city' });
    expect(city.admin).toBe('NY');
    expect(airport(city, 'EWR').servesPlace).toBe(true);
    expect(airport(city, 'EWR').km).toBeLessThan(30);
    expect(iatas(city).slice(0, 3)).toEqual(['JFK', 'LGA', 'EWR']);
    expect(city.metro).toBe('NYC');

    const state = expectPlace({ name: 'New York', country: 'US', kind: 'state' });
    expect(airport(state, 'EWR').servesPlace).toBe(true);
    // A bare state gives every airport that serves it, ranked, with distances.
    for (const iata of ['JFK', 'LGA', 'EWR', 'BUF', 'ALB', 'ROC', 'SYR']) {
      expect(iatas(state)).toContain(iata);
    }
  });

  it('Delaware US has PHL with servesPlace true and a realistic km', () => {
    const delaware = expectPlace({ name: 'Delaware', country: 'US', kind: 'state' });
    const phl = airport(delaware, 'PHL');
    expect(phl.servesPlace).toBe(true);
    // Philadelphia is a drive from Delaware, not next door and not another
    // state away. The owner's answer is to show the distance, not to invent a
    // rule about it.
    expect(phl.km).toBeGreaterThan(20);
    expect(phl.km).toBeLessThan(140);
  });

  it('London GB has LHR, LGW and STN, and is not London, Ontario', () => {
    const london = expectPlace({ name: 'London', country: 'GB', kind: 'city' });
    expect(london.admin).toBe('ENG');
    for (const iata of ['LHR', 'LGW', 'STN']) expect(iatas(london)).toContain(iata);
    expect(iatas(london)[0]).toBe('LHR');
    expect(london.metro).toBe('LON');

    // London, Ontario exists separately and has its own airport — after
    // cleaning, a string join matches it instead of London England.
    const ontario = findPlaces({ name: 'London', country: 'CA', kind: 'city' });
    expect(ontario).toHaveLength(1);
    expect(ontario[0].admin).toBe('08');
    expect(iatas(ontario[0])).toContain('YXU');
    expect(iatas(ontario[0])).not.toContain('LHR');
  });

  it('Milan IT resolves under both spellings, whichever way GeoNames files it', () => {
    // The architecture document says GeoNames spells Milan "Milano". MEASURED
    // on the current dump it does NOT: name and ascii name are both "Milan",
    // with "Milano" only in alternate names. GeoNames has moved the Italian
    // cities to English exonyms (Rome, Naples, Florence, Turin, Genoa too), so
    // both spellings are asserted and the artifact survives a flip back.
    const byEnglish = expectPlace({ name: 'Milan', country: 'IT', kind: 'city' });
    const byItalian = expectPlace({ name: 'Milano', country: 'IT', kind: 'city' });
    expect(byItalian.id).toBe(byEnglish.id);
    expect(iatas(byEnglish)).toContain('MXP');
    expect(iatas(byEnglish)).toContain('LIN');
    expect(byEnglish.metro).toBe('MIL');
    // No Milan airport carries "Milan" in its municipality: Ferno (VA),
    // Segrate (MI), Orio al Serio (BG). This only works geographically.
    expect(airport(byEnglish, 'MXP').km).toBeGreaterThan(30);
  });

  it('the local spellings of the other renamed Italian cities survive', () => {
    for (const [english, local, iata] of [
      ['Rome', 'Roma', 'FCO'],
      ['Naples', 'Napoli', 'NAP'],
      ['Florence', 'Firenze', 'FLR'],
      ['Turin', 'Torino', 'TRN'],
      ['Genoa', 'Genova', 'GOA'],
    ] as const) {
      const byEnglish = expectPlace({ name: english, country: 'IT', kind: 'city' });
      const byLocal = expectPlace({ name: local, country: 'IT', kind: 'city' });
      expect(byLocal.id).toBe(byEnglish.id);
      expect(iatas(byEnglish)).toContain(iata);
    }
  });

  it('the bay area exists via the curated layer with SFO, OAK and SJC', () => {
    // Verified: GeoNames returns zero rows for "bay area" in name, ascii name
    // and alternate names. No open dataset covers it.
    const bay = expectPlace({ name: 'the bay area' });
    expect(bay.kind).toBe('metro');
    expect(bay.id).toBe('cur:sf-bay-area');
    expect(iatas(bay)).toEqual(['SFO', 'OAK', 'SJC']);
    expect(bay.airports.every((a) => a.servesPlace)).toBe(true);
    expect(expectPlace({ name: 'bay area' }).id).toBe(bay.id);

    const valley = expectPlace({ name: 'silicon valley' });
    expect(iatas(valley)[0]).toBe('SJC');
  });

  it('the other colloquial names no dataset covers resolve', () => {
    expect(expectPlace({ name: 'nyc', country: 'US' }).name).toBe('New York City');
    expect(expectPlace({ name: 'la', country: 'US' }).name).toBe('Los Angeles');
    // "dc" names both the city and the District; both must lead with IAD,
    // because a caller that resolves one rather than the other must not price
    // from a different airport.
    expect(iatas(expectPlace({ name: 'dc', country: 'US', kind: 'city' }))[0]).toBe('IAD');
    expect(iatas(expectPlace({ name: 'dc', country: 'US', kind: 'state' }))[0]).toBe('IAD');
    // "Long Island" is also an admin1 region of the Bahamas with its own
    // airport, so this one is genuinely ambiguous across countries — which is
    // the resolver's cue to ask, and the reason the test qualifies it.
    const longIsland = findPlaces({ name: 'long island' });
    expect(longIsland.map((p) => p.country).sort()).toEqual(['BS', 'US']);
    expect(iatas(expectPlace({ name: 'long island', country: 'US' }))[0]).toBe('JFK');
  });
});

// ─── Alias provenance ────────────────────────────────────────────────────────

describe('location artifact: curated aliases are marked as such', () => {
  // `aliases` mixes two things the resolver has to trust differently: a
  // hand-written decision from `scripts/location-data/curated.ts` ("nyc" IS
  // New York City) and a GeoNames alternate name, which is user-contributed
  // and measurably dirty. `curatedAliases` is the marker subset, and it exists
  // because of the Lomé case asserted below.

  it('keys a real place on every entry, and is empty on almost all of them', () => {
    const problems: string[] = [];
    let nonEmpty = 0;
    for (const place of places) {
      if (!Array.isArray(place.curatedAliases)) {
        problems.push(`${place.id}: curatedAliases is not an array`);
        continue;
      }
      if (place.curatedAliases.length) nonEmpty++;
      for (const alias of place.curatedAliases) {
        // Each entry must be a string that really keys this place: either one
        // of its aliases, or its own NAME.
        //
        // The name case is why this is no longer a strict subset check. A
        // curated string that folds to the place's own name is dropped from
        // `aliases` by the build's dedupe, so there is nothing to mark — and
        // a subset rule made such an entry a silent no-op. Measured:
        // `washington` targeted at Washington DC did nothing at all, because
        // the city is already called Washington, so the key stayed canonical
        // and tied with Washington State instead of winning.
        if (!place.aliases.includes(alias) && alias !== place.name) {
          problems.push(
            `${place.id} ${place.name}: curated "${alias}" is neither an alias nor the name`,
          );
        }
      }
      if (problems.length > 20) break;
    }
    expect(problems).toEqual([]);
    // Non-vacuous in both directions: the invariant has to be exercised, and a
    // generator that marked everything curated would pass the subset check.
    expect(nonEmpty).toBeGreaterThan(10);
    expect(nonEmpty).toBeLessThan(100);
    expect(places.reduce((n, p) => n + p.curatedAliases.length, 0)).toBeGreaterThan(20);
  });

  it('marks the colloquial names that were decided by hand', () => {
    // Qualified by kind where the bare name is also a state: "dc" is curated
    // on Washington the CITY, while the District reaches it through its own
    // admin1 code — the same distinction as Louisiana below.
    for (const [query, alias] of [
      [{ name: 'San Francisco Bay Area' }, 'the bay area'],
      [{ name: 'Silicon Valley' }, 'silicon valley'],
      [{ name: 'New York City', country: 'US', kind: 'city' }, 'nyc'],
      [{ name: 'Los Angeles', country: 'US', kind: 'city' }, 'la'],
      [{ name: 'Washington', country: 'US', kind: 'city' }, 'dc'],
      [{ name: 'San Francisco', country: 'US', kind: 'city' }, 'sf'],
    ] as Array<[Query, string]>) {
      const place = expectPlace(query);
      expect(place.curatedAliases).toContain(alias);
      expect(place.aliases).toContain(alias);
    }
    // And the District of Columbia, which answers "dc" too, does NOT claim it.
    expect(expectPlace({ name: 'dc', country: 'US', kind: 'state' }).curatedAliases).toEqual([]);
  });

  it('does NOT mark a dataset alternate name — the Lomé "rome" case', () => {
    // Lomé, Togo literally carries the GeoNames alternate name "rome", which
    // puts Togo in the candidate list for every `Rome` query. The data is NOT
    // cleaned here: the alias stays, and the provenance is what lets the
    // resolver outrank it.
    const lome = expectPlace({ name: 'Lomé', country: 'TG' });
    expect(lome.aliases).toContain('rome');
    expect(lome.curatedAliases).not.toContain('rome');
    expect(lome.curatedAliases).toEqual([]);

    // Rome itself is unaffected, and reaches "rome" by its own name.
    const rome = expectPlace({ name: 'Rome', country: 'IT', kind: 'city' });
    expect(iatas(rome)[0]).toBe('FCO');
  });

  it('does NOT mark an official code — "LA" is Louisiana and Laos by code', () => {
    // Both match "la" through ISO 3166-1 / the admin1 code, not through a
    // curated decision, so neither may claim the curated tier that makes "la"
    // mean Los Angeles.
    const louisiana = expectPlace({ name: 'Louisiana', country: 'US', kind: 'state' });
    expect(louisiana.aliases).toContain('LA');
    expect(louisiana.curatedAliases).toEqual([]);

    const laos = places.find((p) => p.id === 'cty:LA');
    expect(laos).toBeDefined();
    expect(laos!.aliases).toContain('LA');
    expect(laos!.curatedAliases).toEqual([]);

    expect(expectPlace({ name: 'la', country: 'US' }).name).toBe('Los Angeles');
  });

  it('marks nothing on a plain GeoNames city', () => {
    for (const [name, country] of [
      ['Paros', 'GR'],
      ['Buffalo', 'US'],
      ['Florence', 'IT'],
      ['Campbeltown', 'GB'],
    ] as const) {
      const place = expectPlace({ name, country });
      expect(place.curatedAliases).toEqual([]);
      // ...while still carrying dataset aliases, so this is not an empty read.
      if (name === 'Florence') expect(place.aliases).toContain('Firenze');
    }
  });
});

// ─── Order is load-bearing ───────────────────────────────────────────────────

describe('location artifact: airports[0] for multi-airport metros', () => {
  // `estimateHomeLegCost` prices every route permutation from `airports[0]`
  // alone. Annual passengers are not openly licensed globally, so the derived
  // sort is the OurAirports type ordinal then distance — which has only three
  // levels and puts LCY ahead of LHR and LGA ahead of JFK. That is why the
  // multi-airport metros carry a hand order in the curated layer.
  const expected: Array<[string, string, string]> = [
    ['London', 'GB', 'LHR'],
    ['New York City', 'US', 'JFK'],
    ['Paris', 'FR', 'CDG'],
    ['Los Angeles', 'US', 'LAX'],
    ['San Francisco', 'US', 'SFO'],
    ['Milan', 'IT', 'MXP'],
    ['Rome', 'IT', 'FCO'],
    ['Tokyo', 'JP', 'HND'],
    ['Osaka', 'JP', 'KIX'],
    ['Seoul', 'KR', 'ICN'],
    ['Beijing', 'CN', 'PEK'],
    ['Shanghai', 'CN', 'PVG'],
    ['Chicago', 'US', 'ORD'],
    ['Houston', 'US', 'IAH'],
    ['Dallas', 'US', 'DFW'],
    ['Miami', 'US', 'MIA'],
    ['Washington', 'US', 'IAD'],
    ['Toronto', 'CA', 'YYZ'],
    ['Stockholm', 'SE', 'ARN'],
    ['Moscow', 'RU', 'SVO'],
    ['Istanbul', 'TR', 'IST'],
    ['São Paulo', 'BR', 'GRU'],
    ['Rio de Janeiro', 'BR', 'GIG'],
    ['Buenos Aires', 'AR', 'EZE'],
    ['Bangkok', 'TH', 'BKK'],
    ['Taipei', 'TW', 'TPE'],
    ['Jakarta', 'ID', 'CGK'],
  ];

  it.each(expected)('%s %s prices from %s', (name, country, iata) => {
    const place = expectPlace({ name, country, kind: 'city' });
    expect(iatas(place)[0]).toBe(iata);
  });

  it('never leads Los Angeles with Burbank', () => {
    // The named failure mode: BUR is a large_airport 20 km out and LAX a
    // large_airport 19 km out, so type-then-distance is a coin flip and
    // alphabetical order loses outright.
    const la = expectPlace({ name: 'Los Angeles', country: 'US', kind: 'city' });
    expect(iatas(la).indexOf('LAX')).toBeLessThan(iatas(la).indexOf('BUR'));
  });

  it('publishes the rank basis it actually used', () => {
    expect(locationAirportRanks.basis).toBe('ourairports-type-ordinal');
    const values = Object.values(locationAirportRanks.ranks);
    expect(values.length).toBeGreaterThan(3_900);
    expect(new Set(values)).toEqual(new Set([1, 2, 3]));
    // Every airport referenced by a place must be in the rank table, or the
    // sort key below is not the key that was used.
    const referenced = new Set(places.flatMap((p) => p.airports.map((a) => a.iata)));
    const missing = [...referenced].filter((iata) => !(iata in locationAirportRanks.ranks));
    expect(missing).toEqual([]);
  });

  it('leads every pinned place with its hand-written order', () => {
    const pinned = Object.entries(locationAirportRanks.pinned);
    expect(pinned.length).toBeGreaterThan(300);
    const problems: string[] = [];
    for (const [id, prefix] of pinned) {
      const place = places.find((p) => p.id === id);
      if (!place) {
        problems.push(`${id} is pinned but not in the artifact`);
        continue;
      }
      // The pin is a prefix of what survived the per-place cap, in order.
      const expectedPrefix = prefix.filter((iata) => place.airports.some((a) => a.iata === iata));
      const actualPrefix = iatas(place).slice(0, expectedPrefix.length);
      if (actualPrefix.join(',') !== expectedPrefix.join(',')) {
        problems.push(`${id} ${place.name}: want ${expectedPrefix} got ${actualPrefix}`);
      }
      if (problems.length > 10) break;
    }
    expect(problems).toEqual([]);
  });

  it('sorts every unpinned pair by serves, then rank descending, then distance ascending', () => {
    // Checked across the WHOLE artifact, not spot-checked. Outside the pinned
    // prefixes the sort key is (servesPlace desc, type ordinal desc, km asc,
    // iata asc) and nothing else; any other order silently changes which
    // airport `estimateHomeLegCost` searches when it ranks permutations, and
    // which ones survive into buildHomeLeg's capped fan-out.
    //
    // `servesPlace` leads the key. Without it the type ordinal alone could
    // promote an airport the place is NOT served by over one it is: GEG, 107
    // km from Moscow, Idaho and serves=false, outranked PUW at 9 km and
    // serves=true. So an inversion in rank or km is only a problem WITHIN one
    // servesPlace value — a serving small airport ahead of a non-serving large
    // one is the rule working, not breaking.
    const problems: string[] = [];
    let checked = 0;
    for (const place of places) {
      const prefix = locationAirportRanks.pinned[place.id] ?? [];
      // Pairs inside the pinned prefix are hand-ordered by design, and so is
      // the boundary pair: the last pinned airport is routinely smaller or
      // farther than the first derived one (SEN then BHX for England, the
      // local strip then a medium airport 130 km away for a bush village).
      // Everything strictly after the prefix has to obey the derived key.
      const survived = prefix.filter((iata) => iatas(place).includes(iata)).length;
      const from = Math.max(1, survived + 1);
      for (let i = from; i < place.airports.length; i++) {
        const previous = place.airports[i - 1];
        const current = place.airports[i];
        const previousRank = locationAirportRanks.ranks[previous.iata];
        const currentRank = locationAirportRanks.ranks[current.iata];
        checked++;
        if (!previous.servesPlace && current.servesPlace) {
          problems.push(
            `${place.id} ${place.name}: ${previous.iata}(serves=false) before ` +
              `${current.iata}(serves=true)`,
          );
        } else if (previous.servesPlace !== current.servesPlace) {
          // A serving airport ahead of a non-serving one: the first term of
          // the key is satisfied and the rank/km terms do not apply across it.
        } else if (previousRank < currentRank) {
          problems.push(
            `${place.id} ${place.name}: ${previous.iata}(rank ${previousRank}) before ` +
              `${current.iata}(rank ${currentRank})`,
          );
        } else if (previousRank === currentRank && previous.km > current.km + 0.001) {
          problems.push(
            `${place.id} ${place.name}: ${previous.iata}@${previous.km}km before ` +
              `${current.iata}@${current.km}km at the same rank`,
          );
        }
        if (problems.length > 10) break;
      }
      if (problems.length > 10) break;
    }
    expect(problems).toEqual([]);
    // Non-vacuous: the invariant has to actually be exercised on a real
    // fraction of the artifact, not skipped by the prefix arithmetic.
    expect(checked).toBeGreaterThan(50_000);
  });
});

// ─── Legacy parity ───────────────────────────────────────────────────────────

describe('location artifact: parity with the tables it replaces', () => {
  it.each(LEGACY_PARITY)('"$input" still offers $expectIata', ({ input, expectIata, country, kind }) => {
    if (kind) {
      expect(iatas(expectPlace({ name: input, country, kind }))).toContain(expectIata);
      return;
    }
    // Otherwise prefer the city reading, which is what the rest of these
    // legacy keys meant: the old tables had no notion of regions at all.
    const asCity = findPlaces({ name: input, country, kind: 'city' });
    const place = asCity.length
      ? asCity.sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0]
      : expectPlace({ name: input, country });
    expect(iatas(place)).toContain(expectIata);
  });

  it('keeps the Kyoto override that stopped Kyoto resolving to Accra, Ghana', () => {
    const kyoto = expectPlace({ name: 'Kyoto', country: 'JP' });
    expect(iatas(kyoto)[0]).toBe('KIX');
    expect(iatas(kyoto)).not.toContain('ACC');
    const nara = expectPlace({ name: 'Nara', country: 'JP' });
    expect(iatas(nara)[0]).toBe('KIX');
  });

  it('attaches the cross-border EuroAirport to Basel, which is in another country', () => {
    const basel = expectPlace({ name: 'Basel', country: 'CH' });
    expect(iatas(basel)).toContain('BSL');
    expect(airport(basel, 'BSL').servesPlace).toBe(true);
  });
});

// ─── Code lists ──────────────────────────────────────────────────────────────

describe('generated code lists', () => {
  it('derives 56 USPS state and territory codes from source', () => {
    expect(locationCodeLists.uspsStateCodes).toHaveLength(56);
    for (const code of ['CA', 'DE', 'NY', 'TX', 'DC', 'PR', 'VI', 'GU', 'AS', 'MP']) {
      expect(locationCodeLists.uspsStateCodes).toContain(code);
    }
    // ISO 3166-2:US also carries UM, which has no USPS mailing abbreviation.
    expect(locationCodeLists.uspsStateCodes).not.toContain('UM');
    expect(locationCodeLists.uspsStateCodes.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
  });

  it('derives the 31 state codes that collide with ISO 3166-1 country codes', () => {
    // Derived, never remembered. The document that specified this project got
    // the list from memory and that is how `Berlin, DE` prices from
    // Philadelphia.
    expect(locationCodeLists.collidingCodes).toHaveLength(31);
    expect(locationCodeLists.cleanStateCodes).toHaveLength(25);
    for (const code of ['CA', 'DE', 'IN', 'MA', 'LA', 'IL', 'CO', 'MD', 'GA', 'MN', 'AZ']) {
      expect(locationCodeLists.collidingCodes).toContain(code);
    }
    expect(locationCodeLists.cleanStateCodes).toContain('NJ');
    expect(locationCodeLists.collidingCodes).not.toContain('NJ');
    expect(
      locationCodeLists.collidingCodes.length + locationCodeLists.cleanStateCodes.length,
    ).toBe(locationCodeLists.uspsStateCodes.length);
  });

  it('derives ISO 3166-1 alpha-2 from source, including every colliding code', () => {
    expect(locationCodeLists.iso3166Alpha2.length).toBeGreaterThan(240);
    for (const code of ['FR', 'DE', 'IL', 'MA', 'CO', 'GE', 'LA', 'IN', 'CA']) {
      expect(locationCodeLists.iso3166Alpha2).toContain(code);
    }
    for (const code of locationCodeLists.collidingCodes) {
      expect(locationCodeLists.iso3166Alpha2).toContain(code);
    }
  });

  it('has a country place for each of the must-never-confuse pairs', () => {
    for (const [code, name] of [
      ['DE', 'Germany'],
      ['IL', 'Israel'],
      ['MA', 'Morocco'],
      ['CO', 'Colombia'],
      ['GE', 'Georgia'],
      ['LA', 'Laos'],
    ] as const) {
      const country = places.find((p) => p.id === `cty:${code}`);
      expect(country).toBeDefined();
      expect(country!.kind).toBe('country');
      expect(country!.aliases).toContain(code);
      expect(fold(country!.name)).toContain(fold(name).split(' ')[0]);
    }
    // Georgia the US state and Georgia the country both exist, which is why
    // the resolver's qualifier index has to be multi-valued.
    expect(places.find((p) => p.id === 'adm:US.GA')).toBeDefined();
  });
});

// ─── Budgets ─────────────────────────────────────────────────────────────────

describe('location artifact: budgets', () => {
  it('stays inside the 50 MB memory budget when loaded', () => {
    // Measured for real in a child process rather than estimated: jest's own
    // heap is already full of module graph, and there is no exposed gc here.
    const probe = `
      const { readFileSync } = require('node:fs');
      const text = readFileSync(${JSON.stringify(ARTIFACT_PATH)}, 'utf8');
      global.gc(); global.gc();
      const before = process.memoryUsage().heapUsed;
      const artifact = JSON.parse(text);
      global.gc(); global.gc();
      const after = process.memoryUsage().heapUsed;
      if (!artifact.places.length) throw new Error('empty artifact');
      process.stdout.write(JSON.stringify({ heap: after - before, places: artifact.places.length }));
    `;
    const output = execFileSync(process.execPath, ['--expose-gc', '-e', probe], {
      encoding: 'utf8',
    });
    const { heap, places: count } = JSON.parse(output) as { heap: number; places: number };
    expect(count).toBe(places.length);
    expect(heap / 1024 / 1024).toBeLessThan(50);
    // And not suspiciously small, which would mean the probe measured nothing.
    expect(heap / 1024 / 1024).toBeGreaterThan(5);
  }, 60_000);

  it('keeps the on-disk artifact diffable: one place per line', () => {
    // Fully pretty-printed this file is 19.0 MiB and a one-airport change
    // moves a dozen lines; fully compact it is one unreadable line. One line
    // per place, id-sorted, makes the diff an airport changelog.
    const text = readFileSync(ARTIFACT_PATH, 'utf8');
    const lines = text.split('\n');
    const placeLines = lines.filter((l) => l.startsWith('{"id":"'));
    expect(placeLines).toHaveLength(places.length);
    expect(statSync(ARTIFACT_PATH).size).toBeLessThan(20 * 1024 * 1024);
  });

  it('is id-sorted, so rebuilds produce a readable diff', () => {
    const ids = places.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids.length).toBeGreaterThan(20_000);
  });
});
