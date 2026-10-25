/**
 * The contract between the data pipeline and the resolver.
 *
 * Both sides are built independently against this file, so a change here is a
 * change to a published interface — update the fixture in `fixtures/` and both
 * test suites in the same commit.
 *
 * Design rationale lives in docs/LOCATION_RESOLUTION.md. The parts of it that
 * constrain these types are restated where they would otherwise look arbitrary.
 */

/** ISO 3166-1 alpha-2, uppercase. */
export type CountryCode = string;

/** IATA 3-letter code, uppercase. Airport or metropolitan area. */
export type IataCode = string;

export type PlaceKind = 'city' | 'metro' | 'region' | 'state' | 'country';

/**
 * An airport attached to a place.
 *
 * `servesPlace` is the owner's rule and it is not the same as "inside the
 * border": Newark is in New Jersey and is one of New York City's three
 * airports. Border logic would drop it. A place's airports are the ones a
 * traveller would actually use to reach it.
 */
export type PlaceAirport = {
  iata: IataCode;
  /** Great-circle km from the place's centre. Shown to the traveller. */
  km: number;
  /** True when this airport serves the place, whether or not it sits inside it. */
  servesPlace: boolean;
};

export type Place = {
  /** Stable across rebuilds. Persisted on a trip so a resolution is made once. */
  id: string;
  /** Display form, in its own script: "Köln", "São Paulo", "東京". */
  name: string;
  /**
   * Alternate spellings and colloquial names. Includes the curated layer —
   * "the bay area", "silicon valley", "nyc" — which no open dataset covers.
   */
  aliases: string[];
  /**
   * The HAND-WRITTEN strings that key this place, from
   * scripts/location-data/curated.ts rather than taken from a dataset.
   *
   * A curated alias is a decision ("nyc" IS New York City); a dataset
   * alternate name is an observation, and GeoNames' observations are dirty
   * enough to matter — Lomé, Togo carries the literal alternate name "rome".
   * The resolver trusts the two differently, so the provenance has to survive
   * into the artifact.
   *
   * NOT strictly a subset of `aliases`, and that is deliberate. A curated
   * string that folds to the place's own NAME is dropped from `aliases` by
   * the build's dedupe, so there is nothing there to mark — and a subset rule
   * therefore made such an entry a silent no-op. Measured: `washington`
   * targeted at Washington DC did nothing at all, because the city is already
   * called Washington, so the key stayed canonical and tied with Washington
   * State. A place's own name CAN be a curated decision; deciding that a bare
   * `Washington` is the capital is exactly that.
   *
   * Empty for the overwhelming majority of places.
   */
  curatedAliases: string[];
  kind: PlaceKind;
  country: CountryCode;
  /** State / province / admin1 code, where the place has one. */
  admin: string | null;
  lat: number;
  lon: number;
  /**
   * RAW population, never normalised to 0..1.
   *
   * Normalising anchors the scale to the dataset's extremes, so adding one city
   * rescales every weight, moves every score, and silently invalidates any
   * tuned threshold on the next rebuild. Scale at query time with fixed
   * constants instead. It also keeps the artifact diff readable.
   */
  population: number | null;
  /**
   * RAW prominence from airport size, same reasoning as `population`.
   * Measured Spearman 0.578 against real route traffic — a better traffic
   * proxy than population, which manages 0.451 at best.
   */
  airportRank: number | null;
  /**
   * IATA metropolitan code (NYC, LON, TYO, PAR) where one exists.
   *
   * Deliberately separate from `airports`. Production depends on both: metro
   * codes on the destination side, where one search covers every airport, and
   * individual codes on the origin side, so prices can be compared per
   * airport. Collapsing them breaks one or the other.
   */
  metro: IataCode | null;
  /**
   * Ordered, and the ORDER IS LOAD-BEARING, in two measured ways:
   *
   *  - `estimateHomeLegCost` searches `airports[0]` and nothing else, as a
   *    cheap signal for ranking route PERMUTATIONS. A bad lead degrades that
   *    ranking, so a worse itinerary can win.
   *  - only the first `MAX_HOME_AIRPORTS` (3) codes survive into the fan-out
   *    `buildHomeLeg` runs on the winning permutation, so the order decides
   *    which origins get priced at all.
   *
   * It is NOT the quoted fare on its own: `buildHomeLeg` prices every airport
   * that survives the cap and takes the cheapest. Alphabetical order would
   * still lead every Los Angeles trip with Burbank instead of LAX.
   *
   * Sort, in order:
   *   1. `servesPlace` descending — true before false. An airport in attach
   *      range that the place is not served by must never lead, nor take a
   *      capped slot from one that does: GEG, 107 km from Moscow, Idaho and
   *      flagged as not serving it, used to outrank PUW at 9 km.
   *   2. rank descending — large before medium before small. Stands in for
   *      annual passengers, which are not openly licensed globally; it is the
   *      OurAirports `type` ordinal, emitted in `airportRanks.json`.
   *   3. `km` ascending — nearer first, as the final tiebreak.
   *
   * A `state` or `region` gets no lead rule of its own, so a bare state name
   * can lead with a secondary airport of its dominant metro — California leads
   * with Burbank, not LAX. That is measured and accepted, not an oversight:
   * every proxy for "the state's main gateway" available from this data was
   * tried and was worse (see docs/LOCATION_RESOLUTION.md), and the cost is
   * bounded to the permutation-ranking signal rather than the fare.
   *
   * An authored pin overrides all of it, for the one place it was written for
   * (the LAX case above is a pin). A pin is never copied to a sibling city,
   * nor inherited by a parent state or region: copying is how Newark came to
   * lead with JFK, 35 km away, while EWR sat 5 km from the traveller. Where a
   * member of a metro group needs its own order it is authored for that place
   * — Kyoto and Nara are pinned to KIX, which is nearer no airport but is the
   * gateway they actually fly from.
   */
  airports: PlaceAirport[];
};

/** What the generator emits and the resolver loads. */
export type LocationArtifact = {
  /** Bumped by the generator when the shape changes. */
  schemaVersion: number;
  /** ISO timestamp of the build. */
  generatedAt: string;
  /** Upstream dataset dates, so a stale artifact is visible in a diff. */
  sources: {
    ourAirports: string;
    geoNames: string;
  };
  places: Place[];
};

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * What the caller knows, in the order the owner chose: the traveller's own
 * location first, then the trip they are planning, and only then a question.
 *
 * `tripDestinationNames` is NAMES, not `Place[]`, on purpose. The store keeps
 * plain strings with no coordinates, and resolving them to Places would need
 * context — which is what this field is for. The resolver resolves them
 * internally to a centroid and tolerates the ones it cannot.
 */
export type ResolveContext = {
  userLatLon?: { lat: number; lon: number };
  userCountry?: CountryCode;
  tripDestinationNames?: string[];
};

/**
 * Why a resolution came out the way it did. Logged, and shown in tests.
 *
 * There is deliberately no `'fuzzy'` reason. Fuzzy matching never resolves —
 * a near-miss comes back as `unknown.suggestions` for the caller to offer, and
 * is never applied on the traveller's behalf. Silently turning `pariss` into a
 * city is exactly the confident-wrong this design refuses.
 */
export type ResolutionReason =
  | 'exact-unique'
  | 'qualifier-pinned'
  | 'curated-alias'
  | 'user-location'
  | 'trip-context'
  | 'prominence'
  | 'iata-code';

export type Candidate = {
  place: Place;
  /** Human-readable distinguisher: "Paris, Île-de-France, France". */
  label: string;
  airports: PlaceAirport[];
  /**
   * Great-circle km from whatever the resolver measured against — the
   * traveller's position if it had one, otherwise the trip centroid.
   *
   * A structured field rather than text inside `label`, because the caller
   * needs to sort and format it: "2,057 km away" belongs to the UI's locale,
   * and a question ordered by distance is easier to answer than one ordered by
   * prominence. Absent when there was nothing to measure from.
   */
  distanceKm?: number;
  /** Populated on the fuzzy path so a caller can show "did you mean". */
  editDistance?: number;
};

/**
 * Three results, two of which are questions.
 *
 * A silent empty and a confident wrong are both bugs. The system is allowed not
 * to know; it is not allowed to pretend.
 *
 * There is deliberately no fourth result for "resolved but the airport is far
 * away". Distance is a field on every airport in every result and the traveller
 * picks — which is why Delaware resolving to Philadelphia needs no special case.
 */
export type Resolution =
  | {
      status: 'resolved';
      place: Place;
      /** Ranked. `airports[0]` is what a non-asking caller will price from. */
      airports: PlaceAirport[];
      via: ResolutionReason;
    }
  | {
      status: 'ambiguous';
      /** Ranked best-first, capped, grouped by country then admin. */
      candidates: Candidate[];
      /** Why we refused to choose — for the log, and for the question we ask. */
      reason: 'multi-country' | 'near-tie';
    }
  | {
      status: 'unknown';
      /** Fuzzy near-misses, possibly empty. Never auto-applied. */
      suggestions: Candidate[];
    };

/**
 * Where a key came from, and therefore how far it is trusted.
 *
 * Measured on the real artifact, not imagined: Lomé, Togo carries the literal
 * GeoNames alternate name "rome", which put Togo in the candidate list for
 * every `Rome` query. GeoNames alternate names are user-contributed and dirty
 * at that level, so a key that matches one place's OWN NAME and another's
 * alternate name is not a tie, and treating it as one is how a traveller gets
 * offered Togo.
 *
 * Ordered weakest-last; `KEY_TIER_RANK` in buildIndex.ts is the comparable
 * form. The resolver keeps only the best tier present for a key.
 */
export type KeyTier =
  /**
   * Hand-written in scripts/location-data/curated.ts. A decision, not an
   * observation: "nyc" IS New York City, and no amount of dataset evidence
   * about Manhattan's alternate names outvotes that.
   */
  | 'curated'
  /** The place's own display name, or its official code (ISO 3166-1, USPS). */
  | 'canonical'
  /** A dataset alternate name. Useful, and the least trustworthy of the three. */
  | 'alias';

/** One place found under a key, with the provenance of the match. */
export type KeyMatch = {
  id: string;
  tier: KeyTier;
};

/** Lookup indexes, built once per process from the artifact. */
export type LocationIndex = {
  /**
   * Normalised key -> the places found under it, with provenance. One place
   * yields MANY keys, and the same key can reach different places with very
   * different authority — see `KeyTier`.
   */
  exact: Map<string, KeyMatch[]>;
  /**
   * Country / state / region names and codes. MULTI-VALUED: a single-valued
   * map cannot hold both Georgia-the-state and Georgia-the-country.
   */
  qualifier: Map<string, string[]>;
  /**
   * IATA code -> place. Not optional: `LAX` is accepted as an origin today,
   * and without this index it falls to fuzzy and matches Lae, Papua New Guinea
   * at edit distance 1.
   */
  iata: Map<IataCode, string>;
  byId: Map<string, Place>;
  /** Typo tolerance. Consulted only when `exact` found nothing. */
  fuzzy: FuzzyIndex;
};

export type FuzzyIndex = {
  /** Keys within `maxDistance` edits of `key`, best-first. */
  search(key: string, maxDistance: number, limit: number): Array<{ key: string; distance: number }>;
  /** Reported by tests against the memory budget. */
  approxBytes(): number;
  /**
   * How many distinct trigrams the index holds. Diagnostics only.
   *
   * In the contract rather than reached for with a cast: the perf suite prints
   * it next to `approxBytes()` so a memory figure comes with the structure
   * size that explains it, and a test casting its way to a method is a test
   * the next refactor breaks silently.
   */
  trigramCount(): number;
};
