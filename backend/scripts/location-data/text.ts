/**
 * Text readers and normalisation for the location data pipeline.
 *
 * Build-time only. Nothing here ships — the generator runs under `tsx` and
 * emits JSON into `src/data/generated/`.
 */

/**
 * RFC 4180 CSV parser.
 *
 * Written rather than depended on because OurAirports' `airports.csv` has
 * embedded commas, embedded quotes and embedded newlines in `name`,
 * `municipality` and `keywords`. A `split(',')` reader silently shifts every
 * column after the first quoted comma, which is a whole-file corruption that
 * looks like clean data.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Rows of a GeoNames tab-separated dump, comments and blanks dropped. */
export function parseTsv(text: string): string[][] {
  const out: string[][] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    out.push(line.replace(/\r$/, '').split('\t'));
  }
  return out;
}

/**
 * Transliterations that NFD cannot do.
 *
 * Measured in the architecture pass: "lowercase and strip diacritics" misses
 * 14 of 22 real airport-city spellings, because `ß`, `Ł`, `Ø`, `Đ`, `Þ` and
 * `Æ` are not base-plus-combining-mark — stripping combining marks leaves
 * them untouched.
 */
const TRANSLITERATIONS: Array<[RegExp, string]> = [
  [/ß/g, 'ss'],
  [/ł/g, 'l'],
  [/ø/g, 'o'],
  [/đ/g, 'd'],
  [/ð/g, 'd'],
  [/þ/g, 'th'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ı/g, 'i'],
  [/ŋ/g, 'ng'],
  [/ħ/g, 'h'],
  [/ĸ/g, 'k'],
  [/ʼ|’|‘|`|´/g, ''],
];

/**
 * The canonical fold used for de-duplicating names and aliases.
 *
 * Whitespace collapses to a SINGLE space, never to nothing: collapsing to
 * nothing makes `"New Ark" === "Newark"` and `"Port Land" === "Portland"`.
 *
 * This is the generator's own de-duplication key. The resolver owns query-side
 * key generation (`keysFor`), which is deliberately one-to-many; this is not a
 * substitute for it.
 */
export function fold(s: string): string {
  let out = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const [re, to] of TRANSLITERATIONS) out = out.replace(re, to);
  return out
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the string contains at least one Latin letter. */
export function hasLatin(s: string): boolean {
  return /\p{Script=Latin}/u.test(s);
}

/** Levenshtein distance, used only to rank candidate aliases at build time. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length];
}
