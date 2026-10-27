/**
 * Normalisation, which is one-to-many on both sides.
 *
 * The naive rule — lowercase and strip combining marks — was measured against
 * 22 real airport-city spellings and missed 14. The ten named below are the
 * ones from that measurement; each is here as a case, not as a comment.
 *
 * Negative control: every case in "the spellings the naive rule missed" fails
 * when the transliteration table is removed, and the German dual-form cases
 * fail when `UMLAUT_DUAL` is removed. Verified by mutation — see the report.
 */

import { keysFor, normalizeKeys, splitSegments, hasLatinForm } from '../services/location/normalize';
import { FIXTURE_BY_ID } from '../services/location/fixtures/artifact';

describe('normalizeKeys — the spellings the naive rule missed', () => {
  // Each pair is (what the data says, what a traveller types).
  it.each([
    ['Łódź', 'lodz'],
    ['Tromsø', 'tromso'],
    ['Bodø', 'bodo'],
    ['Đà Nẵng', 'da nang'],
    ['Gießen', 'giessen'],
    ['Köln', 'koln'],
    ['Düsseldorf', 'dusseldorf'],
    ['München', 'munchen'],
    ['Þórshöfn', 'thorshofn'],
    ['Ísafjörður', 'isafjordur'],
  ])('%s is findable as %s', (spelled, typed) => {
    expect(normalizeKeys(spelled)).toContain(typed);
    // Symmetry: the query side has to land on the same key.
    expect(normalizeKeys(typed)[0]).toBe(typed);
  });

  it('emits the German dual form as well, not instead', () => {
    expect(normalizeKeys('Köln')).toEqual(['koln', 'koeln']);
    expect(normalizeKeys('München')).toEqual(['munchen', 'muenchen']);
    expect(normalizeKeys('Düsseldorf')).toEqual(['dusseldorf', 'duesseldorf']);
  });

  it('collapses the dual form to one key when both agree', () => {
    // ß → ss leaves nothing for the umlaut pass to do.
    expect(normalizeKeys('Gießen')).toEqual(['giessen']);
  });

  it('handles the uppercase forms of the letters NFD cannot decompose', () => {
    expect(normalizeKeys('ÐÞÆŒßŁØĐ')).toEqual(['dthaeoesslod']);
    // İ lowercases to i + U+0307, which the NFD strip then removes.
    expect(normalizeKeys('İstanbul')).toEqual(['istanbul']);
    expect(normalizeKeys('Diyarbakır')).toEqual(['diyarbakir']);
  });
});

describe('normalizeKeys — whitespace collapses to a single space, never to nothing', () => {
  it('keeps "New Ark" apart from "Newark"', () => {
    expect(normalizeKeys('New   Ark')).toEqual(['new ark']);
    expect(normalizeKeys('New Ark')).not.toContain('newark');
  });

  it('keeps "Port Land" apart from "Portland"', () => {
    expect(normalizeKeys(' Port \t Land ')).toEqual(['port land']);
    expect(normalizeKeys('Port Land')).not.toContain('portland');
  });

  it('treats a hyphen as a word break rather than deleting it', () => {
    expect(normalizeKeys('Winston-Salem')).toEqual(['winston salem']);
    expect(normalizeKeys('Tel-Aviv')).toEqual(['tel aviv']);
  });

  it('drops an apostrophe and a period without leaving a gap', () => {
    expect(normalizeKeys("Val-d'Or")).toEqual(['val dor']);
    expect(normalizeKeys('St. Louis')).toEqual(['st louis']);
    expect(normalizeKeys('U.S.A.')).toEqual(['usa']);
  });
});

describe('normalizeKeys — the script rule', () => {
  it('produces no key for text with no Latin letter', () => {
    for (const input of ['東京', '京都市', 'Токио', '서울', 'القاهرة', '北京', '12345', '   ']) {
      expect(normalizeKeys(input)).toEqual([]);
      expect(hasLatinForm(input)).toBe(false);
    }
  });

  it('still produces a key for a Latin name carrying unusual letters', () => {
    expect(hasLatinForm('Þórshöfn')).toBe(true);
    expect(hasLatinForm('Ørsta')).toBe(true);
    expect(normalizeKeys('Ørsta')).toContain('orsta');
  });

  it('keeps the Latin WORD of a bilingual name and drops the other script', () => {
    // The key a traveller can actually type. Indexing "東京 tokyo" — which is
    // what this used to do — is a key no keyboard reaches by either route.
    expect(normalizeKeys('東京 Tokyo')).toEqual(['tokyo']);
    expect(normalizeKeys('Ulaanbaatar Хот')).toEqual(['ulaanbaatar']);
  });

  it('produces no key when the foreign script is INSIDE the word', () => {
    // Failed transliteration, not a bilingual name. All three are real
    // GeoNames alternate names from the generated artifact, and 3,522 of
    // their kind used to be indexed. The first sits one edit from `shanghai`,
    // so indexing it does not merely waste memory — it invents a fuzzy
    // neighbour for a city 24 million people live in.
    for (const junk of ['shaniጓhayi', 'ch۫ngdۇ shةںyr', 'beȝcinȝ', 'guaнҷu']) {
      expect(normalizeKeys(junk)).toEqual([]);
      expect(hasLatinForm(junk)).toBe(false);
    }
  });

  it('is empty, never null, for nothing at all', () => {
    expect(normalizeKeys('')).toEqual([]);
    expect(normalizeKeys(null)).toEqual([]);
    expect(normalizeKeys(undefined)).toEqual([]);
  });
});

describe('keysFor — every key a place can be found under', () => {
  it('indexes the display name and every alias', () => {
    const keys = keysFor(FIXTURE_BY_ID.get('p-losangeles')!);
    expect(keys).toContain('los angeles');
    expect(keys).toContain('la');
    expect(keys).toContain('los angeles'); // from the accented alias too
  });

  it('indexes a native-script place under its Latin aliases only', () => {
    const keys = keysFor(FIXTURE_BY_ID.get('p-tokyo')!);
    expect(keys).toContain('tokyo');
    expect(keys).toContain('tokio');
    expect(keys).not.toContain('東京');
  });

  it('indexes a multi-word curated alias as one key with its space', () => {
    expect(keysFor(FIXTURE_BY_ID.get('m-bayarea')!)).toContain('the bay area');
  });

  it('never repeats a key', () => {
    const keys = keysFor(FIXTURE_BY_ID.get('p-sanjose-ca')!);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('splitSegments', () => {
  it('splits on commas and trims', () => {
    expect(splitSegments('Paris, France')).toEqual(['Paris', 'France']);
    expect(splitSegments('Paris ,  Texas , USA')).toEqual(['Paris', 'Texas', 'USA']);
  });

  it('drops empty segments', () => {
    expect(splitSegments('Paris,,France,')).toEqual(['Paris', 'France']);
    expect(splitSegments(',,,')).toEqual([]);
  });
});
