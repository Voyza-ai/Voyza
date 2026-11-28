import { resolve } from './location/resolve';
import { originIndex } from './location/originAirports';
import { logger } from '../utils/logger';

/**
 * Offline fallback for POST /api/plan/revise-destinations.
 *
 * When Claude is unreachable (no key, timeout, overload, malformed output)
 * the route used to answer 503, and the planner then handed the message to
 * the CURRENT question — so "actually Venice not Venezuela" typed at "Where
 * are you starting from?" became the traveller's origin: the exact bug the
 * endpoint exists to fix, back whenever the AI is down.
 *
 * This recognises the handful of phrasings people actually use for a
 * destination fix and turns them into the same tool calls the model would
 * make, so they go through the same `applyDestinationOps` and the same reply.
 * It is deliberately narrow: a false positive here would swallow an answer
 * to the current question, which is worse than a miss (a miss falls through
 * exactly as before). Every city it names on the trip side is resolved to the
 * EXACT listed name, because `applyDestinationOps` matches names exactly.
 */

export type RevisionCall = { name: string; input: Record<string, unknown> };

const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * The listed destination the user meant — tolerating case, accents and a
 * small typo ("florance"). Short names must match exactly ("Rice" is not
 * "Nice"); 5-6 letters allow one slip, longer names two.
 */
export function matchListed(destinations: string[], name: string): string | null {
  const n = norm(name);
  if (!n) return null;
  const exact = destinations.find((d) => norm(d) === n);
  if (exact) return exact;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const d of destinations) {
    const dist = editDistance(norm(d), n);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  const limit = n.length <= 4 ? 0 : n.length <= 6 ? 1 : 2;
  return bestDist <= limit ? best : null;
}

function cleanCity(raw: string): string {
  const t = raw
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’.!?,;:]+$/g, '')
    .replace(/^(the city of|to|in)\s+/i, '')
    .trim();
  return /[A-Z]/.test(t) ? t : t.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Is this a city the location index knows (not a country, not unknown)? */
function isKnownCity(name: string, others: string[]): boolean {
  try {
    const r: any = resolve(name, { tripDestinationNames: others }, originIndex());
    if (r.status === 'resolved') return !['country', 'state', 'region'].includes(r.place?.kind);
    if (r.status === 'ambiguous') return !(r.candidates ?? []).some((c: any) => c.place?.kind === 'country');
    return false;
  } catch (err: any) {
    logger.warn('revise-destinations rules: resolve failed', { name, message: err?.message });
    return false;
  }
}

const LEAD =
  /^(?:(?:oh|oops|sorry|wait|no|hmm|ok|okay)[,!.]?\s+)*(?:actually|i meant|i mean|make (?:it|that)|please)?[,\s]*/i;

const replace = (old: string, to: string): RevisionCall[] => [
  { name: 'replace_destination', input: { old, new: cleanCity(to) } },
];

/**
 * Tool calls for a recognised destination fix, or null when the message is
 * not one (the caller then keeps its old behaviour).
 */
export function ruleBasedRevision(message: string, destinations: string[]): RevisionCall[] | null {
  const text = message.trim().replace(LEAD, '').trim();
  if (!text || destinations.length === 0) return null;
  let m: RegExpMatchArray | null;
  let listed: string | null;

  // "replace / swap / switch / change X with|for|to Y"
  m = text.match(/^(?:replace|swap|switch|change)\s+(.+?)\s+(?:with|for|to|into)\s+(.+)$/i);
  if (m && (listed = matchListed(destinations, m[1]))) return replace(listed, m[2]);

  // "Y instead of X"
  m = text.match(/^(.+?)\s+instead of\s+(.+)$/i);
  if (m && (listed = matchListed(destinations, m[2]))) return replace(listed, m[1]);

  // "Y not X" / "Y, not X"
  m = text.match(/^(.+?),?\s+not\s+(.+)$/i);
  if (m) {
    if ((listed = matchListed(destinations, m[2]))) return replace(listed, m[1]);
    // The list can hold a city picked from a mistyped COUNTRY ("Venezuela"
    // → Caracas), so "Venice not Venezuela" names nothing listed. With one
    // destination the intent is still clear — but only for a city the index
    // knows, so "3 not 2" at the travellers step never becomes a destination.
    const to = cleanCity(m[1]);
    if (destinations.length === 1 && isKnownCity(to, [])) return replace(destinations[0], to);
  }

  // "drop / remove / skip / cut X"
  m = text.match(/^(?:drop|remove|skip|cut|delete)\s+(.+?)(?:\s+(?:from the (?:trip|list)|please))?$/i);
  if (m && (listed = matchListed(destinations, m[1]))) {
    return [{ name: 'remove_destination', input: { city: listed } }];
  }

  // "add X (after|before Y)"
  m = text.match(
    /^(?:add|also add|include)\s+(.+?)(?:\s+(after|before)\s+(.+?))?(?:\s+(?:to the (?:trip|list)|too|as well|please))?$/i,
  );
  if (m) {
    const city = cleanCity(m[1]);
    if (!isKnownCity(city, destinations)) return null;
    const anchor = m[3] ? matchListed(destinations, m[3]) : null;
    const input: Record<string, unknown> = { city };
    if (anchor) input[m[2].toLowerCase() === 'before' ? 'beforeCity' : 'afterCity'] = anchor;
    return [{ name: 'add_destination', input }];
  }

  return null;
}
