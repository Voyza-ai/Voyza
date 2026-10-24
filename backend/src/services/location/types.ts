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
   * Ordered, and the ORDER IS LOAD-BEARING: `estimateHomeLegCost` prices every
   * route permutation from `airports[0]` alone. Alphabetical order would price
   * every Los Angeles trip from Burbank instead of LAX and silently change the
   * chosen itinerary. Sort: annual passengers descending, then distance.
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

/** Why a resolution came out the way it did. Logged, and shown in tests. */
export type ResolutionReason =
  | 'exact-unique'
  | 'qualifier-pinned'
  | 'user-location'
  | 'trip-context'
  | 'prominence'
  | 'iata-code'
  | 'fuzzy';

export type Candidate = {
  place: Place;
  /** Human-readable distinguisher: "Paris, Île-de-France, France". */
  label: string;
  airports: PlaceAirport[];
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

/** Lookup indexes, built once per process from the artifact. */
export type LocationIndex = {
  /** Normalised key -> place ids. One place yields MANY keys. */
  exact: Map<string, string[]>;
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
};
