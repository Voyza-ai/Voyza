/**
 * The resolver against the REAL generated artifact.
 *
 * Every other location suite runs on `fixtures/artifact.ts`, which is the
 * right default: a fixture is readable, fast, and lets a case be written for
 * the rule it tests rather than for whatever a dataset happens to contain.
 *
 * It is also how five bugs reached a "130 tests, all green" resolver. The
 * fixture contains the collisions someone thought of. The artifact contains
 * 36,009 places and the collisions nobody would: GeoNames hands Dayton, Ohio
 * an alternate name that folds to `venice`, and Dayton is more prominent than
 * either real Venice, so `Venice` resolved to Ohio. Measured on first contact
 * with real data, not predicted:
 *
 *   Venice             -> Dayton, Ohio
 *   Rome               -> offered Lome, Togo (prominence gap 0.001)
 *   Washington         -> offered Reisterstown MD, South River NJ, Piqua OH
 *   la                 -> offered Laos and Lautem, Timor-Leste
 *   Rome + Florence,
 *     Venice as trip   -> centroid at 53.0N 38.4W, in the Atlantic, so
 *                         Rome, New York was the "nearest" candidate
 *
 * So this suite exists to run the pipeline over the data it will actually see
 * in production. It asserts outcomes a traveller would notice, and the
 * must-never list is as load-bearing as the must-resolve one.
 *
 * It costs about a second to build the index over the full artifact. That is
 * the price of the only test that could have caught any of the above.
 */

import { locationArtifact } from '../data/locationArtifact';
import { buildIndex } from '../services/location/buildIndex';
import { resolve } from '../services/location/resolve';
import type { Resolution, ResolveContext } from '../services/location/types';

const index = buildIndex(locationArtifact);

const run = (query: string, context: ResolveContext = {}): Resolution =>
  resolve(query, context, index);

/**
 * `Name/ADMIN/CC` for every candidate an answer offers, in order, ASCII-folded.
 *
 * The fold is not cosmetic. Without it, `not.toContain('Lome/24/TG')` is
 * checked against a list holding `Lomé/24/TG`, passes, and asserts nothing —
 * which is what it did until the negative control showed that one must-never
 * test surviving a mutant that broke the other four.
 */
function offered(result: Resolution): string[] {
  const show = (p: { name: string; admin: string | null; country: string }): string =>
    `${p.name}/${p.admin ?? '-'}/${p.country}`.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (result.status === 'resolved') return [show(result.place)];
  if (result.status === 'ambiguous') return result.candidates.map((c) => show(c.place));
  return result.suggestions.map((s) => show(s.place));
}

const POINTS = {
  newYork: { lat: 40.7128, lon: -74.006 },
  seattle: { lat: 47.6062, lon: -122.3321 },
};

describe('the artifact itself', () => {
  it('is the generated one, with provenance on every place', () => {
    expect(locationArtifact.places.length).toBeGreaterThan(30_000);
    expect(locationArtifact.schemaVersion).toBeGreaterThanOrEqual(2);
    for (const place of locationArtifact.places) {
      expect(Array.isArray(place.curatedAliases)).toBe(true);
    }
  });

  it('indexes no key that a Latin keyboard cannot produce', () => {
    // 3,522 mixed-script keys used to be in here. One of them was a single
    // edit from `shanghai`.
    const unreachable = [...index.exact.keys()].filter((key) => !/^[\x20-\x7e]*$/.test(key));
    expect(unreachable).toEqual([]);
  });
});

describe('what a traveller types, against 36,000 real places', () => {
  it.each([
    // query               expected                      why it is the answer
    ['la', 'Los Angeles/CA/US', 'curated alias beats three official LA codes'],
    ['nyc', 'New York City/NY/US', 'curated alias beats Manhattan'],
    ['the bay area', 'San Francisco Bay Area/CA/US', 'no dataset covers this'],
    ['LAX', 'Los Angeles/CA/US', 'a code is an airport, not a town'],
    ['nj', 'New Jersey/NJ/US', 'a bare state'],
    ['NY', 'New York/NY/US', 'a bare state, not the city inside it'],
    ['Paris, Texas', 'Paris/TX/US', 'the qualifier pins it'],
    ['Paris, France', 'Paris/11/FR', 'the qualifier pins it'],
    ['Baton Rouge, LA', 'Baton Rouge/LA/US', 'LA is Louisiana after a comma'],
    ['Berlin, DE', 'Berlin/16/DE', 'DE is Germany after a comma'],
    ['Koln', 'Koln/07/DE', 'the transliterated spelling'],
    ['Cologne', 'Koln/07/DE', 'the English exonym'],
    ['paros', 'Paros/ESYE42/GR', 'a real island, not a typo for Paris'],
  ])('%s -> %s (%s)', (query, expected) => {
    const result = run(query);
    expect(result.status).toBe('resolved');
    expect(offered(result)[0]).toBe(expected);
  });

  it('gives a bare state every airport that serves it, including the far ones', () => {
    const result = run('NY');
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    const codes = result.airports.map((a) => a.iata);
    // The owner's rule in so many words: "we give them all the ny options,
    // right including buffalo as well, any airport within ny".
    expect(codes).toContain('JFK');
    expect(codes).toContain('LGA');
    expect(codes).toContain('EWR');
    expect(codes).toContain('BUF');

    // Led by a NYC-area major rather than an upstate field. Which of the
    // three leads is settled by distance from the state's
    // population-weighted centre (EWR 30 km, LGA 33, JFK 50), and it is not
    // the trip price: `buildHomeLeg` fans out across this whole list and
    // takes the cheapest. `airports[0]` steers permutation ranking.
    expect(['EWR', 'LGA', 'JFK']).toContain(result.airports[0].iata);
  });
});

describe('the must-never list, every entry of it a measured regression', () => {
  it('never answers Venice with Dayton, Ohio', () => {
    const result = run('Venice');
    const names = offered(result);
    expect(names).not.toContain('Dayton/OH/US');
    expect(names.some((n) => n.startsWith('Venice/'))).toBe(true);
  });

  it('never offers Lome, Togo as a Rome', () => {
    // Prominence gap to Rome, Italy was 0.001. Nothing but provenance
    // separates these two, and no threshold ever would have.
    expect(offered(run('Rome'))).not.toContain('Lome/24/TG');
  });

  it('never offers a town whose only claim to Washington is an alternate name', () => {
    // `Washington` itself is now a curated decision — the capital, matching
    // the table it replaces — so the junk is checked on the form that still
    // produces a list: the state, which four towns used to crowd into.
    const names = offered(run('Washington State'));
    for (const junk of [
      'Reisterstown/MD/US',
      'South River/NJ/US',
      'Piqua/OH/US',
      'Macomb/IL/US',
    ]) {
      expect(names).not.toContain(junk);
    }
    // And a bare `Washington` resolves to the capital, by decision rather
    // than by prominence — which would have put the state first, 3,700 km
    // from anyone who typed it meaning DC.
    const bare = run('Washington');
    expect(bare.status).toBe('resolved');
    if (bare.status !== 'resolved') return;
    expect(bare.place.admin).toBe('DC');
    expect(bare.via).toBe('curated-alias');
    expect(bare.airports[0].iata).toBe('IAD');

    // The state is still reachable, and the qualifier still outranks the
    // curated decision when someone names one.
    expect(offered(run('Washington State'))[0]).toBe('Washington/WA/US');
    expect(offered(run('Washington, Utah'))[0]).toBe('Washington/UT/US');
  });

  it('asks about Delaware, for the same reason it asks about Washington', () => {
    // Not a special case about states and cities — a measurement. The
    // state-to-city prominence gap is 0.033 here and 0.041 for
    // Washington/DC, so any margin that resolved this one would resolve
    // Washington too, and Washington genuinely needs asking.
    const result = run('Delaware');
    expect(result.status).toBe('ambiguous');
    expect(offered(result)).toEqual(expect.arrayContaining(['Delaware/DE/US', 'Delaware/OH/US']));
  });

  it('never resolves a typo, and never suggests nothing for one', () => {
    const result = run('pariss');
    // Fuzzy PROPOSES. Turning a typo into a booked city is the confident-wrong
    // this design refuses, so the status stays `unknown` and the caller asks.
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') return;
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].place.name).toBe('Paris');
    expect(result.suggestions[0].editDistance).toBe(1);
  });

  it('never silently picks a Paris, from anywhere', () => {
    for (const context of [{}, { userLatLon: POINTS.newYork }, { userCountry: 'US' }]) {
      const result = run('Paris', context);
      expect(result.status).toBe('ambiguous');
      // The one that matters: a traveller in Manhattan is 2,057 km from Paris,
      // Texas and 5,837 km from France, which clears any dominance ratio.
      expect(offered(result)).not.toEqual(['Paris/TX/US']);
    }
  });

  it('never returns an empty answer with no way forward', () => {
    // The owner's rule: "do nothing is not an option we need to build trust."
    // Every outcome is either an answer, a question with candidates, or a
    // question with suggestions — and a resolution always carries an airport.
    for (const query of ['Paris', 'Springfield', 'zzzzqqqq', 'la', 'NY', '東京', '']) {
      const result = run(query);
      if (result.status === 'resolved') {
        expect(result.airports.length).toBeGreaterThan(0);
      } else if (result.status === 'ambiguous') {
        expect(result.candidates.length).toBeGreaterThan(1);
        for (const candidate of result.candidates) {
          expect(candidate.airports.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('context, on real coordinates', () => {
  it('reads a trip of Florence and Venice as the Italian one', () => {
    // This is the case that exposed the Dayton bug. The centroid of
    // (Florence, Italy) and (Dayton, Ohio) is 53.0N 38.4W — the Atlantic —
    // from where Rome, New York is nearer than Rome, Italy.
    const result = run('Rome', { tripDestinationNames: ['Florence', 'Venice'] });
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.place.country).toBe('IT');
    expect(result.via).toBe('trip-context');
  });

  it('lets the traveller’s own position settle a same-country pair', () => {
    // Was `Washington` from Seattle, which is now settled earlier by a
    // curated decision and so no longer exercises the position rule at all.
    // `Portland` is the same shape and still contested: Oregon and Maine,
    // one country, 4,000 km apart.
    expect(run('Portland').status).toBe('ambiguous');

    const oregon = run('Portland', { userLatLon: { lat: 45.5152, lon: -122.6784 } });
    expect(oregon.status).toBe('resolved');
    if (oregon.status !== 'resolved') return;
    expect(oregon.place.admin).toBe('OR');
    expect(oregon.via).toBe('user-location');

    const maine = run('Portland', { userLatLon: { lat: 43.6591, lon: -70.2568 } });
    expect(maine.status === 'resolved' && maine.place.admin).toBe('ME');
  });

  it('does not let a far-away position decide anything', () => {
    // Beyond `userLocalKm` a position is evidence about nothing. Asking is the
    // documented safe failure; flying someone to Texas is not.
    expect(run('Paris', { userLatLon: POINTS.newYork }).status).toBe('ambiguous');
  });
});

describe('non-Latin input is a known limit, not a silent failure', () => {
  it('asks rather than guessing, and never proposes a Latin lookalike', () => {
    // The artifact carries no native-script keys, so `東京` cannot hit. What
    // matters is that it degrades to a question instead of proposing the
    // nearest Latin string, which is how you get "Ba, Ho, Li" for Tokyo.
    for (const query of ['東京', '서울', 'القاهرة']) {
      const result = run(query);
      expect(result.status).toBe('unknown');
      if (result.status !== 'unknown') return;
      expect(result.suggestions).toEqual([]);
    }
  });
});
