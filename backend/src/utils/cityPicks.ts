/**
 * Keeping each city's AI picks in that city.
 *
 * Activities and restaurants are asked per city, in parallel, with no
 * knowledge of the rest of the trip. So nearby stops got each other's
 * highlights — the Uffizi recommended for Rome as well as Florence (ROADMAP
 * "Duplicate AI suggestions across nearby cities"). The prompt now names the
 * trip's other stops, and anything that still says it is in one of them is
 * dropped here; the frontend then removes exact repeats across cities.
 */

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, accent- and case-insensitive. "Rome" is not in "Romeo". */
function mentions(text: string, place: string): boolean {
  const p = fold(place).trim();
  if (!p) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(p)}($|[^a-z0-9])`).test(fold(text));
}

/** The trip's other stops, without this one and without repeats. */
export function otherStops(city: string, others: string[] | undefined): string[] {
  const self = fold(city).trim();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of others ?? []) {
    const k = fold(o).trim();
    if (!k || k === self || seen.has(k)) continue;
    seen.add(k);
    out.push(o.trim());
  }
  return out;
}

/** The sentence added to the picks prompt, or '' for a one-city trip. */
export function otherStopsHint(city: string, others: string[] | undefined): string {
  const list = otherStops(city, others);
  if (list.length === 0) return '';
  return (
    `This trip also stops in ${list.join(', ')}, and each of those gets its own list. ` +
    `Every pick must be physically located in ${city} itself — nothing in or near ${list.join(' or ')}, ` +
    `and no day trips to them. `
  );
}

/**
 * Drop picks that say they are in another stop on the trip ("Uffizi Gallery,
 * Florence" on Rome's list, "Day trip to Florence"). A pick that names its
 * own city too is kept: "Via Firenze, Rome" is in Rome.
 */
export function keepOwnCity<T extends { name?: unknown; placeQuery?: unknown }>(
  items: T[],
  city: string,
  others: string[] | undefined,
): T[] {
  const list = otherStops(city, others);
  if (list.length === 0) return items;
  return items.filter((it) => {
    const text = [it?.name, it?.placeQuery].filter((v) => typeof v === 'string').join(' | ');
    if (!text || mentions(text, city)) return true;
    return !list.some((o) => mentions(text, o));
  });
}
