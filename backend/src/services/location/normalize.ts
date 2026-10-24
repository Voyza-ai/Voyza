/**
 * Key normalisation. One-to-MANY, on both sides.
 *
 * `keysFor(place)` emits EVERY key a place can be found under; the query side
 * emits a key set too and the caller unions the hits. Neither side may assume a
 * single canonical form, because there isn't one: a German city is spelled
 * three ways in the wild and all three are correct.
 *
 * The naive rule — lowercase and strip combining marks — was measured against
 * real airport-city spellings and missed 14 of 22: `Łódź`, `Tromsø`, `Bodø`,
 * `Đà Nẵng`, `Gießen`, `Köln`, `Düsseldorf`, `München`, `Þórshöfn`,
 * `Ísafjörður`. NFD does nothing for a letter that is not base-plus-diacritic:
 * `ł`, `ø`, `đ`, `þ`, `ð`, `æ`, `œ`, `ı` and `ß` have no decomposition at all.
 * So an explicit transliteration table runs BEFORE the NFD strip.
 *
 * Three rules worth stating because the obvious code gets each one wrong:
 *
 * 1. Whitespace collapses to a SINGLE SPACE, never to nothing. Collapsing to
 *    nothing makes `"New Ark" == "Newark"` and `"Port Land" == "Portland"`.
 * 2. German umlauts yield TWO keys — `köln` is indexed as both `koln` and
 *    `koeln`, because travellers type both and either may be the form in the
 *    data. This is the whole reason the function returns an array.
 * 3. A key with no Latin letter is not indexed. `東京` normalises to `東京`,
 *    which no traveller's keyboard will reproduce from a Latin query, and
 *    indexing it would make the script guard in `resolve` unreachable — the
 *    guard only fires when `exact` missed. Dropping the key makes "no Latin
 *    input ⇒ never a Latin suggestion" hold for every artifact, instead of
 *    depending on how much native-script coverage the pipeline happened to
 *    emit. See the note in docs: this is stricter than the doc's wording.
 */

import type { Place } from './types';

/**
 * Letters NFD cannot touch, lowercase only — `prepare()` lowercases first.
 *
 * `İ` is absent on purpose: `'İ'.toLowerCase()` is `i` + U+0307, which the NFD
 * strip then handles. `ẞ` lowercases to `ß`, which is here.
 */
const TRANSLITERATE: Record<string, string> = {
  ß: 'ss',
  ł: 'l',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  // Same class of problem, same one-line fix. Kept short on purpose: every
  // entry here is a claim about real spellings in the data.
  ħ: 'h',
  ŧ: 't',
  ĸ: 'k',
};

/** The German dual form. Applied before the NFD strip, which would eat them. */
const UMLAUT_DUAL: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
};

/** Dropped outright: an apostrophe or period is never load-bearing in a key. */
const DROPPED_PUNCTUATION = /[.'’‘`´ʻ"“”]/g;

/**
 * Becomes a SPACE, not nothing — see rule 1. A hyphen is a word break in
 * `Winston-Salem`, so `winston salem` is the right key, and `winstonsalem` is
 * the same mistake as `newark`.
 */
const SPACED_PUNCTUATION = /[-–—_/\\,;:()[\]{}|+]/g;

const COMBINING_MARKS = /[̀-ͯ]/g;

const LATIN_LETTER = /[a-z]/;

function prepare(raw: string): string {
  return raw
    .toLowerCase()
    .replace(DROPPED_PUNCTUATION, '')
    .replace(SPACED_PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function applyTable(s: string, table: Record<string, string>): string {
  let out = '';
  for (const ch of s) out += table[ch] ?? ch;
  return out;
}

function stripMarks(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '');
}

/**
 * Pure-ASCII text needs none of the work below, and at 50,000 places most
 * keys are pure ASCII. Skipping the table walk and both Unicode
 * normalisations for them took the index build from 2.7 s to 0.5 s, which is
 * cold-start time on every boot.
 */
const ASCII_ONLY = /^[\x20-\x7e]*$/;
const NEEDS_DUAL = /[äöüÄÖÜ]/;

/**
 * Every key the given text can be found under, deduped, best-first (the plain
 * transliteration before the German dual form). Empty when the text carries no
 * Latin letter — which is how the script guard stays honest.
 */
export function normalizeKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const base = prepare(raw);
  if (!base) return [];

  if (ASCII_ONLY.test(base)) return LATIN_LETTER.test(base) ? [base] : [];

  const out: string[] = [];
  const add = (key: string): void => {
    if (!key || !LATIN_LETTER.test(key)) return;
    if (!out.includes(key)) out.push(key);
  };

  add(stripMarks(applyTable(base, TRANSLITERATE)));
  if (NEEDS_DUAL.test(base)) {
    add(stripMarks(applyTable(applyTable(base, UMLAUT_DUAL), TRANSLITERATE)));
  }
  return out;
}

/** Alias for the query side, so call sites read as the doc's pipeline does. */
export const keysForQuery = normalizeKeys;

/** Every key a place is indexed under: its display name plus every alias. */
export function keysFor(place: Place): string[] {
  const out: string[] = [];
  for (const text of [place.name, ...(place.aliases ?? [])]) {
    for (const key of normalizeKeys(text)) {
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

/**
 * Comma split, step 2 of the pipeline. Empty segments are dropped so
 * `"Paris,, France"` and a trailing comma behave.
 */
export function splitSegments(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

/**
 * True when the text can produce at least one Latin key. Deliberately defined
 * as "normalisation produced a key", so the guard and the index can never
 * disagree about what counts as Latin.
 */
export function hasLatinForm(raw: string): boolean {
  return normalizeKeys(raw).length > 0;
}
