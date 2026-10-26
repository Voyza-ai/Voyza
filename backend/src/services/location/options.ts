/**
 * Every tunable in one file, each with the measurement or the case that fixed
 * it. A constant without a reason is a constant nobody can safely change.
 */

export type ResolverOptions = {
  /**
   * Prune range. A candidate with no scheduled airport within this many km is
   * dropped before deciding — which alone removes Paris KY, Buffalo MN,
   * Hartford WI and Providence UT from their respective contests.
   *
   * 200 km is about a 2-hour drive, which the owner accepted as a real option
   * provided the distance is shown. Pruning is a NARROWING, never a filter: if
   * it would empty the candidate set, the unpruned set is kept, because "we
   * found your town but it has no airport" must not become "we have never
   * heard of your town".
   */
  maxAirportKm: number;

  /**
   * Same-country near-tie margin, in prominence units (0..1).
   *
   * This is the ONLY scalar margin in the decision, and it applies only when
   * every candidate is in one country. Measured top-2 prominence gaps:
   * Springfield 0.005, San Jose 0.060, Vancouver 0.071, Hartford 0.120,
   * Portland 0.130, Buffalo 0.164, Paris 0.255. Paris has the WIDEST gap in
   * the set, which is why no threshold can both resolve Buffalo and ask about
   * Paris, and why the multi-country rule exists instead of a bigger number.
   *
   * 0.10 sits in the empty band between Springfield (ask) and Hartford
   * (resolve). The gate counts candidates within the margin of the top rather
   * than comparing the top two, so thirty Springfields and two Portlands are
   * judged by the same statistic.
   */
  nearTieEpsilon: number;

  /**
   * How much nearer the closest candidate must be before a coordinate signal
   * decides. Both conditions must hold: a ratio, so the rule scales from a
   * city pair to a continent pair, and an absolute floor, so two candidates
   * 60 km and 25 km from the traveller are not separated by arithmetic that
   * GPS noise could flip.
   */
  locationDominanceRatio: number;
  locationDominanceKm: number;

  /**
   * How far the traveller's own coordinates reach.
   *
   * Dominance alone is not enough, and a test caught it: from New York, Paris
   * Texas is 2,100 km away and Paris France is 5,800, which clears any ratio
   * — so `Paris` typed in Manhattan resolved to a town of 24,782 people. The
   * traveller's position is evidence about places NEAR them, so beyond this
   * radius it decides nothing and the question gets asked instead.
   *
   * The cost is honest: a traveller in Perth typing `Melbourne` will be asked,
   * because Melbourne is 2,700 km away. Asking is the documented safe failure;
   * silently flying them to Florida is not.
   *
   * It deliberately does NOT apply to the trip centroid. A centroid is a
   * region of travel, not a standing position: Paris is 1,100 km from the
   * middle of Rome and Florence, and that trip is still obviously European.
   */
  userLocalKm: number;

  /** Cap on the `ambiguous` list. Springfield has 30+ and nobody reads 30. */
  maxCandidates: number;
  /** Cap per admin region inside a country, so one state cannot fill the list. */
  maxPerAdminGroup: number;

  /** Cap on `unknown.suggestions`. Never auto-applied, so a short list is kind. */
  maxSuggestions: number;

  /**
   * Longest input we will look at. The endpoint needs a stated maximum, and a
   * 10 kB "place name" is an attack, not a city.
   */
  maxInputLength: number;
};

export const DEFAULT_OPTIONS: ResolverOptions = {
  maxAirportKm: 200,
  nearTieEpsilon: 0.1,
  locationDominanceRatio: 2,
  locationDominanceKm: 100,
  userLocalKm: 1000,
  maxCandidates: 8,
  maxPerAdminGroup: 2,
  maxSuggestions: 5,
  maxInputLength: 120,
};

/**
 * Edit distance allowed for a given query length. One edit on a short word is
 * already most of the word: at distance 2, `Ba` matches almost everything, and
 * `Paros`/`Paris` would be a 1-edit pair if `exact` had not already won.
 */
export function fuzzyDistanceFor(length: number): number {
  return length <= 8 ? 1 : 2;
}
