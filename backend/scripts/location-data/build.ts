/**
 * The city <-> airport join and artifact assembly.
 *
 * This is the hard part of the pipeline and it is NOT a string match. Measured
 * against today's dumps, every one of these is true:
 *
 *   - `municipality == "Paris"` returns ZERO scheduled-IATA airports. CDG is
 *     filed as "Paris (Roissy-en-France, Val-d'Oise)". 6.0% of scheduled-IATA
 *     municipality values carry a parenthetical or a comma.
 *   - No Milan airport carries "Milan" anywhere: Ferno (VA), Segrate (MI),
 *     Orio al Serio (BG).
 *   - OurAirports has no metro concept: LTN/STN/SEN do not group to London and
 *     EWR does not group to New York.
 *   - `keywords` is 40.2% populated and mostly FAA identifiers. Not mined.
 *
 * So the join is geographic, with three corrections that were each measured
 * rather than guessed. See ASSIGNMENT below.
 */

import type { Place, PlaceAirport, LocationArtifact } from '../../src/services/location/types';
import {
  AIRPORT_OVERRIDES,
  CURATED_ALIASES,
  CURATED_PLACES,
  METRO_GROUPS,
  REGION_AIRPORT_OVERRIDES,
  type CityRef,
} from './curated';
import { parseAdmin1, parseCountryInfo, type Admin1Row, type CountryRow } from './codes';
import { Grid, haversineKm, roundCoord, roundKm } from './geo';
import { fold, hasLatin, parseCsv, parseTsv } from './text';

/** Bumped when the emitted shape changes. */
export const SCHEMA_VERSION = 1;

// ─── ASSIGNMENT ──────────────────────────────────────────────────────────────
//
// Each scheduled-IATA airport is assigned ONE primary city, and the rule is
// NOT "the nearest city". Measured Spearman against route traffic:
// nearest-within-50km scores 0.073, largest-within-100km scores 0.451 —
// nearest attaches LHR to Stanwell (pop 3,000) instead of to London.
//
// Three corrections to plain largest-within-100km, each measured on this dump:
//
//  1. SAME COUNTRY. Plain largest sends BUF to Hamilton Ontario (97 km), HKG
//     to Shenzhen, SAN to Tijuana, ELP to Ciudad Juárez, TLL across the Gulf
//     of Finland to Helsinki, FAO to Huelva in Spain, EIN to Brussels and BTS
//     to Vienna. One rule removes all eight. Genuine cross-border airports are
//     named in the curated layer instead (see the Basel group).
//
//  2. NO CITY SECTIONS. GeoNames feature code PPLX is "section of populated
//     place". Plain largest sends SOU to Brent (a London borough, pop 329,100)
//     99 km away. Sections are dropped from the city universe entirely: they
//     are not destinations a traveller names, and they manufacture ambiguity.
//
//  3. DISTANCE-DECAYED PROMINENCE instead of raw largest. The brief's own
//     warning — "a 100 km radius over-reaches in dense regions (it absorbed
//     Amsterdam into Rotterdam in testing)" — is reproducible: GeoNames gives
//     Rotterdam 868,135 against Amsterdam's 741,636, so raw largest hands AMS
//     to Rotterdam 47 km away. Worse, it breaks the single most important rule
//     in the brief: raw largest assigns PAS to Ermoúpolis 50 km away, so
//     PAROS — the trim-rule canary, the place that must not become a typo
//     correction to Paris — loses its own airport.
//
//     The fix keeps prominence as the signal and adds a distance term:
//
//         score = population / (1 + (km / 25) ^ 2)
//
//     Of 70 hand-checkable airports, this differs from raw largest on 21, and
//     is right on all 21: AMS->Amsterdam, SFO/OAK->San Francisco,
//     PAS->Páros, JTR->Firá, JMK->Mykonos, BWI->Baltimore, MAN->Manchester,
//     EDI->Edinburgh, LPL->Liverpool, LBA->Leeds, CWL->Cardiff,
//     EMA->Nottingham, YHM->Hamilton, PVD->Providence, MHT->Manchester NH,
//     KOA->Kailua-Kona, REU->Tarragona, STS->Santa Rosa, SOU->Southampton,
//     EIN->Eindhoven. It keeps every case where "largest, not nearest" is the
//     point: LTN/STN/SEN/LCY->London, BVA->Paris, SNA/ONT->Los Angeles,
//     NRT->Tokyo, GRO->Barcelona, NYO->Stockholm, TRF->Oslo, AVV->Melbourne,
//     SWF->New York City.
//
//     Spearman against route traffic could not be recomputed: there is no
//     openly-licensed global traffic table, which is the same reason the
//     airport sort falls back to the `type` ordinal.

const ASSIGN_RADIUS_KM = 100;
const ASSIGN_HALF_KM = 25;
const ASSIGN_EXPONENT = 2;

/**
 * `servesPlace` — the owner's rule, and NOT "inside the border".
 *
 * Newark is in New Jersey and is one of New York City's three airports. Border
 * logic drops it; serving logic keeps it. So for a city or metro:
 *
 *   true   it is the place's primary-assigned airport, or anchored to the
 *          place by its own municipality, or in the same curated metro group,
 *          or named by a curated override — OR it is within SERVE_RADIUS_KM
 *          and in the same country.
 *   false  it is between SERVE_RADIUS_KM and ATTACH_RADIUS_KM: in range,
 *          listed with its distance, but primarily another city's airport.
 *
 * For a region, state or country every attached airport is `true`. A bare
 * state's question is "which airports serve this state", and the answer is the
 * ranked list with distances — which is also the owner's answer to Delaware
 * resolving to Philadelphia: show PHL with its drive distance rather than
 * invent a rule about it.
 */
const SERVE_RADIUS_KM = 100;
const ATTACH_RADIUS_KM = 150;

/**
 * THE TRIM RULE IS A UNION, NEVER A THRESHOLD.
 *
 *     include = (every city at or above this floor) U (every city with a
 *               scheduled IATA airport)
 *
 * The floor alone drops airport-serving cities — Campbeltown, Unalaska,
 * Kununurra, Gaspé, Emerald, and Paros (pop 5,289, airport PAS), which would
 * silently become a clean typo correction to Paris. A place with an airport is
 * an origin candidate whatever its population, because having an airport is
 * the only thing that matters here. The exact count dropped by the floor is
 * measured and reported on every build.
 */
const POPULATION_FLOOR = 15_000;

/**
 * THE MUNICIPALITY ANCHOR.
 *
 * Gravity assignment alone loses the airport's own town when a much larger
 * town sits inside the radius. Measured: Campbeltown (pop 4,500, 2 km from
 * CAL) loses to Ayr (pop 46,260, 66 km away), so Campbeltown — one of the
 * named canaries for the trim rule — drops out of the artifact entirely.
 *
 * So after assignment, every airport ALSO anchors to the city its own
 * `municipality` field names, when that city is within this radius and in the
 * same country. That is not the string join this pipeline rejects: a string
 * join is the whole answer, this is a NAME CONFIRMING A GEOGRAPHIC FACT, and
 * it only ever adds. It cannot move an airport to the wrong continent because
 * the city has to be a few kilometres away to qualify.
 */
const MUNICIPALITY_ANCHOR_KM = 30;

const MAX_AIRPORTS_CITY = 6;
const MAX_AIRPORTS_REGION = 40;
const MAX_AIRPORTS_COUNTRY = 24;
/**
 * Alias caps, by population.
 *
 * GeoNames sorts `alternatenames` ALPHABETICALLY, not by importance —
 * measured, "Wien" is at index 40 of Vienna's Latin alternates and
 * "København" at 44 of Copenhagen's, purely because of the alphabet. So there
 * is no ranking signal to exploit and a tight cap drops the one name that
 * matters: a cap of 12 on Florence kept Florenc, Florenca, Florenci and
 * Florenco, and dropped FIRENZE.
 *
 * Big cities therefore keep effectively all of them (the largest Latin set
 * measured is 67, for Munich) and the long tail stays small.
 */
const MAX_ALIASES_MAJOR = 70;
const MAX_ALIASES_MID = 16;
const MAX_ALIASES_TAIL = 8;
const MAJOR_POPULATION = 200_000;
const MID_POPULATION = 20_000;
/** A two-letter alias on a city would collide with the qualifier pass. */
const MIN_AUTO_ALIAS_LENGTH = 3;

/** Not airports a scheduled passenger leaves from, and `closed` is self-explanatory. */
const EXCLUDED_AIRPORT_TYPES = new Set(['heliport', 'seaplane_base', 'balloonport', 'closed']);

/** PPLX is a city section; the rest are abandoned, destroyed or historical. */
const EXCLUDED_FEATURE_CODES = new Set(['PPLX', 'PPLQ', 'PPLW', 'PPLH']);

/**
 * The only openly-licensed prominence signal for an airport.
 *
 * Measured Spearman 0.578 against real route traffic — better than population
 * (0.451 at best) and the reason `Place.airportRank` exists. It has three
 * levels, which is why multi-airport metros need a hand order.
 */
const TYPE_ORDINAL: Record<string, number> = {
  large_airport: 3,
  medium_airport: 2,
  small_airport: 1,
};

export type Airport = {
  iata: string;
  type: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  isoRegion: string;
  municipality: string;
  ordinal: number;
};

export type City = {
  geonameId: string;
  name: string;
  asciiName: string;
  alternateNames: string[];
  lat: number;
  lon: number;
  featureCode: string;
  country: string;
  admin1: string;
  population: number;
};

export type BuildInputs = {
  airportsCsv: string;
  citiesTsv: string;
  prominenceTierTsv: string;
  midTierTsv: string;
  admin1Tsv: string;
  countryInfoTsv: string;
  sourceDates: { ourAirports: string; geoNames: string };
  generatedAt: string;
};

export type BuildStats = {
  airportRows: number;
  airportsWithIata: number;
  scheduledIataAirports: number;
  dirtyMunicipalityPct: number;
  cityRowsRead: number;
  cityUniverse: number;
  assignedAirports: number;
  anchoredAirports: number;
  orphanAirports: number;
  syntheticPlaces: number;
  airportServingCities: number;
  droppedByProminenceFloor: number;
  droppedByProminenceFloorPct: number;
  belowMidTier: number;
  places: Record<string, number>;
  curatedPlaces: number;
  curatedAliases: number;
  metroGroupMembers: number;
};

/**
 * What was actually used to order `airports[]`, emitted so it can be asserted.
 *
 * The contract says "annual passengers descending, then distance". Annual
 * passenger counts are not openly licensed globally — confirmed — so the
 * passenger term is the OurAirports `type` ordinal (large 3, medium 2, small
 * 1), measured Spearman 0.578 against real route traffic. Three levels cannot
 * separate LHR from LCY, which is why the multi-airport metros carry a hand
 * order in `curated.ts`.
 *
 * This table is emitted rather than left implicit so a test can check the sort
 * invariant across every place in the artifact instead of spot-checking.
 */
export type AirportRankTable = {
  schemaVersion: number;
  generatedAt: string;
  basis: 'ourairports-type-ordinal';
  /** IATA -> 3 large, 2 medium, 1 small. */
  ranks: Record<string, number>;
  /**
   * Places whose `airports[]` leads with a hand-written order instead of the
   * derived one, and what that order is.
   *
   * Emitted so the derived sort can be asserted EXACTLY across the rest of the
   * artifact rather than spot-checked: a test that cannot tell a pinned place
   * from a mis-sorted one has to be loose enough to miss real inversions.
   *
   * A place with id `ap:<IATA>` is implicitly pinned to its own airport: it
   * was synthesised from that airport because no city in the dump reaches it,
   * so the local strip is the origin a traveller actually uses even when a
   * larger airport sits 130 km away.
   */
  pinned: Record<string, string[]>;
};

export type BuildResult = {
  artifact: LocationArtifact;
  ranks: AirportRankTable;
  stats: BuildStats;
};

// ─── Parsing ─────────────────────────────────────────────────────────────────

export function parseAirports(csv: string): { all: number; airports: Airport[]; withIata: number; dirtyPct: number } {
  const rows = parseCsv(csv);
  const header = rows[0];
  const col = new Map<string, number>();
  header.forEach((h, i) => col.set(h, i));
  const need = [
    'type',
    'name',
    'latitude_deg',
    'longitude_deg',
    'iso_country',
    'iso_region',
    'municipality',
    'scheduled_service',
    'iata_code',
  ];
  for (const n of need) {
    if (!col.has(n)) throw new Error(`OurAirports CSV is missing column "${n}"`);
  }
  const airports: Airport[] = [];
  let withIata = 0;
  let dirty = 0;
  let total = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < header.length) continue;
    total++;
    const iata = row[col.get('iata_code')!].trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata)) continue;
    withIata++;
    const type = row[col.get('type')!];
    if (row[col.get('scheduled_service')!] !== 'yes') continue;
    if (EXCLUDED_AIRPORT_TYPES.has(type)) continue;
    const lat = Number.parseFloat(row[col.get('latitude_deg')!]);
    const lon = Number.parseFloat(row[col.get('longitude_deg')!]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const municipality = row[col.get('municipality')!].trim();
    if (/[(),]/.test(municipality)) dirty++;
    airports.push({
      iata,
      type,
      name: row[col.get('name')!].trim(),
      lat,
      lon,
      country: row[col.get('iso_country')!].trim().toUpperCase(),
      isoRegion: row[col.get('iso_region')!].trim(),
      municipality,
      ordinal: TYPE_ORDINAL[type] ?? 1,
    });
  }
  // One IATA code, one airport. Duplicates would make the iata index lossy.
  const byIata = new Map<string, Airport>();
  for (const a of airports) {
    const existing = byIata.get(a.iata);
    if (!existing || a.ordinal > existing.ordinal) byIata.set(a.iata, a);
  }
  return {
    all: total,
    airports: [...byIata.values()],
    withIata,
    dirtyPct: airports.length ? (100 * dirty) / airports.length : 0,
  };
}

export function parseCities(tsv: string): City[] {
  const out: City[] = [];
  for (const f of parseTsv(tsv)) {
    if (f.length < 19) continue;
    if (f[6] !== 'P') continue;
    const featureCode = f[7];
    if (EXCLUDED_FEATURE_CODES.has(featureCode)) continue;
    const lat = Number.parseFloat(f[4]);
    const lon = Number.parseFloat(f[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      geonameId: f[0],
      name: f[1],
      asciiName: f[2],
      alternateNames: f[3] ? f[3].split(',') : [],
      lat,
      lon,
      featureCode,
      country: f[8].toUpperCase(),
      admin1: f[10],
      population: Number.parseInt(f[14], 10) || 0,
    });
  }
  return out;
}

/** Row count of a GeoNames dump, for the trim-rule measurement. */
export function countCityRows(tsv: string): Set<string> {
  const ids = new Set<string>();
  for (const f of parseTsv(tsv)) {
    if (f.length < 19) continue;
    ids.add(f[0]);
  }
  return ids;
}

// ─── Aliases ─────────────────────────────────────────────────────────────────

/**
 * Pick the alternate names worth indexing.
 *
 * GeoNames now files the Italian cities under ENGLISH EXONYMS — the dump says
 * Milan, Rome, Naples, Florence, Turin, Genoa — with the local spelling only
 * in `alternatenames`. (This contradicts the architecture document, which says
 * GeoNames spells it "Milano". It did once; it does not today.) So "Milano",
 * "Roma" and "Firenze" reach the artifact only through this function, and
 * dropping them would make the most-searched cities in Italy unresolvable
 * under their own names.
 *
 * Two filters:
 *
 *  - LATIN SCRIPT, three characters or more. A two-letter city alias would
 *    collide with the state and country codes the resolver's qualifier pass
 *    depends on.
 *  - NO BARE THREE-LETTER UPPERCASE CODES. GeoNames carries the city's own
 *    IATA code in this field (FLR for Florence, VIE for Vienna, GOA for
 *    Genoa). The resolver has a dedicated `iata` index built from `airports`;
 *    letting these into the `exact` index would shadow it.
 *
 * Order is alphabetical, for a stable diff. There is deliberately no ranking:
 * GeoNames sorts this field alphabetically already, so there is no importance
 * signal to recover, and a similarity ranking was measured to keep "Florenc,
 * Florenca, Florenci, Florenco" while discarding "Firenze".
 */
export function pickAliases(city: City): string[] {
  const seen = new Set<string>([fold(city.name)]);
  const kept: string[] = [];
  const consider = (raw: string) => {
    const value = raw.trim();
    if (value.length < MIN_AUTO_ALIAS_LENGTH) return;
    if (!hasLatin(value)) return;
    if (/^[A-Z]{2,3}$/.test(value)) return;
    const key = fold(value);
    if (!key || key.length < MIN_AUTO_ALIAS_LENGTH || seen.has(key)) return;
    seen.add(key);
    kept.push(value);
  };
  consider(city.asciiName);
  for (const alt of city.alternateNames) consider(alt);
  const cap =
    city.population >= MAJOR_POPULATION
      ? MAX_ALIASES_MAJOR
      : city.population >= MID_POPULATION
        ? MAX_ALIASES_MID
        : MAX_ALIASES_TAIL;
  kept.sort((a, b) => (fold(a) < fold(b) ? -1 : 1));
  return kept.slice(0, cap);
}

// ─── The join ────────────────────────────────────────────────────────────────

function gravityScore(population: number, km: number): number {
  return Math.max(1, population) / (1 + Math.pow(km / ASSIGN_HALF_KM, ASSIGN_EXPONENT));
}

export type Assignment = { airport: Airport; city: City | null; km: number };

/** Assign every airport its one primary city. See ASSIGNMENT above. */
export function assignAirports(airports: Airport[], cities: City[]): Assignment[] {
  const grid = new Grid(cities);
  const out: Assignment[] = [];
  for (const airport of airports) {
    let best: { city: City; km: number } | null = null;
    let bestScore = -1;
    for (const { item, km } of grid.within(airport, ASSIGN_RADIUS_KM)) {
      if (item.country !== airport.country) continue;
      const score = gravityScore(item.population, km);
      if (score > bestScore) {
        bestScore = score;
        best = { city: item, km };
      }
    }
    out.push({ airport, city: best?.city ?? null, km: best?.km ?? 0 });
  }
  return out;
}

/**
 * Airports too remote for any city in the dump: 299 of 4,008 (7.5%), almost
 * all Alaskan bush strips, Solomon Islands and Papua New Guinea. They get a
 * place of their own built from the airport's own municipality, so typing
 * "Unalaska" or "Tununak" resolves instead of falling through to fuzzy.
 */
function syntheticName(airport: Airport): string {
  if (airport.municipality) {
    // "Paris (Roissy-en-France, Val-d'Oise)" -> "Paris"; "London, Essex" -> "London"
    const cleaned = airport.municipality.replace(/\s*\(.*$/, '').split(',')[0].trim();
    if (cleaned) return cleaned;
  }
  return airport.name.replace(/\s+(International\s+)?(Airport|Airfield|Airstrip|Aerodrome)$/i, '').trim() || airport.iata;
}

// ─── Curated reference resolution ────────────────────────────────────────────

type CityIndex = Map<string, City[]>;

function indexCities(cities: City[]): CityIndex {
  const index: CityIndex = new Map();
  const add = (key: string, city: City) => {
    const k = `${city.country}|${key}`;
    const bucket = index.get(k);
    if (bucket) bucket.push(city);
    else index.set(k, [city]);
  };
  for (const city of cities) {
    add(fold(city.name), city);
    const ascii = fold(city.asciiName);
    if (ascii !== fold(city.name)) add(ascii, city);
  }
  return index;
}

/**
 * Resolve a hand-written reference to exactly one city, or throw.
 *
 * A curated override that silently matches nothing is the same class of bug as
 * the one the curated layer exists to fix, so the build fails on it.
 */
function resolveRef(index: CityIndex, ref: CityRef, context: string): City {
  const matches = (index.get(`${ref.country}|${fold(ref.name)}`) ?? []).filter(
    (c) => !ref.admin || c.admin1 === ref.admin,
  );
  if (!matches.length) {
    throw new Error(
      `curated reference matched no city: "${ref.name}" ${ref.country}` +
        `${ref.admin ? `.${ref.admin}` : ''} (${context}). ` +
        'Check the spelling against the GeoNames dump — it files local names ' +
        'under English exonyms and suffixes some Japanese cities "-shi".',
    );
  }
  matches.sort((a, b) => b.population - a.population);
  return matches[0];
}

// ─── Assembly ────────────────────────────────────────────────────────────────

type Attachment = { iata: string; km: number; servesPlace: boolean; ordinal: number };

function orderAirports(
  attachments: Attachment[],
  curatedOrder: string[],
  cap: number,
): PlaceAirport[] {
  const rank = new Map<string, number>();
  curatedOrder.forEach((iata, i) => rank.set(iata, i));
  const seen = new Set<string>();
  const unique: Attachment[] = [];
  for (const a of attachments) {
    if (seen.has(a.iata)) continue;
    seen.add(a.iata);
    unique.push(a);
  }
  unique.sort((a, b) => {
    const ra = rank.has(a.iata) ? rank.get(a.iata)! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.iata) ? rank.get(b.iata)! : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    // Annual passengers are not openly licensed, so the OurAirports type
    // ordinal stands in for them, then distance. Ties break on the code so the
    // artifact diff is stable across rebuilds.
    if (a.ordinal !== b.ordinal) return b.ordinal - a.ordinal;
    if (a.km !== b.km) return a.km - b.km;
    return a.iata < b.iata ? -1 : 1;
  });
  return unique.slice(0, cap).map((a) => ({ iata: a.iata, km: a.km, servesPlace: a.servesPlace }));
}

function maxOrdinal(airports: PlaceAirport[], byIata: Map<string, Airport>): number | null {
  let best: number | null = null;
  for (const a of airports) {
    if (!a.servesPlace) continue;
    const ordinal = byIata.get(a.iata)?.ordinal ?? null;
    if (ordinal !== null && (best === null || ordinal > best)) best = ordinal;
  }
  return best;
}

export function build(inputs: BuildInputs): BuildResult {
  const parsedAirports = parseAirports(inputs.airportsCsv);
  const airports = parsedAirports.airports;
  const byIata = new Map(airports.map((a) => [a.iata, a]));
  const cities = parseCities(inputs.citiesTsv);
  const prominenceTierIds = countCityRows(inputs.prominenceTierTsv);
  const midTierIds = countCityRows(inputs.midTierTsv);
  const admin1Rows = parseAdmin1(inputs.admin1Tsv);
  const countryRows = parseCountryInfo(inputs.countryInfoTsv);

  // 1. Primary assignment.
  const assignments = assignAirports(airports, cities);
  const primaryByCity = new Map<string, Assignment[]>();
  const orphans: Assignment[] = [];
  for (const assignment of assignments) {
    if (!assignment.city) {
      orphans.push(assignment);
      continue;
    }
    const bucket = primaryByCity.get(assignment.city.geonameId);
    if (bucket) bucket.push(assignment);
    else primaryByCity.set(assignment.city.geonameId, [assignment]);
  }

  // 1b. The municipality anchor. See MUNICIPALITY_ANCHOR_KM.
  const index = indexCities(cities);
  const anchoredByCity = new Map<string, Assignment[]>();
  let anchoredAirports = 0;
  for (const assignment of assignments) {
    const airport = assignment.airport;
    const named = syntheticName(airport);
    if (!named) continue;
    const candidates = index.get(`${airport.country}|${fold(named)}`) ?? [];
    let best: { city: City; km: number } | null = null;
    for (const candidate of candidates) {
      const km = haversineKm(airport, candidate);
      if (km > MUNICIPALITY_ANCHOR_KM) continue;
      if (!best || km < best.km) best = { city: candidate, km };
    }
    if (!best) continue;
    if (assignment.city && assignment.city.geonameId === best.city.geonameId) continue;
    anchoredAirports++;
    const bucket = anchoredByCity.get(best.city.geonameId);
    const anchored: Assignment = { airport, city: best.city, km: best.km };
    if (bucket) bucket.push(anchored);
    else anchoredByCity.set(best.city.geonameId, [anchored]);
  }

  // 2. Curated references, resolved and asserted.
  const curatedOrderByCity = new Map<string, string[]>();
  const curatedServesByCity = new Map<string, Set<string>>();
  const metroCodeByCity = new Map<string, string>();
  const extraAliasesByCity = new Map<string, string[]>();
  const curatedCityIds = new Set<string>();
  const exhaustiveCities = new Set<string>();

  const addCuratedAirports = (city: City, iatas: string[], context: string) => {
    for (const iata of iatas) {
      if (!byIata.has(iata)) {
        throw new Error(
          `curated airport ${iata} (${context}) is not a scheduled IATA airport in OurAirports. ` +
            'It may have closed, lost scheduled service or been recoded upstream.',
        );
      }
    }
    curatedCityIds.add(city.geonameId);
    const order = curatedOrderByCity.get(city.geonameId) ?? [];
    for (const iata of iatas) if (!order.includes(iata)) order.push(iata);
    curatedOrderByCity.set(city.geonameId, order);
    const serves = curatedServesByCity.get(city.geonameId) ?? new Set<string>();
    for (const iata of iatas) serves.add(iata);
    curatedServesByCity.set(city.geonameId, serves);
  };

  let metroGroupMembers = 0;
  for (const group of METRO_GROUPS) {
    for (const ref of group.members) {
      const city = resolveRef(index, ref, `metro group ${group.key}`);
      metroGroupMembers++;
      addCuratedAirports(city, group.airports, `metro group ${group.key}`);
      if (group.metro) metroCodeByCity.set(city.geonameId, group.metro);
    }
  }
  for (const override of AIRPORT_OVERRIDES) {
    const city = resolveRef(index, override.place, 'airport override');
    addCuratedAirports(city, override.airports, `override for ${override.place.name}`);
    if (override.exhaustive) exhaustiveCities.add(city.geonameId);
  }
  for (const alias of CURATED_ALIASES) {
    const city = resolveRef(index, alias.target, `alias "${alias.alias}"`);
    curatedCityIds.add(city.geonameId);
    const list = extraAliasesByCity.get(city.geonameId) ?? [];
    list.push(alias.alias);
    extraAliasesByCity.set(city.geonameId, list);
  }

  // 3. The trim rule: a union, never a threshold.
  const airportServing = new Set<string>([
    ...primaryByCity.keys(),
    ...anchoredByCity.keys(),
    ...curatedCityIds,
  ]);
  const include: City[] = [];
  for (const city of cities) {
    if (city.population >= POPULATION_FLOOR || airportServing.has(city.geonameId)) include.push(city);
  }
  const includeIds = new Set(include.map((c) => c.geonameId));

  let droppedByFloor = 0;
  let belowMidTier = 0;
  for (const id of airportServing) {
    if (!prominenceTierIds.has(id)) droppedByFloor++;
    if (!midTierIds.has(id)) belowMidTier++;
  }

  // 4. Geographic attachment.
  const airportGrid = new Grid(airports);
  const places: Place[] = [];
  /** Place id -> the hand or inherited prefix its airports[] leads with. */
  const pinned: Record<string, string[]> = {};
  const attachmentsFor = (
    origin: { lat: number; lon: number },
    country: string | null,
    serveAll: boolean,
  ): Attachment[] => {
    const out: Attachment[] = [];
    for (const { item, km } of airportGrid.within(origin, ATTACH_RADIUS_KM)) {
      if (country && item.country !== country) continue;
      out.push({
        iata: item.iata,
        km: roundKm(km),
        servesPlace: serveAll || km <= SERVE_RADIUS_KM,
        ordinal: item.ordinal,
      });
    }
    return out;
  };

  // 5. City places.
  const placeIdByCity = new Map<string, string>();
  for (const city of include) {
    const id = `gn:${city.geonameId}`;
    placeIdByCity.set(city.geonameId, id);
    const curatedOrder = curatedOrderByCity.get(city.geonameId) ?? [];
    const curatedServes = curatedServesByCity.get(city.geonameId) ?? new Set<string>();
    const attachments: Attachment[] = exhaustiveCities.has(city.geonameId)
      ? []
      : attachmentsFor(city, city.country, false);
    // Curated and primary-assigned airports serve the place by definition —
    // this is where "Newark serves New York City" comes from.
    for (const iata of curatedServes) {
      const airport = byIata.get(iata)!;
      attachments.unshift({
        iata,
        km: roundKm(haversineKm(city, airport)),
        servesPlace: true,
        ordinal: airport.ordinal,
      });
    }
    for (const assignment of anchoredByCity.get(city.geonameId) ?? []) {
      attachments.unshift({
        iata: assignment.airport.iata,
        km: roundKm(assignment.km),
        servesPlace: true,
        ordinal: assignment.airport.ordinal,
      });
    }
    for (const assignment of primaryByCity.get(city.geonameId) ?? []) {
      attachments.unshift({
        iata: assignment.airport.iata,
        km: roundKm(assignment.km),
        servesPlace: true,
        ordinal: assignment.airport.ordinal,
      });
    }
    const ordered = orderAirports(attachments, curatedOrder, MAX_AIRPORTS_CITY);
    if (curatedOrder.length) pinned[id] = [...curatedOrder];
    const aliases = [...pickAliases(city), ...(extraAliasesByCity.get(city.geonameId) ?? [])];
    const deduped: string[] = [];
    const seenAlias = new Set<string>([fold(city.name)]);
    for (const alias of aliases) {
      const key = fold(alias);
      if (!key || seenAlias.has(key)) continue;
      seenAlias.add(key);
      deduped.push(alias);
    }
    places.push({
      id,
      name: city.name,
      aliases: deduped,
      kind: 'city',
      country: city.country,
      admin: city.admin1 || null,
      lat: city.lat,
      lon: city.lon,
      population: city.population || null,
      airportRank: maxOrdinal(ordered, byIata),
      metro: metroCodeByCity.get(city.geonameId) ?? null,
      airports: ordered,
    });
  }

  // 6. Synthetic places for airports no city reaches.
  for (const orphan of orphans) {
    const airport = orphan.airport;
    const attachments = attachmentsFor(airport, airport.country, false);
    attachments.unshift({ iata: airport.iata, km: 0, servesPlace: true, ordinal: airport.ordinal });
    const ordered = orderAirports(attachments, [airport.iata], MAX_AIRPORTS_CITY);
    pinned[`ap:${airport.iata}`] = [airport.iata];
    places.push({
      id: `ap:${airport.iata}`,
      name: syntheticName(airport),
      aliases: [],
      kind: 'city',
      country: airport.country,
      admin: airport.isoRegion.includes('-') ? airport.isoRegion.split('-')[1] : null,
      lat: airport.lat,
      lon: airport.lon,
      population: null,
      airportRank: airport.ordinal,
      metro: null,
      airports: ordered,
    });
  }

  // 7. Curated metro and region places.
  for (const curated of CURATED_PLACES) {
    for (const iata of curated.airports) {
      if (!byIata.has(iata)) {
        throw new Error(`curated place ${curated.slug} names ${iata}, which is not a scheduled IATA airport`);
      }
    }
    const attachments: Attachment[] = curated.airports.map((iata) => {
      const airport = byIata.get(iata)!;
      return {
        iata,
        km: roundKm(haversineKm(curated, airport)),
        servesPlace: true,
        ordinal: airport.ordinal,
      };
    });
    const ordered = orderAirports(attachments, curated.airports, curated.airports.length);
    pinned[`cur:${curated.slug}`] = [...curated.airports];
    places.push({
      id: `cur:${curated.slug}`,
      name: curated.name,
      aliases: curated.aliases,
      kind: curated.kind,
      country: curated.country,
      admin: curated.admin,
      lat: curated.lat,
      lon: curated.lon,
      population: null,
      airportRank: maxOrdinal(ordered, byIata),
      metro: curated.metro,
      airports: ordered,
    });
  }

  // 8. Admin1 regions. A bare state gives every airport that serves it, each
  //    with its distance — BUF at 470 km from the New York centroid is a
  //    useful answer, not a wrong one, because the traveller sees the number.
  const citiesByAdmin1 = new Map<string, City[]>();
  for (const city of include) {
    if (!city.admin1) continue;
    const key = `${city.country}.${city.admin1}`;
    const bucket = citiesByAdmin1.get(key);
    if (bucket) bucket.push(city);
    else citiesByAdmin1.set(key, [city]);
  }
  const regionOverrides = new Map(REGION_AIRPORT_OVERRIDES.map((o) => [o.admin1, o.airports]));
  const admin1ByCode = new Map(admin1Rows.map((r) => [r.code, r]));
  for (const [code, members] of citiesByAdmin1) {
    const row = admin1ByCode.get(code);
    if (!row) continue;
    const totalPopulation = members.reduce((sum, c) => sum + c.population, 0);
    const weight = totalPopulation > 0 ? (c: City) => c.population : () => 1;
    const weightSum = members.reduce((sum, c) => sum + weight(c), 0) || 1;
    const lat = members.reduce((sum, c) => sum + c.lat * weight(c), 0) / weightSum;
    const lon = members.reduce((sum, c) => sum + c.lon * weight(c), 0) / weightSum;
    // A REGION INHERITS THE HAND ORDER OF ITS LEADING METRO.
    //
    // Without this, `Kyoto` the prefecture leads with ITM while `Kyoto` the
    // city leads with KIX, and the District of Columbia leads with DCA while
    // Washington leads with IAD — because the derived sort is type-then-
    // distance and the close-in airport wins. A caller that resolves the
    // region instead of the city would then price from a different airport
    // than the one the curated layer chose, which is the exact failure the
    // hand order exists to prevent. Inheriting costs no hand maintenance.
    const leadingMember = [...members].sort((a, b) => b.population - a.population)[0];
    const inherited = leadingMember ? (curatedOrderByCity.get(leadingMember.geonameId) ?? []) : [];
    const curatedOrder = regionOverrides.get(code) ?? inherited;
    for (const iata of curatedOrder) {
      if (!byIata.has(iata)) throw new Error(`region override ${code} names unknown airport ${iata}`);
    }
    const attachments: Attachment[] = [];
    // Airports whose primary city is in this region are in it by construction.
    for (const member of members) {
      for (const assignment of primaryByCity.get(member.geonameId) ?? []) {
        attachments.push({
          iata: assignment.airport.iata,
          km: roundKm(haversineKm({ lat, lon }, assignment.airport)),
          servesPlace: true,
          ordinal: assignment.airport.ordinal,
        });
      }
    }
    for (const iata of curatedOrder) {
      const airport = byIata.get(iata)!;
      attachments.push({
        iata,
        km: roundKm(haversineKm({ lat, lon }, airport)),
        servesPlace: true,
        ordinal: airport.ordinal,
      });
    }
    // serveAll: every airport near a region serves the region. See the
    // servesPlace note above. This is what attaches PHL to Delaware.
    for (const attachment of attachmentsFor({ lat, lon }, row.country, true)) {
      attachments.push(attachment);
    }
    const ordered = orderAirports(attachments, curatedOrder, MAX_AIRPORTS_REGION);
    if (curatedOrder.length) pinned[`adm:${code}`] = [...curatedOrder];
    const aliases: string[] = [];
    if (row.asciiName && fold(row.asciiName) !== fold(row.name)) aliases.push(row.asciiName);
    // Only alphabetic admin1 codes are names a traveller types. GeoNames uses
    // opaque numbers for most countries (FR.11, IT.09) and "ESYE42" for Greece.
    if (/^[A-Za-z]{2,3}$/.test(row.admin1)) aliases.push(row.admin1.toUpperCase());
    places.push({
      id: `adm:${code}`,
      name: row.name,
      aliases,
      kind: row.country === 'US' ? 'state' : 'region',
      country: row.country,
      admin: row.admin1,
      lat: roundCoord(lat),
      lon: roundCoord(lon),
      // Sum of the included cities, NOT a census figure. Raw, like every other
      // weight in this artifact.
      population: totalPopulation || null,
      airportRank: maxOrdinal(ordered, byIata),
      metro: null,
      airports: ordered,
    });
  }

  // 9. Countries.
  const citiesByCountry = new Map<string, City[]>();
  for (const city of include) {
    const bucket = citiesByCountry.get(city.country);
    if (bucket) bucket.push(city);
    else citiesByCountry.set(city.country, [city]);
  }
  const airportsByCountry = new Map<string, Airport[]>();
  for (const airport of airports) {
    const bucket = airportsByCountry.get(airport.country);
    if (bucket) bucket.push(airport);
    else airportsByCountry.set(airport.country, [airport]);
  }
  for (const country of countryRows) {
    const members = citiesByCountry.get(country.iso2) ?? [];
    const countryAirports = airportsByCountry.get(country.iso2) ?? [];
    if (!members.length && !countryAirports.length) continue;
    const weightSum = members.reduce((sum, c) => sum + Math.max(1, c.population), 0) || 1;
    const lat = members.length
      ? members.reduce((sum, c) => sum + c.lat * Math.max(1, c.population), 0) / weightSum
      : (countryAirports[0]?.lat ?? 0);
    const lon = members.length
      ? members.reduce((sum, c) => sum + c.lon * Math.max(1, c.population), 0) / weightSum
      : (countryAirports[0]?.lon ?? 0);
    const attachments: Attachment[] = countryAirports.map((airport) => ({
      iata: airport.iata,
      km: roundKm(haversineKm({ lat, lon }, airport)),
      servesPlace: true,
      ordinal: airport.ordinal,
    }));
    const ordered = orderAirports(attachments, [], MAX_AIRPORTS_COUNTRY);
    places.push({
      id: `cty:${country.iso2}`,
      name: country.name,
      aliases: [country.iso2, country.iso3],
      kind: 'country',
      country: country.iso2,
      admin: null,
      lat: roundCoord(lat),
      lon: roundCoord(lon),
      population: null,
      airportRank: maxOrdinal(ordered, byIata),
      metro: null,
      airports: ordered,
    });
  }

  // Deterministic order so the artifact diff reads as a changelog.
  places.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const kinds: Record<string, number> = {};
  for (const place of places) kinds[place.kind] = (kinds[place.kind] ?? 0) + 1;

  const artifact: LocationArtifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: inputs.generatedAt,
    sources: inputs.sourceDates,
    places,
  };

  const ranks: AirportRankTable = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: inputs.generatedAt,
    basis: 'ourairports-type-ordinal',
    ranks: Object.fromEntries(
      [...byIata.values()]
        .sort((a, b) => (a.iata < b.iata ? -1 : 1))
        .map((a) => [a.iata, a.ordinal]),
    ),
    pinned: Object.fromEntries(Object.keys(pinned).sort().map((id) => [id, pinned[id]])),
  };

  return {
    artifact,
    ranks,
    stats: {
      airportRows: parsedAirports.all,
      airportsWithIata: parsedAirports.withIata,
      scheduledIataAirports: airports.length,
      dirtyMunicipalityPct: parsedAirports.dirtyPct,
      cityRowsRead: cities.length,
      cityUniverse: includeIds.size,
      assignedAirports: airports.length - orphans.length,
      anchoredAirports,
      orphanAirports: orphans.length,
      syntheticPlaces: orphans.length,
      airportServingCities: airportServing.size,
      droppedByProminenceFloor: droppedByFloor,
      droppedByProminenceFloorPct: airportServing.size
        ? (100 * droppedByFloor) / airportServing.size
        : 0,
      belowMidTier,
      places: kinds,
      curatedPlaces: CURATED_PLACES.length,
      curatedAliases: CURATED_ALIASES.length,
      metroGroupMembers,
    },
  };
}
