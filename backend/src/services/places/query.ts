/**
 * Turning an AI pick's wording into geocoder queries.
 *
 * Mirrors the cleaning the Map tab has used client-side since it started
 * pinning spots (frontend/lib/citySpots.ts): time-of-day filler hurts a
 * geocoder ("Louvre early-entry morning"), and a descriptive tail does too
 * ("Senso-ji Temple and Asakusa old town"), so the leading proper noun is the
 * second thing tried.
 */

const FILLER =
  /\b(early[- ]entry|self[- ]guided|guided|optional|morning|afternoon|evening|sunset|sunrise|overnight|at night|night|day\s?trip|half[- ]day|full[- ]day|tickets?|reservation|entry|visit(?:ing)?|tour of|explore|stroll(?: through)?|walk(?: through)?)\b/gi;

export function cleanPlaceQuery(text: string): string {
  return text
    .replace(/\([^)]*\)/g, ' ')
    .replace(FILLER, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/(\s+\b(?:at|in|on|by|from|to|the|a|an|of|with|for|and)\b)+\s*$/i, '')
    .replace(/^\s*(?:the|a|an|at|in|of)\s+/i, '')
    .replace(/\s*[-–—,:]\s*$/, '')
    .trim();
}

/** The leading run of capitalised words ("Senso-ji Temple and Asakusa" → "Senso-ji Temple"). */
export function properNounPrefix(text: string): string {
  const words = text.trim().split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    const isProper =
      /^[A-ZÀ-Þ]/.test(w) ||
      (kept.length > 0 && /^\d+$/.test(w)) ||
      // Particles inside a name: "Musée d'Orsay", "Basilica di San Clemente".
      (kept.length > 0 && /^(?:d'|de|del|della|di|du|des|la|le|da|dos|das|von|van|y)\b/i.test(w));
    if (!isProper) break;
    kept.push(w);
  }
  // Never end on a particle.
  while (kept.length > 0 && /^(?:de|del|della|di|du|des|la|le|da|dos|das|von|van|y)$/i.test(kept[kept.length - 1])) {
    kept.pop();
  }
  return kept.join(' ').replace(/[,&:]$/, '').trim();
}

export const normalizeKey = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The queries to try for one item, most specific first, de-duplicated. At
 * most two: under Nominatim every query is a second of a shared budget.
 */
export function queriesFor(
  item: { name: string; placeQuery?: string | null },
  city: string,
  country?: string,
): string[] {
  const scope = [city, country].filter(Boolean).join(', ');
  const out: string[] = [];
  const push = (q: string) => {
    const clean = cleanPlaceQuery(q);
    if (!clean) return;
    // Bare city name ("Paris") would resolve to the city itself.
    if (normalizeKey(clean) === normalizeKey(city)) return;
    const full = `${clean}, ${scope}`;
    if (!out.some((o) => normalizeKey(o) === normalizeKey(full))) out.push(full);
  };
  if (item.placeQuery) push(item.placeQuery);
  push(item.name);
  // Only a multi-word prefix: a lone capitalised word is usually a common noun
  // that opened the sentence ("Wine tasting in Le Marais" → "Wine"), and it
  // would pin some unrelated wine shop — worse than no pin.
  const prefix = properNounPrefix(cleanPlaceQuery(item.name));
  if (prefix && prefix.split(/\s+/).length >= 2) push(prefix);
  return out.slice(0, 2);
}
