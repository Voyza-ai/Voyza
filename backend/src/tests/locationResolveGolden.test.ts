/**
 * The golden sets from docs/LOCATION_RESOLUTION.md, verbatim.
 *
 * Every case in the must-never set either shipped as a real bug or is one
 * keystroke away from one, so each assertion names the wrong answer as well as
 * the right one: `Berlin, DE` must be Germany, and it must specifically not be
 * Delaware. An assertion that only checks the right answer would still pass if
 * the resolver started returning Delaware for everything.
 *
 * Verified as negative controls — each of these suites fails when the rule it
 * covers is removed. See the comment above each `describe`.
 */

import { buildIndex } from '../services/location/buildIndex';
import { resolve } from '../services/location/resolve';
import { FIXTURE_ARTIFACT, POINTS } from '../services/location/fixtures/artifact';
import type { Resolution } from '../services/location/types';

const index = buildIndex(FIXTURE_ARTIFACT);

const run = (input: string, context = {}): Resolution => resolve(input, context, index);

/** The resolved place, or a readable failure instead of `undefined`. */
function resolvedPlace(result: Resolution) {
  if (result.status !== 'resolved') {
    throw new Error(
      `expected resolved, got ${result.status}: ${JSON.stringify(
        result.status === 'ambiguous'
          ? result.candidates.map((c) => c.label)
          : result.suggestions.map((c) => c.label),
      )}`,
    );
  }
  return result.place;
}

/**
 * Negative control: fails if the qualifier pass is dropped, if `qualifier` is
 * built from city keys as well, or if the two-letter code keys stop being
 * derived from `country` / `admin`.
 */
describe('must never — each of these shipped as a bug or is one keystroke away', () => {
  it('Berlin, DE is Germany, never Delaware', () => {
    const place = resolvedPlace(run('Berlin, DE'));
    expect(place.country).toBe('DE');
    expect(place.name).toBe('Berlin');
    expect(place.admin).not.toBe('DE'); // the Delaware reading
    expect(place.country).not.toBe('US');
  });

  it('Tel Aviv, IL is Israel, never Illinois', () => {
    const place = resolvedPlace(run('Tel Aviv, IL'));
    expect(place.country).toBe('IL');
    expect(place.id).toBe('p-telaviv');
    expect(place.admin).not.toBe('IL');
  });

  it('Casablanca, MA is Morocco, never Massachusetts', () => {
    const place = resolvedPlace(run('Casablanca, MA'));
    expect(place.country).toBe('MA');
    expect(place.id).toBe('p-casablanca');
    expect(place.country).not.toBe('US');
  });

  it('Baton Rouge, LA is Louisiana, never Los Angeles and never Laos', () => {
    const place = resolvedPlace(run('Baton Rouge, LA'));
    expect(place.id).toBe('p-batonrouge');
    expect(place.country).toBe('US');
    expect(place.admin).toBe('LA');
    expect(place.id).not.toBe('p-losangeles');
    expect(place.country).not.toBe('LA'); // Laos
  });

  it('Vancouver, WA is Washington state, never Vancouver BC', () => {
    const place = resolvedPlace(run('Vancouver, WA'));
    expect(place.country).toBe('US');
    expect(place.admin).toBe('WA');
    expect(place.id).not.toBe('p-vancouver-bc');
  });

  it('Bogota, CO is Colombia, never Colorado', () => {
    const place = resolvedPlace(run('Bogota, CO'));
    expect(place.country).toBe('CO');
    expect(place.id).toBe('p-bogota-co');
    expect(place.admin).not.toBe('CO'); // the Colorado reading
  });

  it('Paros is Paros, never silently corrected to Paris', () => {
    const place = resolvedPlace(run('Paros'));
    expect(place.id).toBe('p-paros');
    expect(place.country).toBe('GR');
    expect(place.airports.map((a) => a.iata)).toContain('PAS');
    expect(place.name).not.toBe('Paris');
  });

  it('LAX is Los Angeles, never Lae PNG', () => {
    const result = run('LAX');
    const place = resolvedPlace(result);
    expect(place.id).toBe('p-losangeles');
    expect(result.status === 'resolved' && result.via).toBe('iata-code');
    expect(place.country).not.toBe('PG');
    // The failure mode this guards: edit distance 1 from LAX to LAE.
    expect(place.id).not.toBe('p-lae');
  });

  it('東京 is unknown with NO suggestions', () => {
    const result = run('東京');
    expect(result.status).toBe('unknown');
    expect(result.status === 'unknown' && result.suggestions).toEqual([]);
  });

  it('a non-Latin input never gets a Latin suggestion, even an unknown one', () => {
    for (const input of ['京都市', 'Токио', 'القاهرة', '서울']) {
      const result = run(input);
      expect(result.status).toBe('unknown');
      expect(result.status === 'unknown' && result.suggestions).toEqual([]);
    }
  });

  it('the Latin alias of a native-script place still resolves', () => {
    // The script guard costs us 東京; it must not cost us Tokyo.
    expect(resolvedPlace(run('Tokyo')).id).toBe('p-tokyo');
  });
});

/**
 * Negative control: fails if the multi-country rule is replaced by any scalar
 * prominence margin, because Paris has the WIDEST measured gap (0.255) in the
 * ambiguous set — wider than Buffalo (0.164), which must still resolve.
 */
describe('must ask', () => {
  it('bare Paris with no location and no trip asks, and says why', () => {
    const result = run('Paris');
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.reason).toBe('multi-country');
    const countries = new Set(result.candidates.map((c) => c.place.country));
    expect(countries).toContain('FR');
    expect(countries).toContain('US');
  });

  it('asks for a same-country near-tie too, with a different reason', () => {
    const result = run('Springfield');
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.reason).toBe('near-tie');
    expect(result.candidates.length).toBeGreaterThan(1);
  });
});

/**
 * Negative control: the first two fail if the prune step or the qualifier
 * narrowing is removed; the context cases fail if the decision ladder is
 * reordered (prominence before coordinates resolves both of them to France).
 */
describe('must resolve', () => {
  it('Buffalo, NY resolves to BUF', () => {
    const result = run('Buffalo, NY');
    const place = resolvedPlace(result);
    expect(place.id).toBe('p-buffalo-ny');
    // airports[0] is what a non-asking caller prices from.
    expect(place.airports[0].iata).toBe('BUF');
  });

  it('Paris, France resolves to CDG and ORY, in that order', () => {
    const result = run('Paris, France');
    const place = resolvedPlace(result);
    expect(place.id).toBe('p-paris-fr');
    expect(result.status === 'resolved' && result.airports.map((a) => a.iata).slice(0, 2)).toEqual([
      'CDG',
      'ORY',
    ]);
  });

  it('bare Paris with Rome and Florence in context resolves to France', () => {
    const result = run('Paris', { tripDestinationNames: ['Rome', 'Florence'] });
    const place = resolvedPlace(result);
    expect(place.id).toBe('p-paris-fr');
    expect(result.status === 'resolved' && result.via).toBe('trip-context');
  });

  it('bare Paris with the traveller in Texas resolves to Texas', () => {
    const result = run('Paris', { userLatLon: POINTS.dallas });
    const place = resolvedPlace(result);
    expect(place.id).toBe('p-paris-tx');
    expect(result.status === 'resolved' && result.via).toBe('user-location');
  });

  it('the traveller beats the trip when both are present', () => {
    // Rule 2 before rule 3, deliberately: the owner chose their location first.
    const result = run('Paris', {
      userLatLon: POINTS.dallas,
      tripDestinationNames: ['Rome', 'Florence'],
    });
    expect(resolvedPlace(result).id).toBe('p-paris-tx');
    expect(result.status === 'resolved' && result.via).toBe('user-location');
  });

  it('context cannot overturn an explicit qualifier', () => {
    // Rule 1 is first. A traveller in Dallas who types "Paris, France" is not
    // asking about Texas.
    const result = run('Paris, France', { userLatLon: POINTS.dallas });
    expect(resolvedPlace(result).id).toBe('p-paris-fr');
  });
});
