/**
 * Airport display names, carried from OurAirports through the pipeline.
 *
 * The bug this suite exists for: `frontend/lib/airportNames.ts` was a
 * hand-written table of ~100 codes, and the resolver returns any of 4,008. So
 * the home card showed "Portland Intl." above PDX and a bare "PWM" above
 * Portland, Maine — the second reading of an ambiguous "Portland" origin,
 * which is exactly the path the clarification banner puts a traveller on.
 *
 * Three things are asserted here, and the third is the one that is easy to
 * get wrong:
 *
 *  1. Coverage. Every code the artifact can hand a caller has a name.
 *  2. Derivation. The rules are rules, not a table of exceptions.
 *  3. The hot set did not pay for it. Names are 44.5 KiB gzipped against 487
 *     bytes of headroom, so they ship as a separate lazy asset — and this
 *     suite measures that rather than trusting the comment that says so.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  airportDisplayName,
  locationAirportNames,
  locationAirportRanks,
  locationArtifact,
} from '../data/locationArtifact';
import { deriveAirportDisplayName } from '../services/location/airportNames';

const FRONTEND_COPY = join(__dirname, '../../../frontend/lib/generated/airportNames.json');
const BACKEND_COPY = join(__dirname, '../data/generated/airportNames.json');
const HOT_SET = join(__dirname, '../data/generated/locationHotSet.json');

const table = locationAirportNames.names;

describe('coverage: every code a caller can be handed has a name', () => {
  it('names every scheduled-IATA airport the ranks table knows', () => {
    // `airportRanks.json` is the independent list of what the dump yielded,
    // built in the same pass from the same rows. If the two disagree, one of
    // them was filtered and the names are a subset of the airports.
    const ranked = Object.keys(locationAirportRanks.ranks);
    expect(ranked.length).toBeGreaterThan(3_500);
    const unnamed = ranked.filter((iata) => !table[iata]);
    expect(unnamed).toEqual([]);
    expect(Object.keys(table).length).toBe(ranked.length);
  });

  it('names every airport attached to any place in the artifact', () => {
    // The other direction, over the shape a caller actually reads: the home
    // card's code comes from a place's `airports[]`, not from the ranks table.
    const referenced = new Set<string>();
    for (const place of locationArtifact.places) {
      for (const airport of place.airports) referenced.add(airport.iata);
    }
    expect(referenced.size).toBeGreaterThan(1_000);
    expect([...referenced].filter((iata) => !table[iata])).toEqual([]);
  });

  it('names PWM, the case that started this', () => {
    // PWM is the second reading of "Portland" and was absent from the
    // hand-written table, so the card rendered a bare code for it. It is also
    // the negative control for that table's size: the old table held ~100
    // codes and this one holds 4,008.
    expect(airportDisplayName('PWM')).toBe('Portland Intl. Jetport');
    expect(airportDisplayName('PDX')).toBe('Portland Intl.');
    expect(Object.keys(table).length).toBeGreaterThan(3_500);
  });

  it('names the airports the retired hand-written table could reach', () => {
    // A sample of codes the old ~100-entry table carried, so a regression
    // that silently narrowed the derivation is visible against what shipped
    // before rather than only against itself.
    expect(airportDisplayName('JFK')).toBe('John F. Kennedy Intl.');
    expect(airportDisplayName('LGA')).toBe('LaGuardia');
    expect(airportDisplayName('EWR')).toBe('Newark Liberty Intl.');
    expect(airportDisplayName('LAX')).toBe('Los Angeles Intl.');
    expect(airportDisplayName('LHR')).toBe('London Heathrow');
    expect(airportDisplayName('CDG')).toBe('Charles de Gaulle Intl.');
    expect(airportDisplayName('HND')).toBe('Tokyo Haneda Intl.');
  });

  it('never yields an empty name', () => {
    // The derivation strips suffixes, so a name that is nothing BUT a suffix
    // would come out empty and render as a blank line above the code.
    const empty = Object.entries(table).filter(([, name]) => !name.trim());
    expect(empty).toEqual([]);
  });

  it('degrades to null rather than to text, for anything it does not know', () => {
    // A caller falls back to the bare code, which it already has. A lookup
    // that returned 'undefined' or the code itself is how a placeholder
    // reaches a traveller as an airport name.
    expect(airportDisplayName('ZZZ')).toBeNull();
    expect(airportDisplayName('')).toBeNull();
    expect(airportDisplayName('nonsense')).toBeNull();
    // Case-insensitive: codes arrive uppercase from the resolver and however
    // they were typed from a stored trip.
    expect(airportDisplayName('pwm')).toBe('Portland Intl. Jetport');
  });
});

describe('the derivation is rules, not a table of exceptions', () => {
  it('abbreviates "International" instead of dropping it', () => {
    // The whole point of keeping "Intl.": dropping the tail turns PDX into a
    // bare "Portland" directly under a card that already says Portland.
    expect(deriveAirportDisplayName('Portland International Airport')).toBe('Portland Intl.');
    expect(deriveAirportDisplayName('Dubai International Airport')).toBe('Dubai Intl.');
  });

  it('takes the civil name when OurAirports joins two facilities with " / "', () => {
    expect(
      deriveAirportDisplayName(
        'Minneapolis–Saint Paul International Airport / Wold–Chamberlain Field',
      ),
    ).toBe('Minneapolis–Saint Paul Intl.');
    expect(deriveAirportDisplayName("Anshan Teng'ao Airport / Anshan Air Base")).toBe(
      "Anshan Teng'ao",
    );
  });

  it('drops a trailing parenthetical', () => {
    expect(deriveAirportDisplayName('Antwerp International Airport (Deurne)')).toBe('Antwerp Intl.');
    expect(deriveAirportDisplayName('Aspen-Pitkin County Airport (Sardy Field)')).toBe(
      'Aspen-Pitkin County',
    );
  });

  it('keeps a facility word that is not the trailing one', () => {
    // "Amsterdam Airport Schiphol" is not "<name> Airport" — stripping the
    // word wherever it appears would give "Amsterdam Schiphol" and, worse,
    // would be a rule about a word rather than about the column's shape.
    expect(deriveAirportDisplayName('Amsterdam Airport Schiphol')).toBe('Amsterdam Airport Schiphol');
    expect(deriveAirportDisplayName('Florence Airport, Peretola')).toBe('Florence Airport, Peretola');
  });

  it('falls back to the raw column rather than returning nothing', () => {
    // A row whose whole name is a facility word. Shortening it to '' would
    // lose the name; the guarantee is that every airport HAS one.
    expect(deriveAirportDisplayName('Airport')).toBe('Airport');
    expect(deriveAirportDisplayName('  Aerodrome  ')).toBe('Aerodrome');
  });

  it('leaves every emitted name unchanged when re-derived', () => {
    // Two properties in one assertion, over all 4,008 rather than sampled.
    //
    // IDEMPOTENCE: `derive(derive(x)) === derive(x)`. Without the fixed-point
    // loop this failed on 23 rows — "Marka International (Amman Civil)
    // Airport" and "Prince George (International) Airport" among them, where
    // the parenthetical sits BEFORE the facility noun, so one pass left a
    // now-trailing parenthetical for the next pass to find.
    //
    // NO HAND EDITS: a row edited in the generated file is no longer what the
    // rules produce, so it fails here rather than surviving as data. That is
    // the guard against this table drifting back into the hand-maintained one
    // it replaced.
    const notFixedPoint = Object.entries(table)
      .filter(([, name]) => deriveAirportDisplayName(name) !== name)
      .map(([iata, name]) => `${iata}: ${name} -> ${deriveAirportDisplayName(name)}`);
    expect(notFixedPoint).toEqual([]);
  });
});

describe('the hot-set budget did not pay for this', () => {
  const hotSetBytes = gzipSync(readFileSync(HOT_SET)).byteLength;

  it('leaves the hot set inside its 60 KiB gzipped budget', () => {
    expect(hotSetBytes).toBeLessThanOrEqual(60 * 1024);
  });

  it('carries no airport names in the hot set, because none of them fit', () => {
    // MEASURED, not assumed. The headroom is 487 bytes. Folding in the names
    // costs, gzipped: all 4,008 +43.7 KiB; only the 1,167 codes the shipped
    // places reference +14.3 KiB; only the 188 codes in the hot set's own
    // `iata` index +2.3 KiB. The smallest non-arbitrary subset still needs
    // 4.8x the headroom, and it is also the wrong subset — a traveller sees
    // codes that came from the server, not from the hot set's places.
    const hotSet = JSON.parse(readFileSync(HOT_SET, 'utf8')) as {
      places: Record<string, { ap: Array<[string, number, 0 | 1]> }>;
      iata: Record<string, string>;
    };
    expect(readFileSync(HOT_SET, 'utf8')).not.toMatch(/airportNames/);

    const headroom = 60 * 1024 - hotSetBytes;
    expect(headroom).toBeLessThan(2 * 1024);

    const subsets: Record<string, string[]> = {
      all: Object.keys(table),
      placeAirports: [
        ...new Set(
          Object.values(hotSet.places).flatMap((place) => place.ap.map(([iata]) => iata)),
        ),
      ],
      iataIndex: Object.keys(hotSet.iata),
    };
    for (const [label, codes] of Object.entries(subsets)) {
      const withNames = {
        ...hotSet,
        airportNames: Object.fromEntries(codes.sort().map((iata) => [iata, table[iata]])),
      };
      const bytes = gzipSync(Buffer.from(JSON.stringify(withNames), 'utf8')).byteLength;
      // Every candidate subset breaks the budget. This is the negative
      // control for the architecture decision: if one of these ever fits,
      // the lazy chunk stops being the only option and this test says so.
      expect({ label, overBudget: bytes > 60 * 1024 }).toEqual({ label, overBudget: true });
    }
  });

  it('ships the names as their own asset, well under 60 KiB gzipped', () => {
    // Not a budget, a page-weight figure to notice if it moves: the chunk is
    // deferred, so it costs nothing until a card asks for a name.
    const bytes = gzipSync(readFileSync(FRONTEND_COPY)).byteLength;
    expect(bytes).toBeLessThan(60 * 1024);
    expect(bytes).toBeGreaterThan(20 * 1024);
  });
});

describe('one generated file, two packages', () => {
  it('is byte-identical in both packages', () => {
    // Written twice by `npm run build:location-hotset`, maintained nowhere.
    expect(readFileSync(FRONTEND_COPY).equals(readFileSync(BACKEND_COPY))).toBe(true);
  });

  it('was built from the artifact that is checked in beside it', () => {
    // A names table from an older build is the same stale-pair hazard the hot
    // set guards against: every assertion here would pass while the resolver
    // handed out codes the table has never heard of.
    expect(locationAirportNames.generatedAt).toBe(locationArtifact.generatedAt);
    expect(locationAirportNames.schemaVersion).toBe(locationArtifact.schemaVersion);
    expect(locationAirportNames.basis).toBe('ourairports-name');
  });
});
