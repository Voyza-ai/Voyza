/**
 * The fuzzy path: a trigram inverted index, plus a brute-force path for short
 * strings where trigram recall was measured at 65%.
 *
 * The rules being defended, in order of how much damage breaking them does:
 *
 *   1. exact always beats fuzzy — `Paros` is a real Greek island with
 *      scheduled service at PAS, not a misspelling of Paris
 *   2. fuzzy runs only on an exact miss
 *   3. fuzzy PROPOSES, never substitutes — it can only ever produce
 *      `unknown` with suggestions, so no caller can act on a guess
 *
 * Negative control: the recall suites fail if the brute-force path for short
 * keys is removed, and the `Paros` suite fails if the fuzzy lookup is moved
 * ahead of the exact lookup. Both verified by mutation — see the report.
 */

import { buildIndex } from '../services/location/buildIndex';
import { resolve } from '../services/location/resolve';
import { boundedLevenshtein, buildTrigramIndex } from '../services/location/trigram';
import { FIXTURE_ARTIFACT } from '../services/location/fixtures/artifact';

const index = buildIndex(FIXTURE_ARTIFACT);
const keys = [...index.exact.keys()];

/** Plain textbook Levenshtein, as the reference for the banded version. */
function referenceLevenshtein(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

describe('boundedLevenshtein', () => {
  it('agrees with the textbook algorithm whenever the answer is in range', () => {
    // Deterministic pseudo-random pairs: a banded DP is exactly the kind of
    // code that is correct on the examples its author thought of.
    let seed = 7;
    const next = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const alphabet = 'abcdefgh';
    for (let n = 0; n < 4000; n++) {
      const make = (): string =>
        Array.from({ length: 1 + Math.floor(next() * 9) }, () =>
          alphabet[Math.floor(next() * alphabet.length)],
        ).join('');
      const a = make();
      const b = make();
      const max = Math.floor(next() * 4);
      const expected = referenceLevenshtein(a, b);
      const actual = boundedLevenshtein(a, b, max);
      if (expected <= max) expect(actual).toBe(expected);
      else expect(actual).toBeGreaterThan(max);
    }
  });

  it('handles the degenerate inputs', () => {
    expect(boundedLevenshtein('', '', 0)).toBe(0);
    expect(boundedLevenshtein('paris', 'paris', 0)).toBe(0);
    expect(boundedLevenshtein('', 'paris', 2)).toBe(3);
    expect(boundedLevenshtein('paris', '', 10)).toBe(5);
    expect(boundedLevenshtein('paros', 'paris', 1)).toBe(1);
    expect(boundedLevenshtein('lax', 'lae', 1)).toBe(1);
  });
});

describe('trigram recall over every key in the artifact', () => {
  const mutations: Array<[string, (key: string) => string]> = [
    ['substitution', (k) => `${k.slice(0, Math.floor(k.length / 2))}z${k.slice(Math.floor(k.length / 2) + 1)}`],
    ['deletion', (k) => k.slice(0, Math.floor(k.length / 2)) + k.slice(Math.floor(k.length / 2) + 1)],
    ['insertion', (k) => `${k.slice(0, Math.floor(k.length / 2))}z${k.slice(Math.floor(k.length / 2))}`],
  ];

  it.each(mutations)('finds every long key again after a %s', (_name, mutate) => {
    const long = keys.filter((k) => k.length >= 5);
    expect(long.length).toBeGreaterThan(50);
    const missed = long.filter((key) => {
      const typo = mutate(key);
      if (typo === key) return false;
      return !index.fuzzy.search(typo, 2, 25).some((hit) => hit.key === key);
    });
    // The measurement says 100% at five characters or more.
    expect(missed).toEqual([]);
  });

  it.each(mutations)('finds every SHORT key again after a %s', (_name, mutate) => {
    // Trigram recall here was measured at 65%, which is why short strings take
    // the brute-force path instead.
    const short = keys.filter((k) => k.length < 5);
    expect(short.length).toBeGreaterThan(10);
    const missed = short.filter((key) => {
      const typo = mutate(key);
      if (typo === key) return false;
      return !index.fuzzy.search(typo, 2, 50).some((hit) => hit.key === key);
    });
    expect(missed).toEqual([]);
  });

  it('returns hits best-first', () => {
    const hits = index.fuzzy.search('dusseldorff', 2, 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].key).toBe('dusseldorf');
    const distances = hits.map((h) => h.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('returns nothing rather than everything for a hopeless query', () => {
    expect(index.fuzzy.search('qqqqqqqqqqqqqq', 2, 10)).toEqual([]);
    expect(index.fuzzy.search('', 2, 10)).toEqual([]);
    expect(index.fuzzy.search('paris', 2, 0)).toEqual([]);
  });

  it('never returns a hit outside the distance bound', () => {
    for (const query of ['pariss', 'bufalo', 'springfeild', 'koeln', 'bo', 'ely']) {
      for (const hit of index.fuzzy.search(query, 1, 20)) {
        expect(hit.distance).toBeLessThanOrEqual(1);
        expect(referenceLevenshtein(query, hit.key)).toBe(hit.distance);
      }
    }
  });

  it('is deterministic across rebuilds', () => {
    const again = buildTrigramIndex(keys);
    expect(again.search('pariss', 2, 5)).toEqual(index.fuzzy.search('pariss', 2, 5));
  });
});

describe('exact beats fuzzy, always', () => {
  it('Paros is Paros even though Paris is one edit away and vastly bigger', () => {
    const result = resolve('Paros', {}, index);
    expect(result.status).toBe('resolved');
    expect(result.status === 'resolved' && result.place.id).toBe('p-paros');
  });

  it('does not even consult the fuzzy index on an exact hit', () => {
    const spy = jest.spyOn(index.fuzzy, 'search');
    resolve('Paros', {}, index);
    resolve('Buffalo, NY', {}, index);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('keeps a short real name out of the typo path', () => {
    // `Ba` (Fiji) and `Ho` (Ghana) are real towns and real inputs.
    expect(resolve('Ba', {}, index).status).toBe('resolved');
    expect(resolve('Ho', {}, index).status).toBe('resolved');
    expect(resolve('Ely', {}, index).status).toBe('resolved');
  });
});

describe('fuzzy proposes, never substitutes', () => {
  it('returns unknown with suggestions for a typo, not a resolution', () => {
    const result = resolve('Pariss', {}, index);
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') return;
    expect(result.suggestions.map((s) => s.place.id)).toContain('p-paris-fr');
    expect(result.suggestions[0].editDistance).toBe(1);
  });

  it('never produces a resolution via the fuzzy reason', () => {
    for (const input of ['Pariss', 'Dusseldorff', 'Springfeild', 'Bufalo', 'Vancuver', 'Lodzz']) {
      const result = resolve(input, {}, index);
      expect(result.status).toBe('unknown');
    }
  });

  it('labels and caps the suggestions', () => {
    const result = resolve('Pariss', {}, index, { maxSuggestions: 2 });
    if (result.status !== 'unknown') throw new Error('expected unknown');
    expect(result.suggestions.length).toBe(2);
    expect(result.suggestions[0].label).toBe('Paris, Île-de-France, France');
  });

  it('respects the qualifier narrowing', () => {
    const result = resolve('Pariss, France', {}, index);
    if (result.status !== 'unknown') throw new Error('expected unknown');
    expect(result.suggestions.map((s) => s.place.id)).toEqual(['p-paris-fr']);
  });

  it('offers nothing at all when nothing is close', () => {
    expect(resolve('Zzzzzzzzz', {}, index)).toEqual({ status: 'unknown', suggestions: [] });
  });

  it('allows two edits only once a query is long enough to afford them', () => {
    // One edit on a five-letter word is already a fifth of the word; two is a
    // guess. `Prais` is two edits from `paris` (Levenshtein charges 2 for a
    // transposition), and at five characters it gets nothing.
    const short = resolve('Prais', {}, index);
    expect(short.status === 'unknown' && short.suggestions).toEqual([]);
    // Eleven characters can afford two.
    const long = resolve('Dusseldorffe', {}, index);
    expect(long.status === 'unknown' && long.suggestions[0]?.place.id).toBe('p-dusseldorf');
    // One edit still works at either length.
    const one = resolve('Pariss', {}, index);
    expect(one.status === 'unknown' && one.suggestions[0].place.id).toBe('p-paris-fr');
  });
});
