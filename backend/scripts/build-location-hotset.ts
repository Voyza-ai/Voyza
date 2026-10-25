#!/usr/bin/env tsx
/**
 * Build the browser hot set from the checked-in artifact.
 *
 *   npm run build:location-hotset
 *   npm run build:location-hotset -- --dry-run   # measure, write nothing
 *
 * This is a DERIVED artifact: it reads `src/data/generated/places.json` and
 * writes a much smaller file to BOTH packages. Re-run it after
 * `build:location-data`.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * The owner's instruction was "lets not build 2 copies, find a way to have a
 * shared file", about `backend/src/data/originAirports.ts` and
 * `frontend/lib/originAirports.ts` — two hand-maintained copies of a 68-key
 * table, kept honest by a parity test that compares their source text.
 *
 * One file imported by both is not available here, and the parity test says
 * why: the two packages have no workspace root, backend's tsconfig pins
 * `rootDir: ./src` so it refuses to compile anything outside src/, and Next's
 * bundler scope stops at frontend/. Changing any of those is a build-system
 * project with a live Railway deploy attached.
 *
 * So the duplication is removed where it actually hurts: nothing is
 * hand-maintained twice any more. There is one source of truth (the generator
 * and its curated input), and both packages receive the same emitted bytes,
 * asserted byte-for-byte by a parity test. A copy a human edits is a copy that
 * drifts; a copy a script writes is a build output.
 *
 * ── The property that makes a hot set safe ──────────────────────────────────
 *
 * A subset of the data is not automatically a subset of the ANSWERS. If the
 * browser held Venice, Italy but not Venice, Florida, it would answer `Venice`
 * confidently while the server asked — and the two would disagree about a
 * booking.
 *
 * So the hot set stores ANSWERS, not places, and a key is included only when
 * its whole candidate set came along. Every key in here resolves exactly as
 * the full artifact does; anything else is simply absent and the browser asks
 * the server. `locationHotSet.test.ts` asserts that over every key.
 *
 * Context is handled by the same honesty. A key with ONE candidate cannot be
 * changed by the traveller's position or their trip, so the browser may answer
 * it offline. A key with more than one can, because the context rules run
 * before the prominence rules, so the browser answers it offline only when it
 * has no context at all, and asks the server when it does.
 */

import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { retiredInputs } from '../src/data/retiredOriginAirports';
import { LOCATION_DATA_ATTRIBUTION, type DataAttribution } from '../src/data/attribution';
import { locationArtifact } from '../src/data/locationArtifact';
import { buildIndex } from '../src/services/location/buildIndex';
import { keysForQuery, normalizeKeys } from '../src/services/location/normalize';
import { DEFAULT_OPTIONS } from '../src/services/location/options';
import { resolve } from '../src/services/location/resolve';
import { prominenceOf } from '../src/services/location/prominence';
import type { Place } from '../src/services/location/types';

const BACKEND_ROOT = join(__dirname, '..');
const REPO_ROOT = join(BACKEND_ROOT, '..');

/**
 * The shared normaliser: one AUTHORED file, one generated copy.
 *
 * Not a second hand-maintained file. The owner asked for one shared file and
 * was right to; a single file imported by both packages is not available here
 * (no workspace root, backend's `rootDir: ./src`, Next's bundler scope), so
 * the next best thing is one source of truth and a copy nobody edits.
 */
const KEYS_SOURCE = join(BACKEND_ROOT, 'src', 'services', 'location', 'keys.ts');
const KEYS_COPY = join(REPO_ROOT, 'frontend', 'lib', 'locationKeys.ts');

/** Both packages get the same bytes. The parity test compares them. */
const OUT_FILES = [
  join(BACKEND_ROOT, 'src', 'data', 'generated', 'locationHotSet.json'),
  join(REPO_ROOT, 'frontend', 'lib', 'generated', 'locationHotSet.json'),
];

/**
 * The budget from the architecture doc. Asserted here rather than trusted,
 * because a hot set that quietly grows is a page-load regression nobody
 * notices until it is 400 KB.
 */
const GZIP_BUDGET_BYTES = 60 * 1024;

export const HOT_SET_SCHEMA_VERSION = 1;

/** Status codes, kept to one character because they repeat thousands of times. */
type HotStatus = 'ok' | 'ask';

type HotEntry = { s: HotStatus; ids: string[]; v?: string };

type HotPlace = {
  /** Display name. */
  n: string;
  c: string;
  a: string | null;
  /** Kind. */
  t: Place['kind'];
  /** `[iata, km, servesPlace ? 1 : 0]`, in artifact order. */
  ap: Array<[string, number, 0 | 1]>;
  lat: number;
  lon: number;
};

export type LocationHotSet = {
  schemaVersion: number;
  generatedAt: string;
  /** Artifact this was derived from, so a stale pair is visible. */
  artifact: { schemaVersion: number; generatedAt: string };
  /**
   * The resolver constants the browser needs to reproduce the
   * user-location rule, emitted rather than duplicated so the two cannot
   * drift. From DEFAULT_OPTIONS; see options.ts for what each was measured
   * against.
   */
  options: {
    locationDominanceRatio: number;
    locationDominanceKm: number;
    userLocalKm: number;
  };
  /**
   * GeoNames credit, carried so the frontend renders the licence's own words
   * rather than a second copy someone paraphrased. CC BY 4.0 requires it
   * wherever this data is shown.
   */
  attribution: DataAttribution;
  places: Record<string, HotPlace>;
  /**
   * Normalised key -> the stored answer.
   *
   * `ids` is ordered exactly as the resolver ordered it, so `ids[0]` is the
   * answer and the rest are the other candidates.
   *
   * `v` is the resolver's `via`, present only on an `ok` answer, and it is
   * what tells the browser whether CONTEXT could have changed the outcome.
   * Storing only the winner loses that: a key resolved from a single
   * candidate is context-proof, while one resolved by prominence had rivals
   * and the traveller's position or trip would have been consulted first.
   *
   * `prominence` is the only `via` that means "there were rivals" — every
   * other one (`exact-unique`, `curated-alias`, `qualifier-pinned`,
   * `iata-code`) is reached with exactly one candidate in hand. So the
   * browser answers a `prominence` key offline only when it has no context,
   * and asks the server when it has some.
   */
  exact: Record<string, { s: HotStatus; ids: string[]; v?: string }>;
  iata: Record<string, string>;
  /**
   * Display names for the codes the shipped places carry, so the browser can
   * build the SAME label the server builds.
   *
   * Without these the browser can only label a candidate from codes, and a
   * question reading "Paris, 11, FR" or "Washington, WA, US" is a worse
   * question than one reading "Paris, Ile-de-France, France". The alternative
   * considered was deferring every ambiguous answer to the server purely to
   * get labels - a round trip for text - when the names needed are only those
   * of the places that shipped: a few hundred entries, not the artifact's
   * 2,842 regions.
   *
   * Keyed exactly as the server's own indexes are (`COUNTRY`, and
   * `COUNTRY:ADMIN`) so the two label functions cannot drift in how they look
   * a name up. `locationHotSet.test.ts` asserts the browser's label matches
   * the server's for every shipped place.
   */
  countryNames: Record<string, string>;
  adminNames: Record<string, string>;
};

const index = buildIndex(locationArtifact);

function hotPlace(place: Place): HotPlace {
  return {
    n: place.name,
    c: place.country,
    a: place.admin,
    t: place.kind,
    ap: place.airports.map((a) => [a.iata, Math.round(a.km), a.servesPlace ? 1 : 0]),
    lat: Number(place.lat.toFixed(4)),
    lon: Number(place.lon.toFixed(4)),
  };
}

/**
 * Candidate places, most useful first.
 *
 * Two groups get in ahead of prominence, and only two:
 *
 *  - CURATED entries and metros. `nyc`, `la`, `the bay area` and
 *    `silicon valley` are the inputs no open dataset covers, which makes them
 *    the ones a hand-written table used to be needed for. They survive any
 *    budget.
 *  - US STATES. They carry the abbreviation collisions the whole design
 *    worries about — 31 of the 56 state codes are also country codes — and
 *    `nj`, `ny` and `ca` are things people really type into an origin field.
 *
 * After those, only CITIES are seeded, by prominence.
 *
 * Regions and countries are deliberately not seeded, and getting there took
 * two wrong answers worth recording.
 *
 * The first version seeded all 237 countries ahead of every city. The second
 * dropped that and seeded regions and countries alongside cities on
 * prominence. Both shipped a hot set with no `paris`, `rome`, `boston` or
 * `venice` in it. The reason is in the pipeline's own notes: a region's
 * `population` is the SUM of its member cities, not a census figure, so all
 * 2,842 admin regions outrank nearly every city. Measured, Paris ranked
 * 543rd and Venice 10,827th, behind `Guangdong`, `Shandong` and `England`.
 *
 * Ranking by `airportRank` alone is not the fix either — measured, it is far
 * too coarse, and its top of the table comes out as `Abu Dhabi, Ajman, Dubai,
 * Fujairah`, which is ties broken alphabetically by country code.
 *
 * So cities compete with cities. A region or a country still SHIPS when it is
 * a candidate of an admitted key, which is exactly when it can affect an
 * answer; it just does not spend a seed slot. And a country is a poor answer
 * for an origin field anyway: "Germany" cannot say which airport. Typed as an
 * origin it defers to the server and resolves there.
 */
function rankedPlaces(): Place[] {
  // MUST-HAVE, ahead of everything: every place the retired hand-written
  // table could answer. Those inputs are the one independent record of which
  // airports a traveller flies from, so the 60 KB budget may never be spent
  // somewhere that leaves one of them unanswerable offline.
  // `locationHotSet.test.ts` asserts that coverage rather than trusting it.
  // It is also what reaches the US metros the table was built for —
  // `providence`, `hartford`, `fort worth`, `twin cities` — none of which a
  // global prominence ranking gets near.
  const mustHave = new Set<string>();
  for (const input of retiredInputs()) {
    // RESOLVED, not looked up. The retired list holds inputs as a person
    // wrote them — `Newark, NJ`, `Portland, Oregon`, `  Long Island  ` —
    // and a normalised lookup into `answerByKey` misses every qualified one,
    // because comma forms are not index keys. Measured: it silently failed
    // to seed Portland, Oregon at all, so `portland` was not even a hot-set
    // key and the browser answered nothing for an input the table answered.
    const truth = resolve(input, {}, index);
    if (truth.status === 'resolved') mustHave.add(truth.place.id);
    else if (truth.status === 'ambiguous') {
      for (const candidate of truth.candidates) mustHave.add(candidate.place.id);
    }
  }

  const required: Place[] = [];
  const reserved: Place[] = [];
  const cities: Place[] = [];
  for (const place of locationArtifact.places) {
    if (mustHave.has(place.id)) required.push(place);
    else if (place.curatedAliases.length > 0 || place.kind === 'metro' || place.kind === 'state') {
      reserved.push(place);
    } else if (place.kind === 'city') {
      cities.push(place);
    }
  }
  const byProminence = (a: Place, b: Place): number =>
    prominenceOf(b) - prominenceOf(a) || a.id.localeCompare(b.id);
  return [
    ...required.sort(byProminence),
    ...reserved.sort(byProminence),
    ...cities.sort(byProminence),
  ];
}

/**
 * `placeId -> the keys it is indexed under`, built in ONE pass.
 *
 * The obvious shape — ask the index which keys a place owns, per place — is
 * O(places x keys), which is 20,000 x 176,000 inside a bisection loop. Read
 * off the index once and inverted, it is one pass.
 */
const keysByPlace = ((): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const [key, matches] of index.exact) {
    for (const match of matches) {
      const held = out.get(match.id);
      if (held) held.push(key);
      else out.set(match.id, [key]);
    }
  }
  return out;
})();

/**
 * The no-context answer for every key in the artifact, resolved ONCE.
 *
 * Also outside the bisection: `build` is called about fifteen times while
 * fitting the budget, and resolving 176,000 keys each time would turn a
 * two-second script into a minute of identical work.
 */
const answerByKey = ((): Map<string, HotEntry> => {
  const out = new Map<string, HotEntry>();
  for (const key of index.exact.keys()) {
    const result = resolve(key, {}, index);
    // `unknown` keys are not worth shipping: a browser miss already produces
    // the same outcome, and a suggestion list is the server's job.
    if (result.status === 'unknown') continue;
    out.set(
      key,
      result.status === 'resolved'
        ? { s: 'ok', ids: [result.place.id], v: result.via }
        : { s: 'ask', ids: result.candidates.map((candidate) => candidate.place.id) },
    );
  }
  return out;
})();

const ranked = rankedPlaces();

function build(limit: number): LocationHotSet {
  const chosen = new Set<string>();
  for (const place of ranked.slice(0, limit)) chosen.add(place.id);

  const candidateKeys = new Set<string>();
  for (const id of chosen) {
    for (const key of keysByPlace.get(id) ?? []) candidateKeys.add(key);
  }

  const exact: LocationHotSet['exact'] = {};
  const needed = new Set<string>();

  for (const key of candidateKeys) {
    const answer = answerByKey.get(key);
    if (!answer) continue;

    // THE PROPERTY. The stored answer is the one the FULL artifact gives, and
    // every place it names ships with it — including places far below the
    // seed cut. The browser then replays an answer rather than recomputing
    // one from a subset, so a key present here cannot disagree with the
    // server about a booking.
    //
    // Requiring the rivals to be seeds in their own right was the first
    // attempt and it failed in the worst possible place, measured: `la`
    // resolved offline while `los angeles` deferred, along with `london`,
    // `paris`, `rome` and `boston`. Popular city names share their spelling
    // with small towns that never make a prominence cut, so the rule dropped
    // precisely the highest-traffic keys. Shipping the rivals costs one entry
    // each and is bounded anyway: an ambiguous answer carries at most
    // `maxCandidates` of them.
    exact[key] = answer;
    for (const id of answer.ids) needed.add(id);
  }

  // `Washington State` and `New York State` resolve through the resolver's
  // admin-suffix path, which is not an `exact` key — so without this the hot
  // set misses two inputs the hand-written table answers, which are exactly
  // the two the resolver itself used to miss. Mirrored here for the admin
  // places that shipped, which is a hundred-odd keys, not thousands.
  for (const id of [...needed]) {
    const place = index.byId.get(id);
    if (!place || (place.kind !== 'state' && place.kind !== 'region')) continue;
    for (const base of keysByPlace.get(id) ?? []) {
      for (const suffix of [' state', ' province']) {
        const key = `${base}${suffix}`;
        if (exact[key]) continue;

        // ASK the resolver. Assuming the suffixed form resolves to this place
        // was the first version and it was wrong five ways: `montana state`
        // is ambiguous because Montana is also a province of Bulgaria, and
        // `al state`, `la state`, `ne state` and `ar state` each match
        // several administrative places. Inventing those answers made the hot
        // set claim a confident `Montana, US` where the server asks — the
        // exact divergence this whole file is built to prevent.
        const truth = resolve(key, {}, index);
        if (truth.status !== 'resolved' || truth.place.id !== id) continue;
        exact[key] = { s: 'ok', ids: [id], v: truth.via };
      }
    }
  }

  // COMMA-QUALIFIED forms: `Newark, NJ`, `Paris, France`, `Berlin, DE`.
  //
  // Without these the browser answers nothing for the single most common
  // shape a user or an AI produces. `originAirports.ts`'s own comments call
  // `"<City>, <State>"` the form its AI parser emits most often, and measured
  // against the table, `Newark, NJ`, `Buffalo, NY` and `Vancouver, WA` all
  // came back empty offline while the table answered all three. That gap is
  // what keeps the three synchronous call sites on the hand-written table.
  //
  // The comma matters on both sides and in different ways. The RESOLVER
  // splits on commas first, so the truth has to be asked with the comma in
  // place (`Newark, NJ`) or it looks like one long head and misses. The KEY,
  // by contrast, has no comma at all: normalisation turns `,` into a space,
  // so the browser's `keysForQuery('Newark, NJ')` yields `newark nj` and that
  // is what has to be stored.
  //
  // Verified one by one rather than assumed, for the same reason the suffix
  // block above is: a form that does NOT resolve to the place it was built
  // from is dropped, so `Paris, Texas` can never be stored as Paris, France.
  for (const id of [...needed]) {
    const place = index.byId.get(id);
    if (!place) continue;
    const country = place.country.toUpperCase();
    const qualifiers = [
      place.admin,
      place.admin ? index.adminNames.get(`${country}:${place.admin.toUpperCase()}`) : null,
      country,
      index.countryNames.get(country),
    ];

    // `City, State, Country` as well as `City, State`. Three segments is a
    // real shape — `Brooklyn, New York, USA` is in the retired table's own
    // tests as the form its AI parser produced — and the resolver handles it
    // by walking the commas right to left. One extra form per place, not a
    // combinatorial expansion.
    const adminName = place.admin
      ? index.adminNames.get(`${country}:${place.admin.toUpperCase()}`)
      : null;
    const countryName = index.countryNames.get(country);
    if (adminName && countryName) {
      qualifiers.push(`${adminName}, ${countryName}`);
      qualifiers.push(`${adminName}, ${country}`);
    }

    for (const qualifier of qualifiers) {
      if (!qualifier) continue;
      // Only a qualifier the INDEX recognises. GeoNames admin1 codes are
      // numeric in much of the world, so the naive version generated
      // `shanghai 23`, `mumbai 16` and `mexico city 09` — keys no human
      // types, and worse, keys the server answers differently. With a comma
      // the resolver IGNORES an unrecognised middle segment by design (so
      // `Paris, 75001, France` is still Paris), but the stored key has no
      // comma, so `shanghai 23` arrives as one long head and misses. The hot
      // set would then have claimed an answer the server does not give.
      // Tested on each comma segment of the qualifier, so a two-part
      // `Oregon, United States` passes on `oregon` rather than being
      // rejected because the joined string is not a qualifier key.
      const segments = qualifier.split(',').map((part) => part.trim());
      if (!segments.every((part) => normalizeKeys(part).some((key) => index.qualifier.has(key)))) {
        continue;
      }
      const typed = `${place.name}, ${qualifier}`;
      const [key] = keysForQuery(typed);
      if (!key || exact[key]) continue;
      const truth = resolve(typed, {}, index);
      if (truth.status !== 'resolved' || truth.place.id !== id) continue;
      exact[key] = { s: 'ok', ids: [id], v: truth.via };
    }
  }

  // THE COVERAGE GUARANTEE, by construction rather than by hoping the
  // generated forms happen to line up.
  //
  // Everything above generates forms from the artifact's own spellings, which
  // misses the ones a person actually typed: the retired table answered
  // `Brooklyn, New York, USA`, and "USA" is an ALIAS of the United States,
  // not its display name, so the generated form came out as
  // `Brooklyn, New York, United States` and keyed something else.
  //
  // So the retired inputs get a pass of their own: resolve each one, store
  // its normalised key, and the hot set cannot fail to answer offline
  // anything the table it replaced could answer. 146 keys at most, and
  // `locationHotSet.test.ts` asserts the property independently.
  for (const input of retiredInputs()) {
    const truth = resolve(input, {}, index);
    if (truth.status !== 'resolved') continue;
    const [key] = keysForQuery(input);
    if (!key || exact[key]) continue;
    exact[key] = { s: 'ok', ids: [truth.place.id], v: truth.via };
    needed.add(truth.place.id);
  }

  const places: LocationHotSet['places'] = {};
  for (const id of needed) {
    const place = index.byId.get(id);
    if (place) places[id] = hotPlace(place);
  }

  // IATA codes, but only for places that made it in. A code resolving to a
  // place the browser cannot describe is worse than a code it does not know.
  const iata: LocationHotSet['iata'] = {};
  for (const [code, id] of index.iata) {
    if (places[id]) iata[code] = id;
  }

  // Only the names the shipped places actually need. Read off the server's
  // own indexes rather than recomputed, so a label cannot differ by having
  // been derived a second way.
  const countryNames: Record<string, string> = {};
  const adminNames: Record<string, string> = {};
  for (const id of Object.keys(places)) {
    const place = index.byId.get(id);
    if (!place) continue;
    const country = place.country.toUpperCase();
    const countryName = index.countryNames.get(country);
    if (countryName) countryNames[country] = countryName;
    if (place.admin) {
      const key = `${country}:${place.admin.toUpperCase()}`;
      const adminName = index.adminNames.get(key);
      if (adminName) adminNames[key] = adminName;
    }
  }

  return {
    schemaVersion: HOT_SET_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    artifact: {
      schemaVersion: locationArtifact.schemaVersion,
      generatedAt: locationArtifact.generatedAt,
    },
    options: {
      locationDominanceRatio: DEFAULT_OPTIONS.locationDominanceRatio,
      locationDominanceKm: DEFAULT_OPTIONS.locationDominanceKm,
      userLocalKm: DEFAULT_OPTIONS.userLocalKm,
    },
    attribution: LOCATION_DATA_ATTRIBUTION,
    places,
    exact,
    iata,
    countryNames,
    adminNames,
  };
}

function gzipBytes(set: LocationHotSet): number {
  return gzipSync(Buffer.from(JSON.stringify(set), 'utf8')).byteLength;
}

/**
 * Largest place count that still fits the budget, by bisection.
 *
 * Derived rather than hand-tuned so the file tracks the budget across
 * rebuilds instead of silently drifting past it when upstream adds cities.
 */
function fitToBudget(): { set: LocationHotSet; limit: number } {
  let low = 50;
  let high = 20_000;
  let best: { set: LocationHotSet; limit: number } | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const set = build(mid);
    if (gzipBytes(set) <= GZIP_BUDGET_BYTES) {
      best = { set, limit: mid };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (!best) throw new Error('even 50 places exceed the hot-set budget');
  return best;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const { set, limit } = fitToBudget();
  const raw = JSON.stringify(set);
  const gzip = gzipBytes(set);

  console.log('── location hot set ────────────────────────────────────');
  console.log(`  seed places                ${limit}`);
  console.log(`  places shipped             ${Object.keys(set.places).length}`);
  console.log(`  keys                       ${Object.keys(set.exact).length}`);
  console.log(`    answerable offline       ${Object.values(set.exact).filter((e) => e.s === 'ok').length}`);
  console.log(`    ask-the-user             ${Object.values(set.exact).filter((e) => e.s === 'ask').length}`);
  console.log(`  iata codes                 ${Object.keys(set.iata).length}`);
  console.log(`  label names                ${Object.keys(set.countryNames).length} country, ${Object.keys(set.adminNames).length} admin`);
  console.log(`  raw                        ${(raw.length / 1024).toFixed(1)} KiB`);
  console.log(`  gzipped                    ${(gzip / 1024).toFixed(1)} KiB of ${GZIP_BUDGET_BYTES / 1024} KiB budget`);

  if (dryRun) {
    console.log('\nlocation-hotset: dry run, nothing written');
    return;
  }

  for (const file of OUT_FILES) {
    mkdirSync(join(file, '..'), { recursive: true });
    // One line per key keeps the diff readable: a rebuild shows which places
    // entered or left the hot set rather than reflowing the whole file.
    writeFileSync(file, `${raw}\n`, 'utf8');
    console.log(`location-hotset: wrote ${file}`);
  }

  // The normaliser travels with the hot set, for the same reason and by the
  // same mechanism.
  //
  // The browser normalises the traveller's input; the generator normalised the
  // artifact's keys. A lookup only works if both produce the same string, so a
  // divergence between the two copies does not fail loudly — it silently makes
  // whichever spellings it touches unreachable from the browser. Writing the
  // copy here is what turns "please keep these in sync" into a build step.
  //
  // `keys.ts` has no imports, which is what makes a byte-for-byte copy safe,
  // and `locationKeysParity.test.ts` in both packages asserts both properties.
  const keysSource = readFileSync(KEYS_SOURCE, 'utf8');
  mkdirSync(join(KEYS_COPY, '..'), { recursive: true });
  writeFileSync(KEYS_COPY, keysSource, 'utf8');
  console.log(`location-hotset: wrote ${KEYS_COPY}`);
}

if (require.main === module) main();
