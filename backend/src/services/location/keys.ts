/**
 * Key normalisation, as PURE STRING WORK with no imports.
 *
 * ── THIS FILE IS COPIED, BYTE FOR BYTE ──────────────────────────────────────
 *
 * An identical copy lives at `frontend/lib/locationKeys.ts`, and
 * `locationKeysParity.test.ts` in both packages compares the two files' bytes
 * and fails on any difference. Edit one, run either suite, and you are told.
 *
 * It is a copy because one file imported by both is not available here, and
 * the reason is recorded in `originAirportsParity.test.ts`: the two packages
 * have no workspace root, backend's tsconfig pins `rootDir: ./src` so it
 * refuses to compile anything outside src/, and Next's bundler scope stops at
 * frontend/. Changing any of those is a build-system project with a live
 * deploy attached.
 *
 * So this file has NO IMPORTS AND NO DEPENDENCIES, which is what makes a
 * byte-for-byte copy safe and the parity guard exact. Keep it that way: the
 * moment it imports anything, the copy stops being verbatim and the guard
 * stops being a guard. Anything that needs a `Place` belongs in
 * `normalize.ts`, which imports this.
 *
 * The browser needs the same keys as the server for the hot set to mean
 * anything: a query normalised differently on the two sides looks up a
 * different key and gets a different answer.
 */

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
 * The part of a key a Latin keyboard could actually produce, or null.
 *
 * "At least one Latin letter somewhere" is the obvious test and it was wrong,
 * measured: it indexed 3,522 mixed-script keys from the real artifact, GeoNames
 * alternate names written in scripts our table does not cover. None of them is
 * reachable from the keyboard that produced the query, so they could only cost
 * memory in the trigram index and invent fuzzy neighbours for real words - one
 * of them sits a single edit from `shanghai`.
 *
 * Dropping every mixed string is too blunt, though: a bilingual name like
 * "東京 Tokyo" is genuine and its Latin half is exactly what a traveller
 * types. What separates the two cases is WHERE the foreign script sits.
 * Interleaved inside a word it is failed transliteration; in a word of its own
 * it is the same name written twice. So the filter runs per word, keeping the
 * words that survived transliteration whole and dropping the rest. A name
 * carrying both scripts keeps its Latin word; a single corrupt word keeps
 * nothing.
 *
 * When a real place loses a spelling travellers type, the fix is a new entry in
 * `TRANSLITERATE`, not indexing a form nobody can enter.
 */
function latinPortion(key: string): string | null {
  if (!key) return null;
  if (ASCII_ONLY.test(key)) return LATIN_LETTER.test(key) ? key : null;
  const kept = key
    .split(' ')
    .filter((word) => ASCII_ONLY.test(word))
    .join(' ')
    .trim();
  return kept && LATIN_LETTER.test(kept) ? kept : null;
}

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
  const add = (raw: string): void => {
    const key = latinPortion(raw);
    if (!key) return;
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
