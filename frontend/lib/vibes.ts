import { isVibeSynonym } from './vibeMap';

/**
 * Several vibes per trip ("Culture & food").
 *
 * The planner keeps the picked vibes as a list (`answers.vibes`) and, next to
 * it, the ONE string every backend call and the saved trip take
 * (`answers.vibe`, `trip.vibe`): the list joined with ", " — "Culture, Food".
 * The backend has only ever seen a free-text vibe string, so a joined one
 * needs no change there, and an old single-vibe answer ("Culture") is simply
 * a list of one.
 */

/** The pills on the vibe step, in the order they are shown. */
export const VIBE_PILL_LABELS = ['Beachy', 'Skiing', 'Adventure', 'Architecture', 'Culture'] as const;

/** At most this many pills can be picked at once. */
export const MAX_VIBES = 3;

/** Other ways people name a pill's vibe. */
const PILL_ALIASES: Record<string, string> = {
  beach: 'Beachy',
  beaches: 'Beachy',
  ski: 'Skiing',
  cultural: 'Culture',
  adventurous: 'Adventure',
};

const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

/** The pill a vibe names ("culture" → "Culture", "beach" → "Beachy"), if any. */
export function pillFor(vibe: string): string | null {
  const v = tidy(vibe).toLowerCase();
  return VIBE_PILL_LABELS.find((p) => p.toLowerCase() === v) ?? PILL_ALIASES[v] ?? null;
}

/** One vibe word the planner knows: a pill, an alias, or a chip synonym. */
function isKnownVibe(word: string): boolean {
  return !!pillFor(word) || isVibeSynonym(word);
}

/** Drop blanks and repeats (case-insensitive), keeping the first spelling. */
export function dedupeVibes(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = tidy(raw);
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** The string the backend and `trip.vibe` take: "Culture, Food". */
export function joinVibes(list: string[]): string {
  return dedupeVibes(list).join(', ');
}

/**
 * The planner's vibes as a list. `vibes` when it is set; otherwise the
 * stored string split on the commas `joinVibes` writes — so a saved or
 * staged "Culture, Food" reads back as two vibes and an old single "Culture"
 * (or any comma-free free text) as one, exactly as typed.
 */
export function vibeList(a: { vibe?: string | null; vibes?: string[] | null } | null | undefined): string[] {
  if (!a) return [];
  if (Array.isArray(a.vibes)) {
    const list = dedupeVibes(a.vibes);
    if (list.length > 0) return list;
  }
  return typeof a.vibe === 'string' ? dedupeVibes(a.vibe.split(',')) : [];
}

const LEADING_FILLER = /^(?:a|an|the|some|lots of|plenty of)\s+/i;
const TRAILING_FILLER = /\s+(?:trips?|vibes?|holidays?|vacations?|getaways?|stuff)$/i;
const SEPARATOR = /\s*(?:,|&|\+|\/|\band\b|\bplus\b)\s*/i;

/**
 * Typed vibe text as vibes: "a beach and food trip" → ['beach', 'food'] when
 * every part is a single vibe word the planner knows and there are no more
 * than MAX_VIBES of them. Anything else stays ONE vibe, as typed ("somewhere
 * warm with good food"), so free text is never mangled into pieces.
 */
export function splitVibeText(text: string | null | undefined): string[] {
  const t = tidy(text ?? '');
  if (!t) return [];
  const parts = t
    .split(SEPARATOR)
    .map((p) => tidy(p).replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim())
    .filter(Boolean);
  if (parts.length >= 1 && parts.length <= MAX_VIBES && parts.every((p) => !/\s/.test(p) && isKnownVibe(p))) {
    return parts;
  }
  return [t];
}

/** The picked pills an answer holds, and what's left over as typed text. */
export function pillsAndText(list: string[]): { pills: string[]; text: string } {
  const pills: string[] = [];
  const rest: string[] = [];
  for (const v of dedupeVibes(list)) {
    const pill = pillFor(v);
    if (pill && !pills.includes(pill) && pills.length < MAX_VIBES) pills.push(pill);
    else rest.push(v);
  }
  return { pills, text: rest.join(', ') };
}

/** "A", "A & B", "A, B & C". */
function joinNatural(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} & ${items[items.length - 1]}`;
}

/** The traveller's answer bubble: "Culture & Food", "Culture, Food & Architecture". */
export function vibeBubbleText(list: string[]): string {
  return joinNatural(dedupeVibes(list));
}

/** "culture and food vibes" → "culture and food"; long free text is cut. */
function vibeWord(v: string): string {
  const t = tidy(v).replace(/\s+vibes?$/i, '');
  return t.length > 28 ? `${t.slice(0, 27).trimEnd()}…` : t;
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The "Trip so far" wording: "Culture", "Culture & food", "Culture, food &
 * architecture". Known vibe words after the first are lower-cased so the
 * phrase reads as a sentence; other free text keeps the traveller's casing
 * ("Culture & Paris nightlife").
 */
export function vibePhrase(list: string[]): string {
  const words = dedupeVibes(list)
    .map(vibeWord)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? capitalise(w) : isKnownVibe(w) ? w.toLowerCase() : w));
  return joinNatural(words);
}
