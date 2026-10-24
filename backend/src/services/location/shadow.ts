/**
 * Shadow mode: run the old table and the new resolver side by side, serve one,
 * log every disagreement with the raw input.
 *
 * There is ONE Supabase project and it holds real trips, so "the tests pass"
 * is not enough evidence to swap the thing that decides which airport someone
 * flies from. The disagreement log is how the swap becomes a decision made on
 * production inputs rather than on imagined ones.
 *
 * Three modes, by `LOCATION_RESOLVER_MODE`:
 *
 *   off     the old table, nothing else runs. The pre-resolver behaviour,
 *           exactly, and the rollback.
 *   shadow  both run, the OLD answer is served, disagreements are logged.
 *   live    both run, the NEW answer is served, disagreements are logged.
 *
 * `live` keeps logging on purpose: after the flip, a disagreement is the only
 * signal that the resolver has started answering something differently than
 * the behaviour the old suite pinned down.
 *
 * Both are in-process and the resolver's exact path measures 0.005 ms, so
 * running both costs nothing worth measuring against a Duffel round trip.
 *
 * The flag is read per call, not captured at import. Flipping it is a restart
 * of nothing — which is the point: the rollback is an env change, not a deploy.
 */

import { getOriginAirports } from '../../data/originAirports';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { ResolveContext } from './types';
import {
  DEFAULT_MAX_AIRPORTS,
  resolveOriginAirports,
  type OriginResolution,
} from './originAirports';

export type ResolverMode = 'off' | 'shadow' | 'live';

export function resolverMode(): ResolverMode {
  return env.LOCATION_RESOLVER_MODE;
}

/** The old table's answer, in the new shape. It has no place id to give. */
function legacyResolution(cityName: string, max: number): OriginResolution {
  return { airports: getOriginAirports(cityName, max), placeId: null };
}

/**
 * How two answers differ, or null when they agree.
 *
 * Compared as an ORDERED list, not a set. `airports[0]` decides which airport
 * every route permutation is priced from, so `['JFK','EWR']` and
 * `['EWR','JFK']` are a real disagreement even though a traveller could use
 * either — they produce different itineraries and different totals.
 */
export type DisagreementKind =
  /** The table had nothing. Usually the resolver answering something new. */
  | 'legacy-empty'
  /** The table had an answer and the resolver did not. Always worth reading. */
  | 'resolver-empty'
  /**
   * The table's list is an ordered PREFIX of the resolver's: same leading
   * airport, same order, more fallbacks after it.
   *
   * Benign, and separated from a real conflict because it is the most common
   * shape by far: measured over the table's own 109-case suite, 36 of 77
   * disagreements were this. `airports[0]` is identical, so nothing is priced
   * differently; the resolver simply knows about Gary/Chicago as a third
   * Chicago option. Lumping these in with genuine conflicts buries the two
   * rows that matter under three dozen that do not.
   */
  | 'resolver-superset'
  /** Same airports, different order — so a different airports[0], and a
   *  different price. Never benign. */
  | 'different-order'
  /** Genuinely different places. */
  | 'different-airports';

export type Disagreement = {
  kind: DisagreementKind;
  legacy: string[];
  resolver: string[];
};

function isPrefix(shorter: string[], longer: string[]): boolean {
  return shorter.length < longer.length && shorter.every((code, i) => code === longer[i]);
}

export function compare(legacy: string[], resolver: string[]): Disagreement | null {
  const same = legacy.length === resolver.length && legacy.every((c, i) => c === resolver[i]);
  if (same) return null;

  const sameSet =
    new Set(legacy).size === new Set(resolver).size && legacy.every((code) => resolver.includes(code));

  const kind: DisagreementKind =
    legacy.length === 0
      ? 'legacy-empty'
      : resolver.length === 0
        ? 'resolver-empty'
        : isPrefix(legacy, resolver)
          ? 'resolver-superset'
          : sameSet
            ? 'different-order'
            : 'different-airports';

  return { kind, legacy, resolver };
}

/** Kinds that change which airport a traveller is priced from. */
const PRICE_CHANGING: ReadonlySet<DisagreementKind> = new Set<DisagreementKind>([
  'resolver-empty',
  'different-order',
  'different-airports',
  'legacy-empty',
]);

/**
 * Resolve origin airports under the current mode.
 *
 * Never throws. A resolver fault must not be able to take down a planning run
 * that the old table could have served, so the resolver side is wrapped: in
 * `shadow` a fault is logged and ignored, and in `live` it falls back to the
 * table rather than failing the request.
 */
export function originAirports(
  cityName: string | null | undefined,
  context: ResolveContext = {},
  max: number = DEFAULT_MAX_AIRPORTS,
): OriginResolution {
  const city = (cityName ?? '').trim();
  const mode = resolverMode();
  if (!city) return { airports: [], placeId: null };

  const legacy = legacyResolution(city, max);
  if (mode === 'off') return legacy;

  let resolved: OriginResolution | null = null;
  try {
    resolved = resolveOriginAirports(city, context, max);
  } catch (err) {
    logger.error('Location resolver threw; falling back to the table', {
      input: city,
      mode,
      message: err instanceof Error ? err.message : String(err),
    });
    return legacy;
  }

  const diff = compare(legacy.airports, resolved.airports);
  if (diff) {
    // The raw input is the whole point of the line: the original bug was
    // `"New Jersey"` arriving as `"NEW"`, and no aggregate would have shown it.
    // Price-changing disagreements go to `warn`, which this logger puts on
    // stderr, so the rows that would change someone's itinerary are readable
    // without filtering three dozen benign supersets out of stdout.
    const write = PRICE_CHANGING.has(diff.kind) ? logger.warn : logger.info;
    write('location-shadow disagreement', {
      input: city,
      served: mode === 'live' ? 'resolver' : 'legacy',
      kind: diff.kind,
      legacy: diff.legacy,
      resolver: diff.resolver,
      placeId: resolved.placeId,
      needsClarification: resolved.needsClarification?.reason,
      hadContext: Boolean(context.userLatLon ?? context.tripDestinationNames?.length),
    });
  }

  // Every `unknown` and `ambiguous` gets a line even when the two agree,
  // because the long tail only becomes discoverable if it is written down.
  if (resolved.needsClarification && !diff) {
    logger.info('location-shadow would ask', {
      input: city,
      reason: resolved.needsClarification.reason,
      candidates: resolved.needsClarification.candidates.map((c) => c.label),
    });
  }

  return mode === 'live' ? resolved : legacy;
}
