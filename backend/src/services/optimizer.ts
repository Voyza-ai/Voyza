import { compareLeg, LegComparison, type CompareLegParams } from './compareLeg';
import { getIataCode, isFlightSearchCached, searchFlights, type IataLookupContext } from './flights';
import { isDuffelTestOffer, withoutTestAirlineWhenRealOffered } from '../utils/testAirline';
import { logger } from '../utils/logger';
import { getCityCountry } from '../data/cityCountries';
import { searchLegOptions, LegOption } from './legOptions';
import { resolveOriginAirports, type OriginCandidate } from './location/originAirports';
import { sameAirportArea } from './location/sameAirportArea';
import { NO_AIRLINE_SERVICE } from '../data/noAirlineService';
import { addDays, clampToFuture, todayIso } from '../utils/dates';
import { withDuffelRetryBudget } from './duffelBudget';
import { AppError } from '../middleware/error';
import { searchHotels, plannerHotelPick } from './hotels';
import { searchTrains, type SearchTrainsParams, type TrainOffer } from './trains';
import { trainSearchKey } from './trainKey';
import type { ProgressSink } from './optimizeProgress';

/**
 * Lookups shared by everything ONE optimize() run does (B8).
 *
 * Every candidate ordering re-asks for the legs it shares with the others:
 * a 5-city trip scores 120 orderings × 4 legs = 480 compareLeg calls for
 * 80 distinct legs. Duffel itself was already deduped (flights.ts caches
 * the in-flight search), but each compareLeg call still did 2 Supabase
 * reads and an upsert — 992 reads and 496 leg_price_cache upserts per run,
 * measured — and getIataCode hit airport_codes again for every leg of
 * every ordering (251 calls for ONE city on that trip).
 *
 * Scoped to the run, not the process: a module-level memo would keep a
 * stale leg price across runs, which leg_price_cache (2h) and flights.ts
 * (10 min) already decide deliberately. A rejected lookup stays rejected
 * for the rest of the run — the same answer every caller would have got.
 *
 * Trip context: `iata` resolves every DESTINATION in this run — compareLeg
 * and the home-leg estimates and builds go through it — and always passes
 * the trip's city names, so "Lagos" on a Lisbon + Porto trip is FAO and
 * bare it is LOS. Keying its memo by name alone stays correct: the context
 * is the same for every destination lookup in a run, so within a run a name
 * has exactly one answer; another trip is another run with its own memo.
 *
 * The HOME city is a different question and goes through `homeIata`, with
 * NO trip context and its own memo. Where someone lives is independent of
 * where they are going — a Portugal itinerary makes Lagos, Portugal LESS
 * likely to be home, not more — and the destinations as context actively
 * hurt: getIataCode checks a Duffel suggestion against the trip's stops, so
 * a home town only Duffel knows (far from the trip, by definition) was
 * refused and the trip lost its home flights. Separate memos also mean a
 * name that is both home and a stop ("Lagos" -> LOS home, FAO stop) never
 * shares one answer.
 */
type RunContext = {
  /** Every city on the trip — the context every airport lookup gets. */
  tripCityNames: string[];
  /**
   * getIataCode with this run's trip context. The optional second argument
   * exists to fit CompareLegDeps; it is ignored, because the run's context
   * is fixed (compareLeg passes the same names it was given by this run).
   */
  iata: (cityName: string, context?: IataLookupContext) => Promise<string>;
  /** getIataCode for the HOME city: no trip context, its own memo. */
  homeIata: (cityName: string) => Promise<string>;
  compare: (params: CompareLegParams) => Promise<LegComparison>;
  /** `compare`'s answers so far, by compareKey. */
  compareMemo: Map<string, Promise<LegComparison>>;
  /** searchFlights, counted — see `flightOutcomes`. */
  flights: typeof searchFlights;
  /**
   * How this run's flight searches ended (B14). `answered` includes a search
   * that came back with no offers: that is a route nobody flies, not an
   * outage. `threw` counts searches that errored after flights.ts' retries,
   * plus airport lookups that failed with a 5xx (Duffel down before a search
   * could even start); a 404 "no airport" is neither.
   */
  flightOutcomes: { answered: number; threw: number; firstError: unknown };
  /**
   * Every distinct flight search this run asked for (route, date, party), and
   * the phase that asked first — at most one Duffel request each, since
   * flights.ts dedupes repeats (fewer when it already held the answer from
   * another run). Logged once per run as "Optimize flight searches", so the
   * Duffel rate-limit budget of a plan can be read off production logs.
   * Leg-alternative enrichment (legOptions.ts) searches outside the run
   * context and is not in it; it re-asks for the winner's legs, which
   * flights.ts already holds.
   */
  searchLedger: Map<string, SearchPhase>;
  /**
   * The ledger's searches that were not in flights.ts' cache when first asked
   * for — the ones that cost this run a Duffel request (a home flight the
   * chat pre-searched, prewarmHomeFlights, does not).
   */
  sentLedger: Map<string, SearchPhase>;
  /** The same run context, with its searches recorded under `phase`. */
  phased(phase: SearchPhase): RunContext;
  /**
   * The day `compare` searches a leg's trains on (CompareLegDeps.trainDate);
   * undefined = the leg's own day. See `withTrainDate`.
   */
  trainDate?: TrainDateRule;
  /**
   * The same run context (memos, phase, counters), with `compare` searching
   * trains by `rule` — undefined puts every leg back on its own day. Drops
   * any train source (withTrainSource): only ranking reads the rail board.
   */
  withTrainDate(rule: TrainDateRule | undefined): RunContext;
  /** Where `compare` gets trains from (see createRailBoard); undefined: `rail.search`. */
  trainSource?: TrainSource;
  /** This run's rail searches, one per route-day (see RunRail). */
  rail: RunRail;
  /** The same run context, with `compare` taking its trains from `source`. */
  withTrainSource(source: TrainSource | undefined): RunContext;
};

/**
 * A replacement for searchTrains inside compareLeg (CompareLegDeps.searchTrains).
 * `id` goes into the compare memo key: a leg priced on a source's trains is
 * a different answer from the same leg searched normally.
 */
type TrainSource = {
  id: string;
  search: (params: SearchTrainsParams) => Promise<TrainOffer[]>;
};

/**
 * Every rail search one optimize() run makes — the rail board, the winner's
 * real days, its leg alternatives, the date-shift probe — goes through here,
 * keyed exactly as trains.ts caches (trainSearchKey). The FIRST answer for a
 * route-day is the run's answer, incomplete or not: trains.ts drops an
 * incomplete answer from its cache, so production's 4-city plan searched
 * Paris → Prague on one day three times, ~25 s each, and the winner's exact
 * re-price and its alternatives searched the same route-day back to back.
 *
 * `retry`: one more search, once per run, of a route-day whose answer had no
 * priced train — for the work after the ranking (the winner's legs, their
 * alternatives, the date-shift probe). A cold All Aboard search very often
 * answers the second time; the plan before this prototype found those trains
 * by searching the same route-day again and again (see trains.ts noRoute).
 * A route-day the provider said has no route is not searched again.
 *
 * `quick`: the ranking's lighter search (searchTrains' `quick`).
 */
type RunRail = {
  search: (params: SearchTrainsParams) => Promise<TrainOffer[]>;
  retry: (params: SearchTrainsParams) => Promise<TrainOffer[]>;
  /** The ranking's lighter search (searchTrains' `quick`), once per route-day. */
  quick: (params: SearchTrainsParams) => Promise<TrainOffer[]>;
};

function createRunRail(searchFn: typeof searchTrains = searchTrains): RunRail {
  const first = new Map<string, Promise<TrainOffer[]>>();
  const retried = new Map<string, Promise<TrainOffer[]>>();
  const quickMemo = new Map<string, Promise<TrainOffer[]>>();
  const quick = (params: SearchTrainsParams): Promise<TrainOffer[]> => {
    const key = trainSearchKey(params);
    let hit = quickMemo.get(key);
    if (!hit) {
      hit = searchFn(params, { quick: true }).catch(() => [] as TrainOffer[]);
      quickMemo.set(key, hit);
    }
    return hit;
  };
  const search = (params: SearchTrainsParams): Promise<TrainOffer[]> => {
    const key = trainSearchKey(params);
    let hit = first.get(key);
    if (!hit) {
      hit = searchFn(params).catch(() => [] as TrainOffer[]);
      first.set(key, hit);
    }
    return hit;
  };
  const retry = async (params: SearchTrainsParams): Promise<TrainOffer[]> => {
    const answer = await search(params);
    if (answer.some((t) => t.price != null)) return answer;
    const key = trainSearchKey(params);
    let hit = retried.get(key);
    if (!hit) {
      hit = searchFn(params).catch(() => answer);
      retried.set(key, hit);
    }
    return hit;
  };
  return { search, retry, quick };
}

/** Which day to search a leg's trains on, given what compareLeg is asked. */
type TrainDateRule = (params: CompareLegParams) => string;

/**
 * Why a run searched (see RunContext.searchLedger):
 *  - score:    1-3 and 6+ city trips — every candidate ordering priced in full
 *  - screen:   4-5 city trips — each city pair priced once, plus the typed order
 *  - exact:    4-5 city trips — the best-first rounds after the screen
 *  - home:     home flights for ranking (4+ cities; within `score` otherwise)
 *  - homeLegs: the winner's home flights, when ranking had not already searched them
 *  - probe:    the date-shift probe (1-3 cities)
 */
type SearchPhase = 'score' | 'screen' | 'exact' | 'home' | 'homeLegs' | 'probe';

function createRunContext(tripCityNames: string[], report?: ProgressSink): RunContext {
  // Live counts for the planner's search screen (optimizeProgress.ts): each
  // distinct leg comparison and flight search this run asks for, counted at
  // the memo / ledger that already dedupes them.
  const legCounts = { asked: 0, priced: 0 };
  const flightOutcomes: RunContext['flightOutcomes'] = { answered: 0, threw: 0, firstError: undefined };
  const noteThrow = (err: unknown) => {
    flightOutcomes.threw++;
    if (flightOutcomes.firstError === undefined) flightOutcomes.firstError = err;
  };

  const counted: typeof searchFlights = async (params) => {
    try {
      const offers = await searchFlights(params);
      flightOutcomes.answered++;
      return offers;
    } catch (err) {
      noteThrow(err);
      throw err;
    }
  };
  const searchLedger = new Map<string, SearchPhase>();
  const sentLedger = new Map<string, SearchPhase>();
  const flightsFor = (phase: SearchPhase): typeof searchFlights => (params) => {
    // flights.ts' cache key: a repeat of any of these is not another request.
    const key = [params.origin, params.destination, params.date, params.travelers, params.cabinClass ?? 'economy'].join('|');
    if (!searchLedger.has(key)) {
      searchLedger.set(key, phase);
      // (Guarded: tests that replace flights.ts may not provide it.)
      const cached = typeof isFlightSearchCached === 'function' && isFlightSearchCached(params);
      if (!cached) sentLedger.set(key, phase);
      report?.({ flightSearches: searchLedger.size });
    }
    return counted(params);
  };

  const memoized = (lookup: (cityName: string) => Promise<string>) => {
    const memo = new Map<string, Promise<string>>();
    return (cityName: string): Promise<string> => {
      let hit = memo.get(cityName);
      if (!hit) {
        hit = lookup(cityName);
        hit.catch((err: any) => {
          if ((err?.statusCode ?? 0) >= 500) noteThrow(err);
        });
        memo.set(cityName, hit);
      }
      return hit;
    };
  };
  const iata = memoized((cityName) =>
    getIataCode(cityName, { tripDestinationNames: tripCityNames }),
  );
  const homeIata = memoized((cityName) => getIataCode(cityName));

  // One memo for every phase: a leg priced by the screen is the same leg
  // when scoring reads it.
  const compareMemo = new Map<string, Promise<LegComparison>>();
  const rail = createRunRail();
  const build = (
    phase: SearchPhase,
    trainDate: TrainDateRule | undefined,
    trainSource: TrainSource | undefined,
  ): RunContext => {
    const flights = flightsFor(phase);
    const compare = (params: CompareLegParams): Promise<LegComparison> => {
      const onDay = trainDate?.(params);
      const key = compareKey(params, onDay) + (trainSource ? `|rail@${trainSource.id}` : '');
      let hit = compareMemo.get(key);
      if (!hit) {
        hit = compareLeg(params, {
          getIataCode: iata,
          searchFlights: flights,
          ...(onDay ? { trainDate: onDay } : {}),
          searchTrains: trainSource ? trainSource.search : rail.search,
        });
        compareMemo.set(key, hit);
        if (report) {
          legCounts.asked++;
          report({ legsAsked: legCounts.asked });
          const done = () => {
            legCounts.priced++;
            report({ legsPriced: legCounts.priced });
          };
          hit.then(done, done);
        }
      }
      return hit;
    };
    return {
      tripCityNames, iata, homeIata, compare, compareMemo, flights, flightOutcomes, searchLedger, sentLedger,
      trainDate,
      trainSource,
      rail,
      phased: (next) => build(next, trainDate, trainSource),
      withTrainDate: (rule) => build(phase, rule, undefined),
      withTrainSource: (source) => build(phase, trainDate, source),
    };
  };
  return build('score', undefined, undefined);
}

/**
 * Every input compareLeg reads — a memo must never merge two travel days,
 * party sizes or country hints. (tripCityNames is left out: it is the same
 * for the whole run.)
 */
function compareKey(params: CompareLegParams, trainDate?: string): string {
  const key = [
    params.origin,
    params.destination,
    params.date,
    params.travelers,
    params.originCountry ?? '',
    params.destinationCountry ?? '',
  ].join('|');
  // A leg whose trains were searched on another day is a different answer;
  // on its own day it is the same one, whichever rule asked.
  return trainDate && trainDate !== params.date ? `${key}|trains@${trainDate}` : key;
}

/**
 * The date-shift probe's Duffel work, held so it can be given up on (see
 * DATE_SHIFT_GRACE_SHORT_TRIP_MS). At most `limit` units are let through at a time —
 * a unit is one compareLeg call or one home-flight search, i.e. at most one
 * Duffel offer request. Once the probe is given up on, every unit still
 * waiting is refused instead of sent, so an abandoned probe stops spending
 * the Duffel rate limit after the ones already in flight.
 *
 * Why a gate of our own: searchFlights has no way to cancel a search once
 * it is queued in flights.ts (and none to abort one in flight), and the
 * probe used to hand it every search at once. Holding them here is the only
 * point where an unsent search can still be dropped.
 */
type ProbeGate = {
  run<T>(unit: () => Promise<T>): Promise<T>;
  /** Refuse every unit from now on; says how many were running and waiting. */
  abandon(): { inFlight: number; waiting: number };
  readonly abandoned: boolean;
};

function createProbeGate(limit: number): ProbeGate {
  let abandoned = false;
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    get abandoned() {
      return abandoned;
    },
    abandon() {
      abandoned = true;
      const at = { inFlight: active, waiting: waiters.length };
      waiters.splice(0).forEach((wake) => wake());
      return at;
    },
    async run<T>(unit: () => Promise<T>): Promise<T> {
      while (active >= limit && !abandoned) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      if (abandoned) {
        throw new Error('Date-shift probe given up on: search not sent');
      }
      active++;
      try {
        return await unit();
      } finally {
        active--;
        waiters.shift()?.();
      }
    },
  };
}

/**
 * The run context the date-shift probe prices through: the run's airport
 * memos and counted searches, with every NEW leg comparison and home-flight
 * search going through `gate`. A leg the run already compared is served from
 * the run's memo without waiting on the gate. The probe's own comparisons
 * get their own memo, so an answer it was refused never reaches the run's.
 */
function probeContext(
  ctx: RunContext,
  gate: ProbeGate,
  trainDate?: TrainDateRule,
  /** The run's rail the probe reads: the same retry the winner's legs got. */
  trainSearch: TrainSource['search'] = ctx.rail.search,
): RunContext {
  const memo = new Map<string, Promise<LegComparison>>();
  const compare = (params: CompareLegParams): Promise<LegComparison> => {
    const onDay = trainDate?.(params);
    const key = compareKey(params, onDay);
    let hit = ctx.compareMemo.get(key) ?? memo.get(key);
    if (!hit) {
      hit = gate.run(() =>
        compareLeg(params, {
          getIataCode: ctx.iata,
          searchFlights: ctx.flights,
          ...(onDay ? { trainDate: onDay } : {}),
          searchTrains: trainSearch,
        }),
      );
      memo.set(key, hit);
    }
    return hit;
  };
  const flights: typeof searchFlights = (params) => gate.run(() => ctx.flights(params));
  return {
    ...ctx,
    compare,
    compareMemo: memo,
    flights,
    trainDate,
    trainSource: undefined,
    withTrainDate: (rule) => probeContext(ctx, gate, rule, trainSearch),
    withTrainSource: () => probeContext(ctx, gate, trainDate, trainSearch),
  };
}

/**
 * Longest ranking waits for rail, counted from when the rail board starts
 * (the top of optimize()): none — ranking waits for every city pair's FIRST
 * rail answer, as the plan always did, so it ranks on every train the plan
 * before this ranked on. Every pair is searched once, up front, all at once,
 * on the ranking day (createRailBoard), so that wait is one round of rail
 * (~16-20 s when a cold route answers [ERROR, UPSTREAM_UNAVAILABLE]) and it
 * runs alongside the flight searches, not inside every round as it used to
 * (production's 4-city plan: 177 s on 33 flight searches, 2026-11-24).
 *
 * It was 8 s, which ranked T3 (5 cities from New York, replayed 2026-11-27)
 * without the Berlin → Vienna train ($95.09) that answered at ~11 s: the
 * plan picked an ordering $59 dearer than the plan before this. A train that
 * answers is never ranked without. OPT_RAIL_WAIT_MS sets a cap, for the
 * benchmark (backend/scripts/opt-bench) only.
 */
const RAIL_RANKING_WAIT_MS = Infinity;

/**
 * The trip's rail, searched once per ordered city pair on the ranking day,
 * all at once and before any flight — so ranking rounds wait on flights only.
 *
 * `source` is what ranking's compareLeg reads trains from (TrainSource): the
 * board's answers as they stood at the SNAPSHOT — as soon as every pair has
 * answered (or, with a cap, RAIL_RANKING_WAIT_MS after the board started,
 * if that is first). One snapshot for the whole ranking: every ordering is ranked on the
 * same trains, so two orderings never differ only by when their legs were
 * priced. A pair not in the snapshot is ranked on its flights.
 *
 * The searches run on after the snapshot (into trains.ts' caches), and the
 * winner's legs take a late answer when they are priced on their own day
 * (`answerNow` for the first answer; searchTrains' cache for the rest).
 * Asking the board for any other day, or a pair it does not hold, searches
 * as usual.
 */
type RailBoard = {
  source: TrainSource;
  /** The pair's answer if its search has finished, at any time; undefined while it runs. */
  answerNow(from: string, to: string): TrainOffer[] | undefined;
  /** Whether ranking had the pair's answer (false before the snapshot). */
  snapshotHad(from: string, to: string): boolean;
  /** For the run's log line: pairs searched, answered by the snapshot, with a priced train in it, and answered by now. */
  stats(): { pairs: number; inSnapshot: number; pricedInSnapshot: number; settled: number; snapshotMs: number | null };
};

function createRailBoard(args: {
  pairs: Array<[string, string]>;
  day: string;
  travelers: number;
  countryOf: (city: string) => string | undefined;
  waitMs: number;
  search?: (params: SearchTrainsParams) => Promise<TrainOffer[]>;
}): RailBoard {
  const search = args.search ?? ((p: SearchTrainsParams) => searchTrains(p));
  const started = Date.now();
  const key = (from: string, to: string) => `${from}\u0000${to}`;
  const held = new Set<string>();
  const settled = new Map<string, TrainOffer[]>();
  const pending: Array<Promise<void>> = [];
  for (const [from, to] of args.pairs) {
    const k = key(from, to);
    if (held.has(k)) continue;
    held.add(k);
    pending.push(
      search({
        origin: from,
        destination: to,
        date: args.day,
        travelers: args.travelers,
        originCountry: args.countryOf(from),
        destinationCountry: args.countryOf(to),
      }).then(
        (offers) => {
          settled.set(k, offers);
        },
        () => {
          settled.set(k, []);
        },
      ),
    );
  }
  let snapshotMs: number | null = null;
  let inSnapshot = 0;
  let frozen: Map<string, TrainOffer[]> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const snapshot: Promise<Map<string, TrainOffer[]>> = Promise.race([
    Promise.all(pending),
    // No cap (Infinity): only every pair's answer ends the wait.
    ...(Number.isFinite(args.waitMs)
      ? [
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, args.waitMs);
          }),
        ]
      : []),
  ]).then(() => {
    clearTimeout(timer);
    snapshotMs = Date.now() - started;
    inSnapshot = settled.size;
    frozen = new Map(settled);
    return frozen;
  });
  return {
    source: {
      id: 'board',
      search: (p) => {
        const k = key(p.origin, p.destination);
        if (p.date !== args.day || !held.has(k)) return search(p);
        return snapshot.then((m) => m.get(k) ?? []);
      },
    },
    answerNow: (from, to) => settled.get(key(from, to)),
    snapshotHad: (from, to) => frozen?.has(key(from, to)) ?? false,
    stats: () => ({
      pairs: held.size,
      inSnapshot,
      pricedInSnapshot: frozen ? [...frozen.values()].filter((offers) => offers.some((t) => t.price != null)).length : 0,
      settled: settled.size,
      snapshotMs,
    }),
  };
}

type CityInput = {
  name: string;
  country?: string;
};

type OptimizedLeg = {
  from: string;
  to: string;
  comparison: LegComparison;
  cost: number;
  /**
   * Top-N alternatives (mixed flight + train, sorted cheapest-first)
   * for THIS leg. Populated only on the winning route's legs — the
   * scoring phase uses just `comparison` (cheapest pair) since that's
   * all permutation ranking needs. The frontend reads `options` if
   * present and falls back to `comparison`-derived data when absent.
   */
  options?: LegOption[];
};

type OptimizedRoute = {
  ordering: string[];
  /** Sum of the prices we actually found. A leg with no offer adds nothing. */
  totalCost: number;
  /**
   * Ranking-only cost: `totalCost` plus UNAVAILABLE_LEG_PENALTY for every
   * inter-city leg and UNAVAILABLE_HOME_LEG_PENALTY for every home leg whose
   * search came back empty. Sorting on this instead of totalCost is what
   * stops an ordering with a missing $700 outbound from beating one where
   * every flight exists. Never shown to the user; the frontend reads
   * totalCost, which stays real money.
   */
  rankCost: number;
  legs: OptimizedLeg[];
};

/**
 * A route as scored internally: the public shape plus how many of its legs
 * (inter-city and home) could not be priced. Stripped before the result
 * leaves optimize(), so the API shape is unchanged.
 */
type ScoredRoute = OptimizedRoute & { unpricedLegs: number };

function toPublicRoute(route: ScoredRoute): OptimizedRoute {
  const { unpricedLegs: _unpriced, ...rest } = route;
  return rest;
}

/**
 * Nudge-style suggestion when shifting the trip by a day or two would save
 * the user real money. Surfaced as a banner on the results page so the
 * primary itinerary is never blocked on this computation.
 */
export type DateShiftOption = {
  /** Offset from the user's requested start date, in days. Negative = earlier. */
  dayOffset: number;
  /** ISO date after applying the offset. */
  newStartDate: string;
  /**
   * What the trip costs with the shifted dates: inter-city legs, home flights
   * (when they could be priced at the requested dates too) and every hotel
   * stay, moved by the same offset.
   */
  newTotalCost: number;
  /**
   * USD saved against the requested start date, like for like: the same
   * legs, home flights and stays — same cities, nights, party and rooms, the
   * planner's own hotel pick per city — on both sides. A shift moves every
   * hotel night, so hotels are in both sides (see confirmDateShiftWithHotels).
   */
  savings: number;
};

/**
 * Headline fields describe the single best shift (kept flat for backward
 * compatibility with saved trips and older clients); `options` lists the
 * shifts offered, best first — the results header shows these as a "pick your
 * dates" menu. Since hotels are counted, only the best transport candidate is
 * re-priced (RapidAPI quota), so `options` holds that one shift.
 */
export type DateShiftSuggestion = DateShiftOption & {
  options?: DateShiftOption[];
};

/**
 * Home-anchor leg — what the user flies to get from their origin city
 * to the first destination (outbound) or back from the last destination
 * (return). Stored alongside routes so the frontend can render a "Home"
 * card at the start (and end, for round-trips) of the flowchart.
 */
export type HomeLeg = {
  /** IATA of the origin airport that won the multi-airport comparison. */
  originAirport: string;
  /** IATA of the destination airport (first city, or the origin if returning). */
  destAirport: string;
  /** Cheapest price across all searched origin airports. */
  price: number;
  currency: string;
  durationMinutes: number;
  operator: string;
  carrierCode: string;
  departTime: string | null;
  arriveTime: string | null;
  departDate: string;
  /**
   * Local calendar date the flight LANDS (the date part of Duffel's
   * `arriving_at`, which is wall-clock time at the destination airport).
   * Differs from departDate on overnight flights: JFK 19:25 Dec 8 → Paris
   * 12:00 Dec 9. Optional — absent when Duffel gave no arrival timestamp,
   * and on HomeLegs saved before this field existed.
   */
  arriveDate?: string;
  stops: number;
  bookingUrl: string | null;
  /**
   * Up to 3 cheapest alternative offers for this same leg (different
   * carriers / times / airports). The main fields above describe the
   * cheapest pick; this array lets the user swap to another option from
   * the flowchart without re-searching. Each entry is a fully-populated
   * HomeLeg minus its own alternatives (no recursion). Optional —
   * absent when the underlying search returned only one offer.
   */
  alternatives?: Omit<HomeLeg, 'alternatives'>[];
};

/**
 * An origin name that had more than one real reading, carried out on the
 * result instead of asked about mid-run.
 *
 * An optimize run is already spending money on Duffel by the time the origin
 * matters, so it prices the most prominent reading and reports this. The
 * planner conversation can ask; the callers that cannot ask at least have
 * something to show, and a place id to persist once someone chooses.
 *
 * Absent on every unambiguous origin, which is the overwhelming majority.
 */
export type OriginClarification = {
  /** The raw string, exactly as it arrived. */
  input: string;
  reason: 'multi-country' | 'near-tie' | 'not-found';
  candidates: OriginCandidate[];
};

export type OptimizeResult = {
  routes: OptimizedRoute[];
  bestRoute: OptimizedRoute;
  savingsVsNaive: number;
  iataCodes: Record<string, string>;
  dates: Record<string, { arrival: string; departure: string }>;
  /** Present only when a nearby date offset saves meaningful money. */
  dateShiftSuggestion?: DateShiftSuggestion;
  /**
   * True only when nearby start dates were actually priced (at least one
   * offset) and, if one looked cheaper, its hotels were priced too — so "no
   * suggestion" means "checked, nothing cheaper", which the results header
   * may then say. False when the probe was skipped, failed or priced nothing.
   */
  dateShiftChecked: boolean;
  /**
   * Home → first_city transport. Present when `origin` was provided.
   * Null when the first-city search failed (e.g. no flights found from
   * any origin airport — frontend renders the home card but marks the
   * outbound as "search failed" rather than hiding it).
   */
  outboundLeg?: HomeLeg | null;
  /**
   * last_city → home transport. Present only when `returnToHome: true`
   * AND the return search succeeded.
   */
  returnLeg?: HomeLeg | null;
  /**
   * Set when the origin name was ambiguous and the run picked a reading to
   * continue. The legs above were priced from `candidates[0]`.
   */
  originClarification?: OriginClarification;
  /**
   * Only on a two-phase FIRST answer (OptimizeParams.onFirstAnswer): its
   * trains are the ranking day's, not yet re-priced on each leg's own day.
   */
  provisional?: boolean;
};

type OptimizeParams = {
  cities: CityInput[];
  startDate: string;
  travelers: number;
  budget?: number;
  /**
   * User's home city. When set, we:
   *   1. Test ALL destination permutations (no more fixed-first hack)
   *   2. Add a home → first_city leg to each permutation's total cost
   *   3. If returnToHome, add a last_city → home leg too
   *   4. Return outboundLeg and optionally returnLeg on the result
   */
  origin?: string;
  /**
   * IATA codes for the origin city. 1-3 entries. When the origin is a
   * multi-airport city (e.g. NYC → JFK/LGA/EWR), we search all in
   * parallel and pick the cheapest. Populated on the frontend from the
   * originAirports.ts lookup or the user's saved preference.
   */
  originAirports?: string[];
  /** Round-trip if true, one-way if false. Default true. */
  returnToHome?: boolean;
  /**
   * Total nights for the trip across all cities. Distributed evenly
   * across the destinations (with leftover nights spread to the front).
   * Optional — when omitted we fall back to the legacy
   * 2-nights-per-city default.
   */
  totalNights?: number;
  /**
   * Nights per city, by city name: a preset's own split ("Lisbon 3, Sintra
   * 1") kept by "Plan a similar trip" (website audit m11). Each city keeps
   * its nights in whatever order the optimizer puts it. Used only when it
   * names every city with a whole number of nights and agrees with
   * `totalNights`; otherwise the nights are spread evenly, as without it.
   */
  cityNights?: Record<string, number>;
  /** Live progress for the planner's search screen (optimizeProgress.ts). */
  onProgress?: ProgressSink;
  /**
   * Two-phase answer (prototype, exp/optimizer-speed). Called once, as soon
   * as the ranking is decided, with the trip as ranking priced it: the
   * winner's legs (trains from the rail board's snapshot, so a leg off the
   * ranking day carries that day's train — `provisional: true`), its home
   * flights from ranking's own searches, and no leg alternatives or
   * date-shift check yet. optimize() then finishes as before — trains on
   * their real days, alternatives, home flights from every airport, the
   * date-shift probe — and resolves with that full result.
   */
  onFirstAnswer?: (first: OptimizeResult) => void;
  /** Tests only: RAIL_RANKING_WAIT_MS for this run. */
  railWaitMs?: number;
};

const DEFAULT_NIGHTS_PER_CITY = 2;

/**
 * Ranking penalty for an inter-city leg whose search came back with nothing
 * (neither flight nor train). A missing HOME leg is charged
 * UNAVAILABLE_HOME_LEG_PENALTY below instead.
 * Without it a missing leg costs `Math.min(Infinity, Infinity) → 0`, so the
 * optimizer happily picks a "$200 trip" with two nonexistent segments over
 * a $900 one where everything exists. Large enough to swamp any real fare
 * difference, and it only ever lands in `rankCost` — the user-facing
 * totalCost stays the sum of prices we actually found.
 */
const UNAVAILABLE_LEG_PENALTY = 5000;

/**
 * Ranking penalty for a missing HOME flight — deliberately far heavier than
 * a missing inter-city leg, so ranking is lexicographic: fewest missing home
 * flights first, then fewest missing inter-city legs, then money.
 *
 * With one shared penalty, a city with no airport cost the same wherever it
 * went. NYC → Zurich, Interlaken, Geneva with rail down: Interlaken in the
 * middle is two unpriced ground legs (2 × 5000); Interlaken first is one
 * unpriced ground leg plus no outbound flight at all (2 × 5000) — a tie, so
 * real money broke it, and the ordering that skipped the $600 transatlantic
 * fare won and was reported as "$480 saved" (harness, 2026-10-29). Nobody
 * would plan it that way: fly into Zurich, take the train through
 * Interlaken, fly home from Geneva. An unpriced inter-city hop is usually a
 * short ground leg we can't quote; a missing home flight is the whole way
 * there. 20 × the inter-city penalty keeps that order for up to 20 unpriced
 * inter-city legs, far past any trip this scores.
 */
const UNAVAILABLE_HOME_LEG_PENALTY = UNAVAILABLE_LEG_PENALTY * 20;

/**
 * Hard cap on how many origin airports one home-leg search fans out to.
 * Each entry is its own Duffel offer-request and the array comes from the
 * caller: /api/optimize and /api/flights/home-legs both take
 * `originAirports` straight from the request body, and their schemas bound
 * each string's length, not the array's. originAirports.ts documents 1-3
 * codes per metro ("keep the array <=3 long"), so anything past the third
 * is a mistake or abuse.
 */
const MAX_HOME_AIRPORTS = 3;

/**
 * Most a date-shift search may wait to retry. Duffel allows ~45 accepted
 * requests a minute per token (measured on production, 2026-10-30), shared by
 * every user — so by the time the probe runs, the window may be spent and the
 * next one up to a minute away. The probe is a "leave a day early, save $X"
 * banner; waiting a whole window for it held finished plans open. 3s still
 * covers one ordinary 5xx backoff (1-3s on the first retry).
 */
const DATE_SHIFT_RETRY_WAIT_MS = 3000;

/**
 * Trips of up to this many cities run the date-shift probe; longer ones do
 * not start it at all.
 *
 * On 4+ cities the probe cost 6-20 Duffel searches and was given up on 1.5s
 * after the plan was ready, so users almost always got no suggestion and
 * dateShiftChecked: false anyway — which is exactly what they get now, with
 * none of the searches. Those searches mattered: Duffel's test token accepts
 * ~45 a minute, and a 5-city plan's own searches already come close (see
 * rankByAdaptiveScreen); every probe search past the window stalled the NEXT
 * plan, anyone's, for up to a minute. The results header shows no price claim
 * without dateShiftChecked, as it did when the probe timed out.
 */
const DATE_SHIFT_MAX_CITIES = 3;

/**
 * How long the date-shift probe may run past the core result (winner chosen,
 * leg alternatives and home legs built) on the 1-3 city trips that run it: it
 * is what puts "Best price for these dates" in their results header. There it
 * needs 8-16 searches after the winner — on the owner's 3-city trip, 4.5s past
 * the core result with 6 search slots and 5.3s at ~2.5 searches/s. 10s
 * covers the largest 3-city probe at that rate (16 searches ≈ 6.4s plus one
 * round trip) and its hotel check; it only cuts a probe stuck behind
 * rate-limit retries, which could otherwise hold the plan open for as long as
 * those take. Past it the plan is returned without a suggestion and with
 * dateShiftChecked: false.
 */
const DATE_SHIFT_GRACE_SHORT_TRIP_MS = 10_000;

/**
 * Largest per-date move a fare is assumed to make: a route's fare on any two
 * of a trip's travel days differs by at most ±30% around its level, so one
 * fare is never less than (1 - 0.3) / (1 + 0.3) ≈ 0.54 of another. The
 * adaptive screen (rankByAdaptiveScreen) counts an unpriced leg at that
 * fraction of the same route's fare on another day — the most it could
 * possibly drop — which is what makes its winner the exhaustive one.
 *
 * Measured, not proven, for real fares; the simulation harness
 * (backend/scripts/opt-speed/) reports how the winner degrades when fares
 * swing ±50% instead.
 */
const MAX_DATE_SWING = 0.3;
const SCREEN_LOWER_BOUND = (1 - MAX_DATE_SWING) / (1 + MAX_DATE_SWING);

/**
 * Most INTER-CITY Duffel searches (screen + best-first) one 4-5 city plan may
 * send. Home flights are outside it: every traveller airport is searched for
 * every city and direction (searchHomeOffers), a fixed 2 × cities × airports
 * that the planner pre-searches during the chat (prewarmHomeFlights).
 *
 * Duffel's window is 30 requests per wall-clock minute per token, shared by
 * every user (its `ratelimit-*` headers, 2026-11-24) — not the ~45 this was
 * first sized on. Two jobs, kept apart:
 *  - PACING the window is flights.ts': once an answer says the window is
 *    spent, nothing more is sent until Duffel's reset (noteDuffelWindow), so a
 *    plan waits for the next minute instead of collecting 429s.
 *  - EXPLORATION is this budget, and it never gives best-first less than the
 *    plan before it did: 42 − 10 home − 20 screen = 12 for 5 cities on Duffel's
 *    live mode (one metro search per city and direction), 8-10 on the test
 *    token. 32 − 20 screen = 12; 4 cities 32 − 12 = 20 (was 18). A cheaper
 *    winner than before can come from comparing every home airport; a dearer
 *    one must not come from searching less.
 * So a budget-stopped 5-city plan can send 32 inter-city searches: at most 2
 * past one window, and only after its home flights went in an earlier one.
 *
 * History: production's shipped screen sent 79 for one 5-city Chicago plan
 * (home 26, screen 20, exact 33 over 25 rounds; 54-89 s cold, 2026-11-02).
 * With ±30% fares 98% of budget-limited plans still picked the exhaustive
 * winner (gate, 1,000 simulated plans, 2026-11-02).
 *
 * OPT_PLAN_BUDGET overrides it for the benchmark (backend/scripts/opt-bench).
 */
const PLAN_SEARCH_BUDGET = Number(process.env.OPT_PLAN_BUDGET) > 0 ? Number(process.env.OPT_PLAN_BUDGET) : 32;

/** Inter-city searches a run has asked for so far (what PLAN_SEARCH_BUDGET counts). */
function interCitySearches(ctx: RunContext): number {
  let n = 0;
  for (const phase of ctx.searchLedger.values()) if (phase === 'screen' || phase === 'exact') n++;
  return n;
}

/**
 * Most legs one best-first round prices: flights.ts' search slots
 * (MAX_CONCURRENT_SEARCHES). A round is one Duffel round trip (~2.6 s median
 * on production) whether 1 or 6 searches are in it, and rounds run one
 * after another, so pricing one leg a round made production's 25 rounds
 * ≈ 65 s on their own.
 */
const EXACT_ROUND_WIDTH = 6;

/**
 * Distribute a total night count across N cities.
 *
 * Spreads nights as evenly as possible, putting leftover nights on the
 * front cities (so a 7-night, 3-city trip becomes [3, 2, 2] not
 * [2, 2, 3] — first stop is the longest, which matches how most
 * travelers think about a multi-city itinerary).
 *
 * Returns a per-city array, indexed the same as the city ordering. When
 * totalNights is undefined, returns a uniform array of
 * DEFAULT_NIGHTS_PER_CITY entries to preserve the legacy behavior.
 */
function distributeNights(totalNights: number | undefined, cityCount: number): number[] {
  if (cityCount <= 0) return [];
  if (typeof totalNights !== 'number' || totalNights <= 0) {
    return Array(cityCount).fill(DEFAULT_NIGHTS_PER_CITY);
  }
  const base = Math.floor(totalNights / cityCount);
  const extra = totalNights - base * cityCount;
  return Array.from({ length: cityCount }, (_, i) => (i < extra ? base + 1 : base));
}

/**
 * `cityNights` keyed by trimmed, lower-cased city name, or null when it can't
 * be used as given: a city missing or named twice, a night count that isn't
 * a positive whole number, or a total that disagrees with `totalNights`.
 */
export function cityNightsByName(
  cityNights: Record<string, number> | undefined,
  cities: Array<{ name: string }>,
  totalNights: number | undefined,
): Map<string, number> | null {
  if (!cityNights) return null;
  const key = (name: string) => name.trim().toLowerCase();
  const given = new Map<string, number>();
  for (const [name, nights] of Object.entries(cityNights)) {
    if (!Number.isInteger(nights) || nights <= 0 || given.has(key(name))) return null;
    given.set(key(name), nights);
  }
  if (given.size !== cities.length || !cities.every((c) => given.has(key(c.name)))) return null;
  const sum = [...given.values()].reduce((a, b) => a + b, 0);
  if (typeof totalNights === 'number' && totalNights > 0 && sum !== totalNights) return null;
  return given;
}

function getPermutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of getPermutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

/**
 * Resolve a country code for a city, preferring the explicit field from
 * CityInput (if set by the AI interpret stage) and falling back to our
 * static city→country map for common cities.
 */
function countryOf(city: CityInput): string | undefined {
  if (city.country) return city.country.toUpperCase();
  return getCityCountry(city.name);
}

/**
 * An ordering is "country-clustered" when all cities sharing a country are
 * contiguous in the sequence. Prevents itineraries like
 * Tokyo → Shanghai → Osaka → Beijing where you bounce between countries.
 *
 * If *any* city has an unknown country, we can't reliably apply the filter,
 * so the route passes (safer than dropping legitimate orderings).
 */
function isCountryClustered(ordering: string[], cityMap: Map<string, CityInput>): boolean {
  const countryAt = (name: string): string | undefined => {
    const c = cityMap.get(name);
    return c ? countryOf(c) : undefined;
  };

  // If any city's country is unknown, skip the check (return true).
  for (const name of ordering) {
    if (!countryAt(name)) return true;
  }

  // Walk the ordering — once we leave a country we must never re-enter it.
  const seen = new Set<string>();
  let current: string | undefined;
  for (const name of ordering) {
    const country = countryAt(name)!;
    if (country !== current) {
      if (seen.has(country)) return false; // re-entering
      seen.add(country);
      current = country;
    }
  }
  return true;
}

/**
 * Candidate orderings for trips too large to permute (6 cities = 720
 * orderings, each one a full round of leg searches).
 *
 * The previous heuristic ran nearest-neighbor over
 * `|hash(nameA) - hash(nameB)|` — a pseudo-distance with no relation to
 * geography — and, unlike the ≤5-city path, never applied
 * isCountryClustered. Six cities across Japan and China came back
 * interleaved (Tokyo → Beijing → Osaka → Shanghai → …): exactly the shape
 * the clustering filter exists to reject.
 *
 * There are no city coordinates in the backend, so rather than invent a
 * distance we build up to three orderings that are country-clustered BY
 * CONSTRUCTION and let the real leg prices rank them:
 *
 *   1. country blocks in the order the user first mentioned them
 *   2. the whole sequence reversed (still clustered — different first and
 *      last city, so different home legs)
 *   3. the largest country block first (the long stay up front)
 *
 * Cities whose country we don't know form one trailing block, so they stay
 * contiguous instead of splitting a known one. Duplicates are dropped —
 * with a single country block the three collapse into two sequences, and
 * each duplicate would cost another full round of searches.
 */
function countryGroupedOrderings(cities: CityInput[]): string[][] {
  const UNKNOWN = '??';
  const blocks: string[][] = [];
  const byCountry = new Map<string, string[]>();
  for (const city of cities) {
    const key = countryOf(city) ?? UNKNOWN;
    let block = byCountry.get(key);
    if (!block) {
      block = [];
      byCountry.set(key, block);
      blocks.push(block);
    }
    block.push(city.name);
  }

  const unknownBlock = byCountry.get(UNKNOWN);
  const inOrder = unknownBlock
    ? [...blocks.filter((b) => b !== unknownBlock), unknownBlock]
    : blocks;
  // Stable sort — same-size blocks keep first-mention order.
  const largestFirst = [...inOrder].sort((a, b) => b.length - a.length);

  const candidates: string[][] = [
    inOrder.flat(),
    inOrder.flat().reverse(),
    largestFirst.flat(),
  ];

  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const candidate of candidates) {
    const key = candidate.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

/**
 * Rank a 4-5 city trip's candidate orderings within a fixed number of Duffel
 * searches: the same winner as pricing every one of them whenever the budget
 * lets it prove that, and otherwise the best ordering it priced in full.
 *
 * Why: Duffel's test token accepts ~45 searches a minute, shared by every
 * user; the rest stall until the window resets, up to a minute later.
 * Pricing all 120 orderings of 5 cities on their real travel days is 80
 * inter-city searches (20 ordered city pairs × 4 travel days), and a cold
 * 5-city plan made ~116 Duffel requests in all: it stalled every time, 69-80s
 * on production (2026-10-30). Pricing only a fixed top-K of a cheap screen
 * failed: K = 8 still picked a different winner 3.8% of the time, up to 16%
 * dearer.
 *
 * How:
 *  1. (Started by the caller) home flights for every city that can start or
 *     end the trip — one fixed day each, so these are always exact — and,
 *     here, the typed order's legs on their own days: savingsVsNaive compares
 *     the winner with the typed order, so both must be real prices.
 *  2. The screen: every other ordered city pair once, on the day it is flown
 *     in the candidate ordering with the cheapest home flights that contains
 *     it (ties: permutation order). Those are the orderings most likely to
 *     win, so a screen fare is often already the exact one they need.
 *  3. Best-first. Every ordering gets a bound — the least it could cost: a
 *     leg priced on its own day at full value (UNAVAILABLE_LEG_PENALTY if
 *     nothing flies), any other leg at SCREEN_LOWER_BOUND × the highest fare
 *     its route showed on any day — the most it can drop — or 0 if it showed
 *     none, and home flights at full value (UNAVAILABLE_HOME_LEG_PENALTY if
 *     none). Every ordering whose bound is below the best fully priced one's
 *     total could still beat it. While there are any, a round prices up to
 *     EXACT_ROUND_WIDTH legs on their own days: every unpriced leg of the
 *     one LIKELIEST to be cheap (each unpriced leg at the average fare its
 *     route showed), then of the next, and so on — whole orderings, so every
 *     round leaves fully priced candidates behind. When none is left, the
 *     best fully priced ordering is the exhaustive winner, and ties break by
 *     permutation order as the old stable sort did.
 *  4. The budget. A round only takes orderings it can price in full within
 *     `budget.remaining()` searches; when none fits, best-first stops and
 *     the best FULLY PRICED ordering wins — not proven, by design: proving it
 *     took production's 5-city Chicago plan 25 rounds and 33 searches on
 *     Duffel's test token, whose fares swing ±60-80% between dates, and a
 *     ±30% plan up to 20-30 searches in the tail. There is always such an
 *     ordering once the typed order is a candidate (it is priced in step 1);
 *     when it is not one (the country filter dropped it), the first
 *     contender is priced in full whatever the budget says.
 *
 * Unavailable legs are charged exactly as scoring charges them: the winner's
 * legs are always priced on their own days, and a leg with nothing on its
 * day costs UNAVAILABLE_LEG_PENALTY, so a missing leg never wins by being
 * missing. A route with nothing on the day it was screened is NOT assumed
 * dead — routes that do not fly daily are common — it is simply unbounded
 * (0) until its own day is priced. (Assuming it dead was tried: with 5% of
 * route-days missing it picked a different winner 4.6% of the time, up to
 * 48% dearer.)
 *
 * Bounds: one round prices at most EXACT_ROUND_WIDTH legs and is one Duffel
 * round trip; every round prices at least one new leg, and none goes past the
 * budget (5 cities: 2 rounds at most but for the rare forced one; see
 * PLAN_SEARCH_BUDGET). Deterministic: the same fares give the same searches
 * and answer.
 *
 * Returns the orderings proven best, best first: the winner, then each next
 * one that is already fully priced with nothing able to undercut it — at most
 * three, at no extra search. One is normal; see optimize() for why routes[1..2]
 * need not be bought. After a budget stop, only the winner.
 */
async function rankByAdaptiveScreen(args: {
  /** Candidate orderings, in permutation order (the order ties break in). */
  orderings: string[][];
  /** The order the user typed — priced exactly whether or not it is a candidate. */
  typed: string[];
  /** The day leg `i` of any ordering is flown. */
  legDate: (i: number) => string;
  /** Leg `i` from `from` to `to`, priced on its own day; Infinity when nothing flies. */
  priceLeg: (from: string, to: string, i: number, phase: 'screen' | 'exact') => Promise<number>;
  /** Each ordering's home flights, penalties applied, in scoring's order (outbound, return). */
  homeCosts: Promise<(ordering: string[]) => number[]>;
  /** Searches best-first may still send (read before each round); omitted: no limit. */
  budget?: { remaining: () => number };
}): Promise<{ ranked: string[][]; rounds: number; budgetStop: boolean }> {
  const { orderings, typed, legDate, priceLeg } = args;
  const routeOf = (from: string, to: string) => `${from}\u0000${to}`;
  const legOf = (from: string, to: string, i: number) => `${routeOf(from, to)}\u0000${legDate(i)}`;

  /** Leg cost on its own day (Infinity: nothing flies), by legOf. */
  const exact = new Map<string, number>();
  /** Highest fare a route showed on any day it was priced (none: no fare yet). */
  const highest = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  /** The fares a route showed, on any day (for the expected cost of a day not priced yet). */
  const seen = new Map<string, { sum: number; n: number }>();
  /** The same, over every route. */
  const seenAll = { sum: 0, n: 0 };
  /** Routes priced at least once, fare or not. */
  const pricedRoutes = new Set<string>();
  const price = (from: string, to: string, i: number, phase: 'screen' | 'exact'): Promise<void> => {
    const key = legOf(from, to, i);
    let asked = pending.get(key);
    if (!asked) {
      asked = priceLeg(from, to, i, phase).then((cost) => {
        exact.set(key, cost);
        const route = routeOf(from, to);
        pricedRoutes.add(route);
        if (cost !== Infinity && cost > (highest.get(route) ?? -Infinity)) highest.set(route, cost);
        if (cost !== Infinity) {
          const fares = seen.get(route) ?? { sum: 0, n: 0 };
          seen.set(route, { sum: fares.sum + cost, n: fares.n + 1 });
          seenAll.sum += cost;
          seenAll.n++;
        }
      });
      pending.set(key, asked);
    }
    return asked;
  };

  // 1. The typed order, on its own days.
  const typedRoutes = new Set<string>();
  const typedLegs: Array<Promise<void>> = [];
  for (let i = 0; i < typed.length - 1; i++) {
    typedRoutes.add(routeOf(typed[i], typed[i + 1]));
    typedLegs.push(price(typed[i], typed[i + 1], i, 'screen'));
  }

  // 2. The screen, once the home flights say which orderings look best.
  const homeOf = await args.homeCosts;
  const home = orderings.map((o) => homeOf(o));
  const screenDay = new Map<string, { from: string; to: string; i: number; homeTotal: number }>();
  orderings.forEach((o, idx) => {
    const homeTotal = home[idx].reduce((sum, c) => sum + c, 0);
    for (let i = 0; i < o.length - 1; i++) {
      const route = routeOf(o[i], o[i + 1]);
      if (typedRoutes.has(route)) continue;
      const best = screenDay.get(route);
      if (!best || homeTotal < best.homeTotal) screenDay.set(route, { from: o[i], to: o[i + 1], i, homeTotal });
    }
  });
  await Promise.all([...typedLegs, ...[...screenDay.values()].map((s) => price(s.from, s.to, s.i, 'screen'))]);

  // 3. Best-first.
  /**
   * What an unpriced day of `route` is expected to cost: the average fare it
   * showed; UNAVAILABLE_LEG_PENALTY if it was priced and showed none (it may
   * fly on other days, but spending the budget on it first left plans with a
   * missing leg when a fully flown ordering existed: 4.6% of 5-city plans
   * with 5% of routes and route-days missing, gate 2026-11-02); every
   * route's average if never priced.
   */
  const expected = (route: string) => {
    const fares = seen.get(route);
    if (fares) return fares.sum / fares.n;
    if (pricedRoutes.has(route)) return UNAVAILABLE_LEG_PENALTY;
    return seenAll.n > 0 ? seenAll.sum / seenAll.n : 0;
  };
  const estimate = (idx: number) => {
    const o = orderings[idx];
    let total = 0;
    let likely = 0;
    const open: Array<{ i: number; slack: number }> = [];
    for (let i = 0; i < o.length - 1; i++) {
      const cost = exact.get(legOf(o[i], o[i + 1], i));
      if (cost !== undefined) {
        const charged = cost === Infinity ? UNAVAILABLE_LEG_PENALTY : cost;
        total += charged;
        likely += charged;
        continue;
      }
      const route = routeOf(o[i], o[i + 1]);
      const high = highest.get(route);
      likely += expected(route);
      if (high !== undefined) {
        total += SCREEN_LOWER_BOUND * high;
        open.push({ i, slack: (1 - SCREEN_LOWER_BOUND) * high });
      } else {
        // Nothing known about this day: the route was never priced, or had
        // no fare on the day(s) it was — and a route that does not fly
        // daily may well fly on this one. No bound, then: 0. A leg that
        // turns out to have nothing on its own day is
        // UNAVAILABLE_LEG_PENALTY, as in scoring, so it never wins by being
        // missing.
        open.push({ i, slack: Infinity });
      }
    }
    for (const c of home[idx]) {
      total += c;
      likely += c;
    }
    return { idx, total, likely, open };
  };

  // Cheapest bound first; ties in permutation order, as the old stable sort.
  const ranking = () => orderings.map((_, idx) => estimate(idx)).sort((a, b) => a.total - b.total || a.idx - b.idx);

  let rounds = 0;
  let budgetStop = false;
  for (;;) {
    const est = ranking();
    // Everything ahead of the best fully priced ordering could still beat
    // it; nothing ahead of it means it is the exhaustive winner.
    const incumbent = est.findIndex((e) => e.open.length === 0);
    if (incumbent === 0) break;
    // Priced in the order they are likely to cost, not in bound order: a
    // bound is what an ordering could cost at best, and spending a limited
    // budget on the orderings that only look cheap because most of their
    // legs are unpriced left the budget-stopped plans with poor answers
    // (gate, 2026-11-02, 5 cities, ±30% fares: the exhaustive winner in 92%
    // of 200 plans in bound order, 98% of 1,000 in this one).
    const contenders = (incumbent === -1 ? est : est.slice(0, incumbent)).sort(
      (a, b) => a.likely - b.likely || a.idx - b.idx,
    );
    // No fully priced candidate yet (the typed order is not one): the first
    // contender is priced in full whatever the budget, so there is always
    // an answer.
    const forced = incumbent === -1;
    const cap = Math.min(EXACT_ROUND_WIDTH, args.budget?.remaining() ?? Infinity);

    const batch = new Map<string, { idx: number; i: number }>();
    for (const e of contenders) {
      const fresh = e.open
        .map(({ i }) => ({ idx: e.idx, i, key: legOf(orderings[e.idx][i], orderings[e.idx][i + 1], i) }))
        .filter(({ key }) => !batch.has(key));
      // Whole orderings only: a half-priced one can never be the answer.
      if (batch.size + fresh.length > cap && !(forced && batch.size === 0)) continue;
      for (const leg of fresh) batch.set(leg.key, leg);
      if (batch.size >= cap) break;
    }
    if (batch.size === 0) {
      budgetStop = true;
      break;
    }
    await Promise.all([...batch.values()].map(({ idx, i }) => price(orderings[idx][i], orderings[idx][i + 1], i, 'exact')));
    rounds++;
  }

  const final = ranking();
  const ranked: string[][] = [];
  if (budgetStop) {
    ranked.push(orderings[final.find((e) => e.open.length === 0)!.idx]);
  } else {
    for (const e of final) {
      if (e.open.length > 0 || ranked.length === 3) break;
      ranked.push(orderings[e.idx]);
    }
  }
  return { ranked, rounds, budgetStop };
}

/**
 * The day leg `i` of an ordering is travelled: after the nights spent in
 * cities 0..i. City 0 occupies the first nights[0] days, so leg 0 happens on
 * day nights[0]. Clamped to today-or-later — Duffel rejects past dates
 * outright.
 */
function legDateAt(startDate: string, nights: number[], i: number): string {
  let offset = 0;
  for (let j = 0; j <= i; j++) offset += nights[j] ?? DEFAULT_NIGHTS_PER_CITY;
  return clampToFuture(addDays(startDate, offset));
}

/**
 * What scoring asks compareLeg for one leg. The adaptive screen prices legs
 * through the same params, so the run's compare memo serves scoring from it.
 */
function legCompareParams(
  from: string,
  to: string,
  date: string,
  travelers: number,
  cityMap: Map<string, CityInput>,
  ctx: RunContext,
): CompareLegParams {
  const fromCity = cityMap.get(from);
  const toCity = cityMap.get(to);
  return {
    origin: from,
    destination: to,
    date,
    travelers,
    tripCityNames: ctx.tripCityNames,
    originCountry: fromCity?.country ?? getCityCountry(from),
    destinationCountry: toCity?.country ?? getCityCountry(to),
  };
}

/** A leg's price: the cheaper of its flight and train; Infinity when neither has one. */
function legCost(comparison: LegComparison): number {
  return Math.min(comparison.flightOption?.price ?? Infinity, comparison.trainOption?.price ?? Infinity);
}

/**
 * Score a route using per-leg dates (not the same startDate for every leg).
 * The i-th leg happens after the user has spent `nightsPerCity` nights in
 * each preceding city, so pricing reflects the actual travel day.
 */
async function scoreRoute(
  ordering: string[],
  startDate: string,
  travelers: number,
  cityMap: Map<string, CityInput>,
  /**
   * Per-city nights array, indexed by ordering. Cumulative sum gives
   * the leg date offset. When omitted we use uniform
   * DEFAULT_NIGHTS_PER_CITY for every city — preserving the legacy
   * behavior for callers (date-shift probe, naive route) that haven't
   * been updated to thread the user's totalNights through.
   */
  nightsArray: number[] | undefined,
  ctx: RunContext,
): Promise<ScoredRoute> {
  const nights = nightsArray ?? distributeNights(undefined, ordering.length);
  const legPromises = [];
  for (let i = 0; i < ordering.length - 1; i++) {
    const from = ordering[i];
    const to = ordering[i + 1];
    const legDate = legDateAt(startDate, nights, i);

    legPromises.push(
      ctx.compare(legCompareParams(from, to, legDate, travelers, cityMap, ctx)).then((comparison) => ({
        from,
        to,
        comparison,
        cost: legCost(comparison),
      })),
    );
  }

  const resolvedLegs = await Promise.all(legPromises);

  // Two totals, deliberately: `totalCost` is real money (a leg we couldn't
  // price adds nothing, which is also all the UI can show for it), while
  // `rankCost` charges UNAVAILABLE_LEG_PENALTY for it so broken orderings
  // sort last instead of looking free.
  let totalCost = 0;
  let rankCost = 0;
  let unpricedLegs = 0;
  for (const leg of resolvedLegs) {
    if (leg.cost === Infinity) {
      rankCost += UNAVAILABLE_LEG_PENALTY;
      unpricedLegs++;
    } else {
      totalCost += leg.cost;
      rankCost += leg.cost;
    }
  }

  return { ordering, totalCost, rankCost, legs: resolvedLegs, unpricedLegs };
}

type DateShiftHome = {
  originAirports: string[];
  returnToHome: boolean;
  totalNights: number;
};

type HomeFlightsPrice = {
  /** Outbound + (if round trip) return, or null when either can't be priced. */
  cost: number | null;
  /** Home-side airport of the cheapest outbound / return fare found. */
  outboundAirport: string | null;
  returnAirport: string | null;
};

/**
 * Price the home flights for a trip starting on `start`, the same way the
 * scoring pass does (estimateHomeLeg, cache-warm). `cost` is null when any
 * needed home flight can't be priced — an unpriced flight would read as its
 * whole fare "saved". `airports` narrows which home airports each direction
 * is searched from; by default both use all of `home.originAirports`.
 */
async function homeFlightsCost(
  ctx: RunContext,
  home: DateShiftHome,
  bestOrdering: string[],
  start: string,
  travelers: number,
  airports: { outbound: string[]; ret: string[] } = {
    outbound: home.originAirports,
    ret: home.originAirports,
  },
): Promise<HomeFlightsPrice> {
  // Independent searches — run them together, not one after the other.
  const [outbound, ret] = await Promise.all([
    estimateHomeLeg(ctx, {
      originAirports: airports.outbound,
      destinationCity: bestOrdering[0],
      date: clampToFuture(start),
      travelers,
    }),
    home.returnToHome
      ? estimateHomeLeg(ctx, {
          originAirports: airports.ret,
          destinationCity: bestOrdering[bestOrdering.length - 1],
          date: clampToFuture(addDays(start, home.totalNights)),
          travelers,
          reverse: true,
        })
      : Promise.resolve(null),
  ]);
  const costs = [outbound.cost, ...(ret ? [ret.cost] : [])];
  return {
    cost: costs.some((c) => c === Infinity) ? null : costs.reduce((sum, c) => sum + c, 0),
    outboundAirport: outbound.homeAirport,
    returnAirport: ret?.homeAirport ?? null,
  };
}

/**
 * Re-price the WHOLE trip at -2/-1/+1/+2 day start offsets and compare
 * like with like: inter-city legs + home flights at the requested dates vs
 * the same at each shifted date. Home flights are the biggest and most
 * date-sensitive cost (a Tuesday departure vs a Friday one), so leaving
 * them out made the feature honest but almost never useful.
 *
 * When the home flights can't be priced at the REQUESTED dates, the
 * comparison falls back to inter-city legs only (still like with like).
 * A shifted date whose legs or home flights can't all be priced is never
 * offered — a missing fare must not read as a saving.
 *
 * Transport only: the best candidate this returns is then held to the whole
 * trip, hotels included, by confirmDateShiftWithHotels before anyone sees it.
 *
 * `baselineLegs` is the winning route's inter-city legs at the requested
 * dates — on their real days, so it is known only once their trains are —
 * or null when one is unpriced (its $0 would read as a saving: no
 * suggestion). The shifted dates are searched without waiting for it; it is
 * needed only for the comparison at the end.
 */
async function findDateShiftSuggestion(
  bestOrdering: string[],
  requestedStartDate: string,
  baselineLegs: Promise<number | null>,
  travelers: number,
  cityMap: Map<string, CityInput>,
  nightsArray: number[],
  home: DateShiftHome | null,
  ctx: RunContext,
  outcome?: DateShiftOutcome,
): Promise<DateShiftSuggestion | undefined> {
  const offsets = [-2, -1, 1, 2];

  // Skip offsets that would land in the past (users can't book for yesterday)
  const today = todayIso();
  const candidateOffsets = offsets.filter((o) => addDays(requestedStartDate, o) >= today);

  // Baseline home flights at the requested dates. Unpriceable → compare
  // inter-city legs only for every offset.
  //
  // The baseline is the cheapest fare across ALL home airports — the same
  // number the scoring pass ranked with, and served from its cache. Each
  // shifted date is then priced from the airport that won that direction
  // only. That makes the shifted cost an upper bound on what the trip would
  // really cost on that date (another airport can only be cheaper), so the
  // saving shown can understate but never overstate. Probing from
  // originAirports[0] on both sides used to offer "save $350" on a trip
  // that was already flying the cheaper airport for $50 less; probing every
  // airport would be exact but costs (airports - 1) × 2 × 4 more Duffel
  // searches on every run.
  const baselineHome = home
    ? await homeFlightsCost(ctx, home, bestOrdering, requestedStartDate, travelers)
    : null;
  const baselineHomeCost = baselineHome?.cost ?? null;
  const includeHome = home !== null && baselineHomeCost !== null;
  // A priced direction always has its airport; [] (never searched → never
  // offered) is only reachable if that invariant breaks.
  const winnerOnly = (airport: string | null | undefined) => (airport ? [airport] : []);
  const shiftedAirports = {
    outbound: winnerOnly(baselineHome?.outboundAirport),
    ret: winnerOnly(baselineHome?.returnAirport),
  };

  const shifted = await Promise.all(
    candidateOffsets.map(async (offset) => {
      const startDate = addDays(requestedStartDate, offset);
      try {
        // Same nights array as the real trip → the same leg dates, just
        // shifted, so these searches reuse the caches the scoring pass
        // warmed instead of pricing dates nobody will travel.
        //
        // Legs and home flights for one offset are independent searches,
        // so they run together (they used to run legs-then-home).
        const hasLegs = bestOrdering.length > 1;
        // Trains on the leg's PLANNED day — the one the baseline was priced
        // on, so they are already searched. Each shifted day was a new rail
        // search (~11 of the 500 hourly All Aboard units; 8 of a 3-city
        // trip's 18), to move a probe that is about flight fares: rail fares
        // barely change from one day to the next.
        const legsCtx = ctx.withTrainDate((p) => addDays(p.date, -offset));
        const [route, priced] = await Promise.all([
          hasLegs
            ? scoreRoute(bestOrdering, startDate, travelers, cityMap, nightsArray, legsCtx)
            : Promise.resolve(null),
          includeHome
            ? homeFlightsCost(ctx, home as DateShiftHome, bestOrdering, startDate, travelers, shiftedAirports)
            : Promise.resolve(null),
        ]);
        if (route && !route.legs.every((leg) => leg.cost !== Infinity)) return null;
        const legsCost = route ? route.totalCost : 0;

        let homeCost = 0;
        if (includeHome) {
          if (!priced || priced.cost === null) return null;
          homeCost = priced.cost;
        }
        const cost = legsCost + homeCost;
        return cost > 0 ? { offset, startDate, cost } : null;
      } catch {
        return null;
      }
    }),
  );

  const baselineLegsCost = await baselineLegs;
  // Nothing real to compare: an unpriced leg, or no legs and no home.
  if (baselineLegsCost === null || !(baselineLegsCost > 0 || includeHome)) return undefined;
  const baselineCost = baselineLegsCost + (includeHome ? (baselineHomeCost as number) : 0);

  const valid = shifted.filter(
    (s): s is { offset: number; startDate: string; cost: number } => s !== null,
  );
  if (outcome) outcome.offsetsPriced = valid.length;
  return pickDateShiftOptions(valid, baselineCost);
}

/**
 * Turns priced date-shift candidates into a suggestion with up to 3 options.
 * Pure selection logic, exported for tests. Every option clears BOTH
 * thresholds ($50 and 5% of baseline) so each row shown to the user is a
 * shift that genuinely saves real money — never a rounding artifact.
 */
export function pickDateShiftOptions(
  candidates: Array<{ offset: number; startDate: string; cost: number }>,
  baselineCost: number,
): DateShiftSuggestion | undefined {
  const MIN_SAVINGS_USD = 50;
  const MIN_SAVINGS_PCT = 0.05;
  const MAX_OPTIONS = 3;

  const options: DateShiftOption[] = candidates
    .map((c) => ({
      dayOffset: c.offset,
      newStartDate: c.startDate,
      newTotalCost: Math.round(c.cost * 100) / 100,
      savings: Math.round((baselineCost - c.cost) * 100) / 100,
    }))
    .filter(
      (o) =>
        o.savings >= MIN_SAVINGS_USD && o.savings / baselineCost >= MIN_SAVINGS_PCT,
    )
    .sort((a, b) => b.savings - a.savings)
    .slice(0, MAX_OPTIONS);

  if (options.length === 0) return undefined;
  return { ...options[0], options };
}

/** One hotel stay: a city and the nights the trip spends there. */
type Stay = { city: string; checkin: string; checkout: string };

/** What the date-shift check actually priced (see OptimizeResult.dateShiftChecked). */
export type DateShiftOutcome = { offsetsPriced: number; hadCandidate: boolean; hotelsPriced: boolean };

/**
 * What the trip's hotels cost for these stays, the way the planner will
 * price them: per city, the hotel it auto-selects (`plannerHotelPick`) at its
 * room rate plus Booking's excluded charges, times the nights — the sum the
 * trip total (`effectiveHotel`) is built from. Prices are party totals for
 * every room already. Null when any stay cannot be priced: a city with no
 * hotel would read as a hotel saved.
 *
 * Every stay is searched at once (they are independent), and each with
 * exactly the request PlanningChat sends — city, dates, `adults: travelers`,
 * no rooms (so `roomsFor` decides, as for the planner) and no price cap — so
 * the planned-date searches are the very ones the planner makes next, and it
 * is served them from the 10-minute hotel search cache.
 */
async function hotelStaysCost(stays: Stay[], travelers: number): Promise<number | null> {
  const costs = await Promise.all(
    stays.map(async ({ city, checkin, checkout }) => {
      const pick = plannerHotelPick(await searchHotels({ city, checkin, checkout, adults: travelers }));
      if (!pick) return null;
      const nights = Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86_400_000);
      const taxes = Number.isFinite(pick.taxesPerNight) ? (pick.taxesPerNight as number) : 0;
      const cost = (pick.pricePerNight + taxes) * nights;
      return Number.isFinite(cost) && cost > 0 ? cost : null;
    }),
  );
  if (costs.some((c) => c === null)) return null;
  return (costs as number[]).reduce((sum, c) => sum + c, 0);
}

/**
 * Hold the best transport-only date shift to the whole trip: re-price every
 * hotel stay at the requested dates and at the shifted ones, and offer the
 * shift only if transport + hotels still clears `pickDateShiftOptions`'
 * thresholds against transport + hotels as planned.
 *
 * The probe used to price flights and legs alone, but a shift moves every
 * hotel night — into a weekend, a holiday, a trade fair — so "start a day
 * earlier and save $652" could describe a trip that costs more.
 *
 * Only the BEST candidate is re-priced: each stay is two searches on our
 * RapidAPI quota, and the planned-date half is shared with the planner's own
 * searches through the cache. So only that one shift can be offered, and the
 * runners-up are dropped rather than shown with a transport-only number.
 *
 * Shifted stays are the planned stays moved by the offset — same cities, same
 * nights — which is the trip a "start N days earlier" replan builds. Any
 * failure (a search that comes back empty or throws) means no suggestion: no
 * suggestion is better than a wrong one.
 */
export async function confirmDateShiftWithHotels(
  transport: DateShiftSuggestion,
  stays: Stay[],
  travelers: number,
  outcome?: DateShiftOutcome,
): Promise<DateShiftSuggestion | undefined> {
  const started = Date.now();
  const offset = transport.dayOffset;
  const shiftedStays = stays.map((s) => ({
    city: s.city,
    checkin: addDays(s.checkin, offset),
    checkout: addDays(s.checkout, offset),
  }));
  try {
    const [planned, shifted] = await Promise.all([
      hotelStaysCost(stays, travelers),
      hotelStaysCost(shiftedStays, travelers),
    ]);
    if (planned === null || shifted === null) {
      logger.warn('Date shift not offered — its hotels could not be priced', {
        dayOffset: offset,
        plannedPriced: planned !== null,
        shiftedPriced: shifted !== null,
        ms: Date.now() - started,
      });
      return undefined;
    }
    if (outcome) outcome.hotelsPriced = true;
    const transportBaseline = transport.newTotalCost + transport.savings;
    const result = pickDateShiftOptions(
      [{ offset, startDate: transport.newStartDate, cost: transport.newTotalCost + shifted }],
      transportBaseline + planned,
    );
    logger.info('Date shift checked against hotels', {
      dayOffset: offset,
      transportSavings: transport.savings,
      hotelsPlanned: Math.round(planned * 100) / 100,
      hotelsShifted: Math.round(shifted * 100) / 100,
      offered: result ? result.savings : null,
      ms: Date.now() - started,
    });
    return result;
  } catch (err: any) {
    logger.warn('Date shift not offered — hotel re-pricing failed', { dayOffset: offset, message: err?.message });
    return undefined;
  }
}

/**
 * Each city's stay for the winning ordering: back to back from `startDate`
 * with the per-city nights, the first one starting when the outbound LANDS
 * (firstStayArrival). These are the dates the trip shows and the planner
 * searches hotels for.
 */
function stayDates(
  ordering: string[],
  startDate: string,
  nightsArray: number[],
  outboundLeg: HomeLeg | null | undefined,
): Record<string, { arrival: string; departure: string }> {
  const dates: Record<string, { arrival: string; departure: string }> = {};
  let cursor = startDate;
  ordering.forEach((cityName, i) => {
    const arrival = cursor;
    const departure = addDays(cursor, nightsArray[i] ?? DEFAULT_NIGHTS_PER_CITY);
    dates[cityName] = { arrival, departure };
    cursor = departure;
  });

  const firstCity = ordering[0];
  const landed = outboundLeg?.arriveDate;
  if (firstCity && landed && dates[firstCity]) {
    dates[firstCity] = {
      ...dates[firstCity],
      arrival: firstStayArrival({
        startDate,
        firstDeparture: dates[firstCity].departure,
        landed,
        city: firstCity,
      }),
    };
  }
  return dates;
}

/**
 * Multi-airport flight search for a home leg. Handles both directions:
 *
 *   OUTBOUND (reverse=false):  originAirports[] → tripCity
 *     → fan out across origin airports, search each to the single
 *       destination IATA, merge + pick cheapest.
 *
 *   RETURN   (reverse=true):   tripCity → originAirports[]
 *     → fan out across home airports as destinations, search each from
 *       the single origin (the trip city), merge + pick cheapest.
 *
 * Home legs are always flights (trains don't do transatlantic / home→
 * overseas), so we skip searchTrains entirely here. Returns the cheapest
 * matching flight along with its actual origin + destination IATA so
 * the UI can display "JFK → FCO" correctly.
 */
type HomeFlightOffer = {
  price: number;
  currency: string;
  durationMinutes: number;
  operator: string;
  carrierCode: string;
  departTime: string | null;
  arriveTime: string | null;
  /** YYYY-MM-DD local landing date, or null when Duffel gave no arrival. */
  arriveDate: string | null;
  stops: number;
  bookingUrl: string | null;
  originAirport: string;
  destAirport: string;
};

/**
 * Normalize, dedupe and cap a caller-supplied origin airport list. Every
 * home-leg search goes through this, so the cap holds for /api/optimize
 * and /api/flights/home-legs alike. A field with no airline service
 * (NO_AIRLINE_SERVICE: Boston's Hanscom, Miami's Opa-locka…) is dropped
 * while any other airport remains.
 */
function homeAirportsFor(originAirports: string[]): string[] {
  const codes = new Set<string>();
  for (const raw of originAirports) {
    const iata = raw.trim().toUpperCase();
    if (!iata) continue;
    codes.add(iata);
    if (codes.size >= MAX_HOME_AIRPORTS) break;
  }
  const all = [...codes];
  const airline = all.filter((iata) => !NO_AIRLINE_SERVICE.has(iata));
  return airline.length > 0 ? airline : all;
}

async function searchHomeFlights(ctx: RunContext, params: {
  originAirports: string[];
  tripCity: string;
  date: string;
  travelers: number;
  reverse: boolean;
  /** Max offers to return (sorted cheapest-first). Default 1 (legacy behavior). */
  limit?: number;
}): Promise<HomeFlightOffer[]> {
  const { tripCity, date, travelers, reverse, limit = 1 } = params;
  // Cap the fan-out — one Duffel offer-request per airport, and the array
  // comes straight from the request body.
  const originAirports = homeAirportsFor(params.originAirports);
  if (originAirports.length === 0) return [];

  let cityIata: string;
  try {
    cityIata = await ctx.iata(tripCity);
  } catch {
    return [];
  }

  // One search per home airport, in parallel. Each search's orientation
  // is determined by `reverse`: for outbound the home airport is the
  // origin; for return it's the destination.
  const perAirport = await Promise.all(
    originAirports.map(async (homeAirport) => {
      const origin = reverse ? cityIata : homeAirport;
      const destination = reverse ? homeAirport : cityIata;
      // Home and the trip city share this airport (home Zurich, first stop
      // Interlaken — both ZRH; home London, first stop Oxford — LHR is in
      // LON): there is no flight to search from it.
      if (sameAirportArea(homeAirport, cityIata)) return [];
      try {
        const offers = await ctx.flights({ origin, destination, date, travelers });
        return offers.map((o: any) => ({
          offer: o,
          homeAirport,
        }));
      } catch {
        return [];
      }
    }),
  );
  // One airport's test-airline fare must not undercut another's real one.
  const all = withoutTestAirlineWhenRealOffered(perAirport.flat(), (x: any) => x.offer);
  if (all.length === 0) return [];
  all.sort((a, b) => (a.offer.price ?? Infinity) - (b.offer.price ?? Infinity));

  return all.slice(0, limit).map(({ offer, homeAirport }) => toHomeFlightOffer(offer, homeAirport, cityIata, reverse));
}

/** One home-flight search result as the home card shows it. */
function toHomeFlightOffer(o: any, homeAirport: string, cityIata: string, reverse: boolean): HomeFlightOffer {
  const fmtTime = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const hhmm = iso.split('T')[1]?.slice(0, 5);
    return hhmm ?? null;
  };
  // The DATE half that fmtTime drops. Duffel's timestamps are local wall
  // clock with no offset, so this is the calendar date at that airport —
  // for `arriving_at`, the day the traveller actually lands.
  const fmtDate = (iso: string | null | undefined): string | null => {
    const match = /^(\d{4}-\d{2}-\d{2})T/.exec(iso ?? '');
    return match ? match[1] : null;
  };

  return {
    price: Number(o.price ?? 0),
    currency: o.currency ?? 'USD',
    durationMinutes: Number(o.durationMinutes ?? 0),
    operator: o.carrier ?? '',
    carrierCode: o.carrierCode ?? '',
    departTime: fmtTime(o.departure),
    arriveTime: fmtTime(o.arrival),
    arriveDate: fmtDate(o.arrival),
    stops: Number(o.stops ?? 0),
    bookingUrl: o.bookingUrl ?? null,
    originAirport: reverse ? cityIata : homeAirport,
    destAirport: reverse ? homeAirport : cityIata,
  };
}

/**
 * Home-flight offers for one city and direction from EVERY one of the
 * traveller's airports (homeAirportsFor), one search each, cheapest first —
 * what ranking (the cheapest) and the home card (the top four) read on a 4+
 * city trip. The same searches searchHomeFlights makes for 1-3 cities, so the
 * planner's pre-search during the chat (prewarmHomeFlights) serves both.
 *
 * It used to rank on ONE search per city and direction — the first airport,
 * or on Duffel's live mode the metro code — and search the rest only for the
 * winner. That ranks blind to the other airports: on the gate's live model,
 * pricing every ordering with home flights ranked on the first airport alone
 * picked the exhaustive winner in 38% of 5-city Chicago plans, 5.7% dearer on
 * average and 45% at worst (backend/scripts/opt-speed/results/budget/
 * gate-after.json, exhaustiveRankedOnFirstAirport), and a metro answer can
 * leave an airport out (WAS answered for IAD and DCA, not the cheaper BWI;
 * Duffel, 2026-11-02). Every airport is compared now, for every trip size —
 * the owner's rule (2026-11-27). The cost is 2 × cities × airports searches
 * (30 for 5 cities from New York), which the chat's pre-search moves out of
 * the plan's own time.
 *
 * `leftOut` is always empty; it stays so HomeFares' callers need no change.
 */
type HomeOffers = {
  /** Offers from the airports searched, cheapest first. */
  offers: HomeFlightOffer[];
  /** Their airports not searched (none: every airport is). */
  leftOut: string[];
  /** The trip city's code the searches used. */
  cityIata: string;
};

const NO_HOME_OFFERS: HomeOffers = { offers: [], leftOut: [], cityIata: '' };

async function searchHomeOffers(ctx: RunContext, params: {
  originAirports: string[];
  tripCity: string;
  date: string;
  travelers: number;
  reverse: boolean;
}): Promise<HomeOffers> {
  const { tripCity, date, travelers, reverse } = params;
  const airports = homeAirportsFor(params.originAirports);
  if (airports.length === 0) return NO_HOME_OFFERS;

  let cityIata: string;
  try {
    cityIata = await ctx.iata(tripCity);
  } catch {
    return NO_HOME_OFFERS;
  }
  // As in searchHomeFlights: no flight from an airport the city shares.
  const usable = airports.filter((a) => !sameAirportArea(a, cityIata));
  if (usable.length === 0) return { ...NO_HOME_OFFERS, cityIata };

  const found = (
    await Promise.all(
      usable.map(async (homeAirport) => {
        try {
          const offers = await ctx.flights({
            origin: reverse ? cityIata : homeAirport,
            destination: reverse ? homeAirport : cityIata,
            date,
            travelers,
          });
          return offers.map((offer: any) => ({ offer, homeAirport }));
        } catch {
          return [];
        }
      }),
    )
  ).flat();

  // One airport's test-airline fare must not undercut another's real one.
  const all = withoutTestAirlineWhenRealOffered(found, (x) => x.offer);
  all.sort((a, b) => (a.offer.price ?? Infinity) - (b.offer.price ?? Infinity));
  return {
    offers: all.map(({ offer, homeAirport }) => toHomeFlightOffer(offer, homeAirport, cityIata, reverse)),
    leftOut: [],
    cityIata,
  };
}

/**
 * One run's home flights on a 4+ city trip: searchHomeOffers per city and
 * direction, each asked once. Ranking takes the cheapest of `offers`; the
 * winner's home card takes the top four of `complete`, which adds the
 * airports ranking left out (one search each). `leftOut` says how many that
 * will be, so best-first can keep them inside the plan's search budget.
 */
type HomeFares = {
  offers(city: string, reverse: boolean): Promise<HomeFlightOffer[]>;
  leftOut(city: string, reverse: boolean): Promise<string[]>;
  complete(city: string, reverse: boolean, searchCtx: RunContext): Promise<HomeFlightOffer[]>;
};

function createHomeFares(
  ctx: RunContext,
  originAirports: string[],
  travelers: number,
  dates: { outbound: string; ret: string },
): HomeFares {
  const memo = new Map<string, Promise<HomeOffers>>();
  const get = (city: string, reverse: boolean): Promise<HomeOffers> => {
    const key = `${reverse ? 'return' : 'outbound'}|${city}`;
    let hit = memo.get(key);
    if (!hit) {
      hit = searchHomeOffers(ctx, {
        originAirports,
        tripCity: city,
        date: reverse ? dates.ret : dates.outbound,
        travelers,
        reverse,
      });
      memo.set(key, hit);
    }
    return hit;
  };
  return {
    offers: (city, reverse) => get(city, reverse).then((r) => r.offers),
    leftOut: (city, reverse) => get(city, reverse).then((r) => r.leftOut),
    complete: async (city, reverse, searchCtx) => {
      const r = await get(city, reverse);
      if (r.leftOut.length === 0) return r.offers;
      const date = reverse ? dates.ret : dates.outbound;
      const extra = await Promise.all(
        r.leftOut.map(async (airport) => {
          try {
            const found = await searchCtx.flights({
              origin: reverse ? r.cityIata : airport,
              destination: reverse ? airport : r.cityIata,
              date,
              travelers,
            });
            // A placeholder schedule (testAirline.ts) loses to any offer
            // already found; the merge below can't tell, having no `raw`.
            const real = r.offers.length > 0 ? found.filter((o: any) => !isDuffelTestOffer(o)) : found;
            return real.map((o: any) => toHomeFlightOffer(o, airport, r.cityIata, reverse));
          } catch {
            return [];
          }
        }),
      );
      return withoutTestAirlineWhenRealOffered([...r.offers, ...extra.flat()], (o) => ({
        carrier: o.operator,
        carrierCode: o.carrierCode,
      })).sort((a, b) => a.price - b.price);
    },
  };
}

type HomeEstimate = {
  /** Cheapest fare across the searched home airports; Infinity when none. */
  cost: number;
  /** Home-side airport of that fare (origin outbound, destination on return). */
  homeAirport: string | null;
};

/**
 * Price-only home-leg estimate for permutation scoring: the cheapest fare
 * across EVERY searched home airport (capped at MAX_HOME_AIRPORTS by
 * searchHomeFlights) — the same offer buildHomeLeg will put on the card.
 *
 * It used to search only originAirports[0], on the theory that whichever
 * ordering had the cheapest "JFK → X" was also cheapest from LGA/EWR. It
 * isn't: with JFK → Paris $900 and EWR → Paris $300, the ranking picked
 * Rome-first, then buildHomeLeg found EWR, and listing the same airports
 * as [EWR, JFK] instead flipped the answer — a 22% swing on airport order
 * alone, and a "saved $400" that was really the ranking's own blind spot
 * (harness, 2026-10-29). bestRoute.totalCost also stopped matching the
 * legs on screen.
 *
 * Cost: searchFlights dedupes (origin, destination, date) for 10 minutes,
 * so this is one Duffel search per (home airport, city, date), shared by
 * every ordering — and buildHomeLeg on the winner is then served entirely
 * from that cache instead of searching its airports itself. Net extra
 * searches per run: 2 × (cities − 1) × (airports − 1), e.g. +8 for a
 * 3-city NYC trip (JFK/EWR/LGA), none for one airport. (The original "~60
 * searches for 3 cities" this was guarding against predates that cache.)
 * Used for 1-3 city trips; 4+ cities price home flights through HomeFares,
 * one search per city and direction when the airports share a metro code.
 *
 * `cost` is Infinity — not 0 — when nothing came back (IATA lookup failed,
 * every per-airport search threw, or there simply are no offers), the
 * same way scoreRoute reports an unpriceable inter-city leg. Callers must
 * charge UNAVAILABLE_HOME_LEG_PENALTY for it: the old `?? 0` scored a
 * nonexistent home flight as FREE, so the "cheapest" ordering was often
 * the one whose outbound doesn't exist.
 */
async function estimateHomeLeg(ctx: RunContext, params: {
  originAirports: string[];
  destinationCity: string;
  date: string;
  travelers: number;
  reverse?: boolean;
}): Promise<HomeEstimate> {
  const reverse = params.reverse ?? false;
  const found = await searchHomeFlights(ctx, {
    originAirports: params.originAirports,
    tripCity: params.destinationCity,
    date: params.date,
    travelers: params.travelers,
    reverse,
    limit: 1,
  });
  const best = found[0];
  if (!best) return { cost: Infinity, homeAirport: null };
  return { cost: best.price, homeAirport: reverse ? best.destAirport : best.originAirport };
}

async function estimateHomeLegCost(
  ctx: RunContext,
  params: Parameters<typeof estimateHomeLeg>[1],
): Promise<number> {
  return (await estimateHomeLeg(ctx, params)).cost;
}

/** What a home-flight search for one leg needs (buildHomeLeg, searchHomeLegOptions). */
export type HomeLegSearchParams = {
  originAirports: string[];
  destinationCity: string;
  date: string;
  travelers: number;
  reverse?: boolean;
  /** Home city name — enables a metro-code fallback search when none of
   *  the specific airports return offers (e.g. EWR alone comes back empty
   *  but the NYC metro code has plenty). */
  originCity?: string;
  /**
   * Every city on the trip, so the DESTINATION resolves to the reading this
   * trip means — "Lagos" on a Lisbon + Porto trip is FAO. The metro fallback
   * resolves the home city and never uses it. Used when no run context is
   * passed (/api/flights/home-legs); inside optimize() the run's context
   * already carries the trip.
   */
  tripCityNames?: string[];
};

/**
 * One home leg's offers as HomeLeg rows (no alternatives), cheapest first:
 * the traveller's home airports (homeAirportsFor), one search each, then the
 * home city's metro code when none of them had anything. The one search
 * behind both buildHomeLeg (its top four) and searchHomeLegOptions.
 */
async function homeLegRows(
  params: HomeLegSearchParams,
  ctx: RunContext,
  limit: number,
  known?: Promise<HomeFlightOffer[]>,
): Promise<Array<Omit<HomeLeg, 'alternatives'>>> {
  let offers = known
    ? (await known).slice(0, limit)
    : await searchHomeFlights(ctx, {
        originAirports: params.originAirports,
        tripCity: params.destinationCity,
        date: params.date,
        travelers: params.travelers,
        reverse: params.reverse ?? false,
        limit,
      });

  // Fallback: none of the specific airports had offers — retry with the
  // origin city's metro/primary code, which covers all its airports.
  if (offers.length === 0 && params.originCity) {
    try {
      // The HOME city's code — no trip context (see RunContext.homeIata).
      const metro = await ctx.homeIata(params.originCity);
      // Compare against the capped list — with a longer array the metro
      // code could sit past the cap, i.e. never actually searched.
      if (metro && !homeAirportsFor(params.originAirports).includes(metro.toUpperCase())) {
        offers = await searchHomeFlights(ctx, {
          originAirports: [metro],
          tripCity: params.destinationCity,
          date: params.date,
          travelers: params.travelers,
          reverse: params.reverse ?? false,
          limit,
        });
      }
    } catch {
      // metro lookup failed — fall through to none below.
    }
  }

  return offers.map((o) => ({
    originAirport: o.originAirport,
    destAirport: o.destAirport,
    price: o.price,
    currency: o.currency,
    durationMinutes: o.durationMinutes,
    operator: o.operator,
    carrierCode: o.carrierCode,
    departTime: o.departTime,
    arriveTime: o.arriveTime,
    departDate: params.date,
    // Only when known: the field is optional on the wire, and every reader
    // of a HomeLeg saved before it existed treats absence as "same day".
    ...(o.arriveDate ? { arriveDate: o.arriveDate } : {}),
    stops: o.stops,
    bookingUrl: o.bookingUrl,
  }));
}

/**
 * Rebuild the full HomeLeg for the winning route's outbound/return.
 * Returns null on any failure so the trip still builds — the UI just
 * renders the home card without the detail line.
 */
export async function buildHomeLeg(params: HomeLegSearchParams, ctx: RunContext = createRunContext(params.tripCityNames ?? []),
/**
 * The offers ranking already found for this leg (optimize() on 4+ cities —
 * see HomeFares), used instead of searching the airports again.
 */
known?: Promise<HomeFlightOffer[]>): Promise<HomeLeg | null> {
  // Pull top 4 — first becomes the main leg, rest go into alternatives
  // so the user can swap to another carrier/time without a new search.
  const rows = await homeLegRows(params, ctx, 4, known);
  if (rows.length === 0) return null;
  const [main, ...rest] = rows;
  return {
    ...main,
    alternatives: rest.length > 0 ? rest : undefined,
  };
}

/**
 * Every home-flight option for one leg, cheapest first (up to `limit`), from
 * the same home airports, per-airport fan-out and metro fallback that price
 * the trip's home flights (buildHomeLeg is the top four of this). The AI
 * chat filters these for "a later flight home", "evening flights out", "a
 * cheaper one" (services/tripLegs.ts).
 */
export async function searchHomeLegOptions(
  params: HomeLegSearchParams,
  limit = 40,
): Promise<Array<Omit<HomeLeg, 'alternatives'>>> {
  return homeLegRows(params, createRunContext(params.tripCityNames ?? []), limit);
}

/**
 * The day the first stay starts: the day the outbound LANDS, not the day it
 * leaves. An evening flight to Europe arrives the next morning: JFK 19:25
 * Dec 8 → Paris 12:00 Dec 9 used to put Paris's arrival on Dec 8, so the
 * hotel search checked in on Dec 8 (a $362-405 night spent on the plane on
 * the owner's trip) and the schedule planned a Paris lunch and evening while
 * the traveller was still at JFK.
 *
 * Decided default (owner can override): the trip's return date and every
 * inter-city leg date stay as priced; city 0 simply gets fewer nights.
 * Clamped to keep it at least ONE night: a 0-night stay would send the hotel
 * search checkin === checkout and break every reader that assumes arrival <
 * departure. In that narrow case (city 0 had a single night, or the flight
 * lands 2+ days later and eats all of them) the stay keeps its last night,
 * which can still overlap the flight — the price of keeping every priced leg
 * date and the return date as they are. A landing before the start date
 * (westbound over the date line) keeps the start date. No landing date
 * (Duffel gave no arrival) keeps the start date.
 *
 * The ONE copy of this rule: optimize() applies it to the trips it builds,
 * and /api/flights/home-legs to the ones it does not (Browse presets), so a
 * saved preset and a planned trip agree on when the first stay starts.
 *
 * `startDate` is the day the outbound leaves (city 0's arrival before this
 * rule), `firstDeparture` city 0's departure; all YYYY-MM-DD.
 */
export function firstStayArrival(params: {
  startDate: string;
  firstDeparture: string;
  landed: string | null | undefined;
  /** For the log line only. */
  city?: string;
}): string {
  const { startDate, firstDeparture, landed } = params;
  if (!landed) return startDate;
  const latestArrival = addDays(firstDeparture, -1);
  if (landed > latestArrival) {
    logger.warn('Outbound lands too late to give the first city a full night', {
      city: params.city,
      landed,
      departure: firstDeparture,
    });
  }
  const arrival = landed < startDate ? startDate : landed > latestArrival ? latestArrival : landed;
  // max(startDate, …) as well: latestArrival can only fall before the start
  // date if city 0 had zero nights, which the request schemas reject.
  return arrival < startDate ? startDate : arrival;
}

/**
 * Step 2 of optimize(): the candidate orderings. Full permutations for up to
 * 5 cities (the first city fixed when there is no home), filtered to the
 * country-clustered ones; countryGroupedOrderings beyond that.
 */
function candidateOrderings(cities: CityInput[], hasOrigin: boolean, cityMap: Map<string, CityInput>): string[][] {
  // When we have a real origin, "first city" is no longer a hack —
  // it's just whatever destination is closest/cheapest after flying in
  // from home. So we test FULL permutations of all destinations (no
  // fixed-first). When there's no origin, we keep the legacy behavior
  // (first city fixed) so existing behavior is preserved.
  if (cities.length > 5) {
    // Too many cities to permute — score a few orderings that are
    // country-clustered by construction and let real leg prices pick.
    return countryGroupedOrderings(cities);
  }
  let orderings: string[][];
  if (hasOrigin) {
    // Full permutations of all N destinations.
    orderings = getPermutations(cities).map((p) => p.map((c) => c.name));
  } else {
    const rest = cities.slice(1);
    const perms = getPermutations(rest);
    orderings = perms.map((p) => [cities[0].name, ...p.map((c) => c.name)]);
  }

  // Apply the country-clustering filter: reject any ordering that bounces
  // between countries (e.g. JP → CN → JP → CN). Only keep clustered ones.
  const clustered = orderings.filter((o) => isCountryClustered(o, cityMap));
  if (clustered.length > 0) return clustered;
  logger.warn('Country clustering filter removed all orderings — falling back');
  return orderings;
}

/**
 * The two-phase FIRST answer (OptimizeParams.onFirstAnswer): the trip exactly
 * as ranking priced it, with nothing searched that ranking had not:
 *  - the winner's legs from ranking — flights on their own days, trains from
 *    the rail board's snapshot (the ranking day's). One exception: a leg
 *    FLOWN on the ranking day whose pair answered after the snapshot takes
 *    that answer now — it is that day's real train ("fills the leg when it
 *    arrives").
 *  - home flights from the searches ranking made (flights.ts' cache on 1-3
 *    cities; HomeFares' ranking offers on 4+ — the other airports follow in
 *    the full answer).
 *  - no leg alternatives and no date-shift check (dateShiftChecked: false).
 * A deep copy: the full answer keeps working on the same objects.
 * Null when every flight search failed (the full answer reports the outage).
 */
async function firstAnswer(args: {
  ranked: ScoredRoute[];
  savingsVsNaive: number;
  iataCodes: Record<string, string>;
  originClarification?: OriginClarification;
  ctx: RunContext;
  railBoard: RailBoard;
  rankingTrainDay: string;
  startDate: string;
  travelers: number;
  cityMap: Map<string, CityInput>;
  nights: number[];
  home: null | {
    originAirports: string[];
    origin?: string;
    returnToHome: boolean;
    outboundDate: string;
    returnDate: string;
    known: null | { outbound: Promise<HomeFlightOffer[]>; ret: Promise<HomeFlightOffer[]> };
  };
}): Promise<OptimizeResult | null> {
  const { ranked, ctx, railBoard, startDate, travelers, cityMap, nights } = args;
  const winner = ranked[0];
  const ordering = winner.ordering;

  const legs = await Promise.all(
    winner.legs.map(async (leg, i): Promise<OptimizedLeg> => {
      const date = legDateAt(startDate, nights, i);
      if (date !== args.rankingTrainDay || railBoard.snapshotHad(leg.from, leg.to)) return leg;
      const late = railBoard.answerNow(leg.from, leg.to);
      if (!late || late.length === 0) return leg;
      const comparison = await compareLeg(legCompareParams(leg.from, leg.to, date, travelers, cityMap, ctx), {
        getIataCode: ctx.iata,
        searchFlights: ctx.flights,
        searchTrains: () => Promise.resolve(late),
      });
      return { from: leg.from, to: leg.to, comparison, cost: legCost(comparison) };
    }),
  );
  const sum = (list: OptimizedLeg[], unpriced: number) =>
    list.reduce((s, l) => s + (l.cost === Infinity ? unpriced : l.cost), 0);
  const gaps = (list: OptimizedLeg[]) => list.filter((l) => l.cost === Infinity).length;
  const route: ScoredRoute = {
    ...winner,
    legs,
    totalCost: winner.totalCost - sum(winner.legs, 0) + sum(legs, 0),
    rankCost: winner.rankCost - sum(winner.legs, UNAVAILABLE_LEG_PENALTY) + sum(legs, UNAVAILABLE_LEG_PENALTY),
    unpricedLegs: winner.unpricedLegs - gaps(winner.legs) + gaps(legs),
  };

  let outboundLeg: HomeLeg | null = null;
  let returnLeg: HomeLeg | null = null;
  if (args.home) {
    const h = args.home;
    [outboundLeg, returnLeg] = await Promise.all([
      buildHomeLeg(
        { originAirports: h.originAirports, destinationCity: ordering[0], date: h.outboundDate, travelers, originCity: h.origin },
        ctx,
        h.known?.outbound,
      ),
      h.returnToHome
        ? buildHomeLeg(
            {
              originAirports: h.originAirports,
              destinationCity: ordering[ordering.length - 1],
              date: h.returnDate,
              travelers,
              reverse: true,
              originCity: h.origin,
            },
            ctx,
            h.known?.ret,
          )
        : Promise.resolve(null),
    ]);
  }

  const { answered, threw } = ctx.flightOutcomes;
  if (answered === 0 && threw > 0 && route.legs.every((l) => l.cost === Infinity) && !outboundLeg && !returnLeg) {
    return null;
  }

  const routes = [route, ...ranked.slice(1)].map(toPublicRoute);
  return structuredClone({
    routes,
    bestRoute: routes[0],
    savingsVsNaive: args.savingsVsNaive,
    iataCodes: args.iataCodes,
    dates: stayDates(ordering, startDate, nights, outboundLeg),
    dateShiftChecked: false,
    outboundLeg,
    returnLeg,
    ...(args.originClarification ? { originClarification: args.originClarification } : {}),
    provisional: true,
  });
}

/** Exposed for tests. */
export const _railForTests = { createRailBoard, createRunRail, RAIL_RANKING_WAIT_MS };

/** Every ordered city pair flown in some ordering (and the typed order), once. */
function adjacentPairs(orderings: string[][]): Array<[string, string]> {
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const o of orderings) {
    for (let i = 0; i < o.length - 1; i++) {
      const k = `${o[i]}\u0000${o[i + 1]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push([o[i], o[i + 1]]);
    }
  }
  return pairs;
}

/**
 * Per-city nights, by position in the typed order, and the trip's total —
 * the one rule optimize() and prewarmHomeFlights share, so the pre-searched
 * return date is the one the plan asks for. With `cityNights` each city
 * brings its own nights (nightsByCity); otherwise they are spread evenly.
 */
function tripNights(
  cities: CityInput[],
  totalNights: number | undefined,
  cityNights: Record<string, number> | undefined,
): { nightsByCity: Map<string, number> | null; nightsArray: number[]; totalNightsResolved: number } {
  const nightsByCity = cityNightsByName(cityNights, cities, totalNights);
  const nightsArray = nightsByCity
    ? cities.map((c) => nightsByCity.get(c.name.trim().toLowerCase())!)
    : distributeNights(totalNights, cities.length);
  return { nightsByCity, nightsArray, totalNightsResolved: nightsArray.reduce((sum, n) => sum + n, 0) };
}

/**
 * The traveller's home airports, as optimize() prices them (before
 * homeAirportsFor caps and filters them), and the name's own resolution.
 *
 * The caller's list wins when it gave one: the frontend fills it from
 * frontend/lib/locationResolver.ts, a second implementation reading the
 * browser hot set, held to resolveOriginAirports' no-context answer by
 * originAirportsBrowserParity.test.ts. Otherwise the name is resolved with
 * the destinations as context (a trip through Florence and Venice says which
 * Rome is home), and failing that the home city's own airport code.
 *
 * The NAME is resolved unconditionally: whether it was ambiguous is a fact
 * about what the traveller typed, and optimize() reports it as
 * `originClarification` even when the caller chose the airports. An
 * in-memory artifact lookup — no network, no Duffel.
 */
async function homeAirportList(args: {
  origin: string;
  originAirports?: string[];
  cityNames: string[];
  homeIata: (cityName: string) => Promise<string>;
}): Promise<{ airports: string[]; resolution: ReturnType<typeof resolveOriginAirports> }> {
  const resolution = resolveOriginAirports(args.origin, { tripDestinationNames: args.cityNames });
  if (args.originAirports && args.originAirports.length > 0) return { airports: args.originAirports, resolution };
  if (resolution.airports.length > 0) return { airports: resolution.airports, resolution };
  try {
    // The HOME city — no trip context (see RunContext.homeIata).
    return { airports: [await args.homeIata(args.origin)], resolution };
  } catch {
    logger.warn('Could not resolve origin IATA', { origin: args.origin });
    return { airports: [], resolution };
  }
}

/** What the planner knows once it has asked "How many people?" (see prewarmHomeFlights). */
export type PrewarmParams = Pick<
  OptimizeParams,
  'cities' | 'startDate' | 'travelers' | 'origin' | 'originAirports' | 'returnToHome' | 'totalNights' | 'cityNights'
>;

export type PrewarmOutcome = {
  /** Home-flight searches asked for (those already in flights.ts' cache cost nothing). */
  searches: number;
  /** True when the same trip was pre-searched within PREWARM_TTL_MS: nothing was asked. */
  deduped: boolean;
};

/** flights.ts keeps a search 10 minutes; a repeat inside that finds them all there. */
const PREWARM_TTL_MS = 10 * 60 * 1000;
const prewarmed = new Map<string, number>();

/**
 * Search, during the planner chat, the home flights the plan will need:
 * every city, both directions, from every one of the traveller's airports —
 * exactly the searches optimize() makes for them (searchHomeFlights on 1-3
 * cities, searchHomeOffers on 4-5), with the same airports, city codes,
 * dates and party, so flights.ts' cache answers optimize() from them.
 *
 * Why it can: home flights depend only on which city is first or last, the
 * two travel days and the party — not on the order of the cities — and the
 * planner knows all of those after "How many people?", while budget and
 * notes are still to come. Why it matters: ranking compares every home
 * airport (searchHomeOffers), 2 × cities × airports searches — 30 for 5
 * cities from New York, a whole Duffel window — which no longer sit in the
 * plan's own time.
 *
 * Fire-and-forget for the caller (POST /api/optimize/prewarm answers at
 * once). A repeat of the same trip within PREWARM_TTL_MS asks nothing; a
 * search that fails is simply searched again by optimize().
 */
export async function prewarmHomeFlights(params: PrewarmParams): Promise<PrewarmOutcome> {
  const { cities, startDate, travelers, origin, originAirports, returnToHome = true, totalNights, cityNights } = params;
  if (!origin || !origin.trim() || cities.length === 0) return { searches: 0, deduped: false };
  const cityNames = cities.map((c) => c.name);
  const { totalNightsResolved } = tripNights(cities, totalNights, cityNights);
  const outboundDate = clampToFuture(startDate);
  const returnDate = clampToFuture(addDays(startDate, totalNightsResolved));
  const ctx = createRunContext(cityNames);
  const home = await homeAirportList({ origin, originAirports, cityNames, homeIata: ctx.homeIata });
  const airports = homeAirportsFor(home.airports);
  if (airports.length === 0) return { searches: 0, deduped: false };

  const key = JSON.stringify([airports, cityNames, outboundDate, returnToHome ? returnDate : null, travelers]);
  const now = Date.now();
  for (const [k, at] of prewarmed) if (now - at > PREWARM_TTL_MS) prewarmed.delete(k);
  if (prewarmed.has(key)) return { searches: 0, deduped: true };
  prewarmed.set(key, now);

  const started = Date.now();
  const searches: Array<Promise<unknown>> = [];
  await Promise.all(
    cityNames.map(async (city) => {
      let cityIata: string;
      try {
        cityIata = await ctx.iata(city);
      } catch {
        return; // optimize() will not price it either
      }
      for (const airport of airports) {
        if (sameAirportArea(airport, cityIata)) continue;
        searches.push(searchFlights({ origin: airport, destination: cityIata, date: outboundDate, travelers }).catch(() => []));
        if (returnToHome) {
          searches.push(searchFlights({ origin: cityIata, destination: airport, date: returnDate, travelers }).catch(() => []));
        }
      }
    }),
  );
  await Promise.all(searches);
  logger.info('Optimize prewarm', { cities: cities.length, airports: airports.length, searches: searches.length, ms: Date.now() - started });
  return { searches: searches.length, deduped: false };
}

/** Tests only. */
export function _resetPrewarm(): void {
  prewarmed.clear();
}

export async function optimize(params: OptimizeParams): Promise<OptimizeResult> {
  const { cities, startDate, travelers, origin, originAirports, returnToHome = true, totalNights, cityNights, onProgress, onFirstAnswer } = params;
  const runStarted = Date.now();
  /**
   * The work after the ranking — the winner's trains on their real days, its
   * leg alternatives, the date-shift probe — searches ONCE more a route-day
   * whose first answer had no priced train (RunRail.retry). A cold All Aboard
   * route often answers the second time (T1, 2026-11-24: Paris → Berlin,
   * $87.70 for two, found only by the retry), and a train the plan used to
   * find must still be found. OPT_RAIL_RETRY=0 turns it off, for the
   * benchmark (backend/scripts/opt-bench) only.
   */
  const retryRailAfterRanking = process.env.OPT_RAIL_RETRY !== '0';
  /**
   * Ranking's rail is the full search. The lighter one (B2: direct trains, 2
   * fares per pair — searchTrains' `quick`) answers its timetable in 1-3 s,
   * but its fares take 9-23 s, so none was priced inside the 8 s ranking cap
   * (T1 0 of 6 searches, T2 0 of 19, live 2026-11-27): it changed no answer and no
   * time, and cost twice the All Aboard searches and fares.
   * OPT_RANKING_RAIL=quick turns it on, for the benchmark only.
   */
  const quickRankingRail = process.env.OPT_RANKING_RAIL === 'quick';

  if (cities.length < 1) {
    throw new Error('Need at least 1 city to optimize');
  }

  const hasOrigin = !!origin && origin.trim().length > 0;

  // Distribute the user's total nights across cities (or fall back to
  // 2 per city if they didn't specify). Computed once and threaded
  // through scoreRoute, the date assignment loop, and home-leg date
  // calculations so all three see the same per-city schedule.
  //
  // With `cityNights` each city brings its own nights wherever it lands in
  // an ordering, so the per-position array depends on the ordering:
  // `nightsFor(ordering)`. Without it, every ordering shares one positional
  // array, exactly as before. `nightsArray` is the typed order's.
  const { nightsByCity, nightsArray, totalNightsResolved } = tripNights(cities, totalNights, cityNights);
  if (cityNights && !nightsByCity) {
    logger.warn('cityNights ignored: it does not name every city once, or disagrees with totalNights', {
      cities: cities.length,
      given: Object.keys(cityNights).length,
    });
  }
  const nightsFor = (ordering: string[]): number[] =>
    nightsByCity
      ? ordering.map((c) => nightsByCity.get(c.trim().toLowerCase()) ?? DEFAULT_NIGHTS_PER_CITY)
      : nightsArray;

  // Single-city trips are valid when origin is set (vibe-first flows
  // typically produce one destination, e.g. "Reykjavik for adventure").
  // Without origin, a 1-city trip has no transport to optimize at all,
  // so reject that combination rather than return a degenerate result.
  if (cities.length < 2 && !hasOrigin) {
    throw new Error('Need at least 2 cities, or 1 city with an origin set');
  }

  // One memo of airport codes and leg prices for this whole run (B8), every
  // lookup made with the trip's city names as context.
  //
  // Ranking searches every leg's trains on ONE day, the trip's first travel
  // day (CompareLegDeps.trainDate): All Aboard charges ~11 of its 500 hourly
  // timetable units per new route-and-day, and an ordering puts the same city
  // pair on a different day — a 3-city trip priced 6 pairs on 12 days. Rail
  // fares barely move between neighbouring days, which is all ranking needs;
  // the winner is re-priced on its real days below (exactRoute).
  const rankingTrainDay = legDateAt(startDate, nightsArray, 0);
  const runCtx = createRunContext(cities.map((c) => c.name), onProgress);
  const cityMap = new Map(cities.map((c) => [c.name, c]));

  // Step 2 (first, because the rail board needs it): candidate orderings.
  const orderings = candidateOrderings(cities, hasOrigin, cityMap);

  // Every city pair's trains, searched now, once, on the ranking day — before
  // any flight — so ranking's wait for rail (every pair's first answer,
  // RAIL_RANKING_WAIT_MS) runs alongside its flight searches. Ranking reads
  // trains only from the board; the winner is re-priced on its real days below.
  const envRailWait = Number(process.env.OPT_RAIL_WAIT_MS);
  const railBoard = createRailBoard({
    pairs: adjacentPairs([...orderings, cities.map((c) => c.name)]),
    day: rankingTrainDay,
    travelers,
    countryOf: (name) => cityMap.get(name)?.country ?? getCityCountry(name),
    waitMs: params.railWaitMs ?? (envRailWait > 0 ? envRailWait : RAIL_RANKING_WAIT_MS),
    // The full search, unless the benchmark asks for the lighter one (see
    // quickRankingRail). The winner's legs are searched on their real days below.
    search: quickRankingRail ? runCtx.rail.quick : runCtx.rail.search,
  });
  const ctx = runCtx.withTrainDate(() => rankingTrainDay).withTrainSource(railBoard.source);

  // The winner's FIRST leg is flown on the ranking day, whichever ordering
  // wins, so every pair's one retry on that day (when its first answer has no
  // priced train, RunRail.retry) is work the plan would otherwise start only
  // after ranking: start each as soon as its first answer is in, into the
  // run's rail memo, where the winner's legs and their alternatives find it.
  // A repeat search of a fetched route-day costs no timetable quota
  // (measured 2026-11-27). With the lighter ranking search (benchmark) this
  // also starts each pair's full search.
  {
    const countryOfCity = (name: string) => cityMap.get(name)?.country ?? getCityCountry(name);
    for (const [from, to] of adjacentPairs([...orderings, cities.map((c) => c.name)])) {
      const full: SearchTrainsParams = {
        origin: from,
        destination: to,
        date: rankingTrainDay,
        travelers,
        originCountry: countryOfCity(from),
        destinationCountry: countryOfCity(to),
      };
      void (retryRailAfterRanking ? runCtx.rail.retry(full) : runCtx.rail.search(full));
    }
  }

  // Step 1: resolve IATA codes in parallel
  const iataCodes: Record<string, string> = {};
  await Promise.all(
    cities.map(async (city) => {
      try {
        iataCodes[city.name] = await ctx.iata(city.name);
      } catch {
        logger.warn('Could not resolve IATA for', { city: city.name });
      }
    }),
  );

  // Resolve origin airports: the caller may pass an explicit list (from the
  // frontend's own lookup or user prefs); otherwise resolve the name, and
  // fall back to a single getIataCode result if nothing matched.
  //
  // Resolution happens HERE, at the top, before any paid call. An optimize
  // run cannot stop to ask a question once it is spending money on Duffel,
  // so an ambiguous origin is priced from its best reading and the question
  // is carried out on the result as `originClarification` instead.
  let resolvedOriginAirports: string[] = [];
  let originClarification: OriginClarification | undefined;
  if (hasOrigin) {
    const home = await homeAirportList({
      origin: origin!,
      originAirports,
      cityNames: cities.map((c) => c.name),
      homeIata: ctx.homeIata,
    });
    resolvedOriginAirports = home.airports;
    // Whether the name was ambiguous is a fact about what the traveller
    // typed, not about which airports we ended up pricing (homeAirportList).
    if (home.resolution.needsClarification) {
      originClarification = {
        input: origin!,
        reason: home.resolution.needsClarification.reason,
        candidates: home.resolution.needsClarification.candidates,
      };
    }
  }

  // Step 2 (candidate orderings) ran above, before the rail board.

  // Step 3: score each permutation.
  //
  // When we have an origin, each permutation's total cost must include
  // the home→first_city outbound leg. We compute that lazily per
  // candidate below (it depends on which city ends up first, so it's
  // different across permutations). The return leg (last_city→home) is
  // added similarly when returnToHome=true.
  //
  // Kept in one closure because Step 5's naive baseline has to be priced
  // EXACTLY the same way — same nights, same dates, same home legs — or
  // the subtraction that produces savingsVsNaive compares two different
  // things.
  //
  // Home flights on 4+ city trips go through `homeFares`: each city and
  // direction ranked on one search — the first home airport, or on Duffel's
  // live mode the metro code when the home airports share one (ORD + MDW →
  // CHI) — and the winner's home cards built from the same answers plus its
  // other airports. 1-3 city trips price them exactly as before.
  onProgress?.({ stage: 'routes', orderings: orderings.length });

  const homeKnown = hasOrigin && resolvedOriginAirports.length > 0;
  const outboundDate = clampToFuture(startDate);
  const returnDate = clampToFuture(addDays(startDate, totalNightsResolved));
  const homeFares: HomeFares | null =
    homeKnown && cities.length >= 4
      ? createHomeFares(
          ctx.phased('home'),
          resolvedOriginAirports,
          travelers,
          { outbound: outboundDate, ret: returnDate },
        )
      : null;
  const homeLegCost = (city: string, reverse: boolean): Promise<number> =>
    homeFares
      ? homeFares.offers(city, reverse).then((offers) => offers[0]?.price ?? Infinity)
      : estimateHomeLegCost(ctx, {
          originAirports: resolvedOriginAirports,
          destinationCity: city,
          date: reverse ? returnDate : outboundDate,
          travelers,
          ...(reverse ? { reverse: true } : {}),
        });

  const scoreOrderingWithHomeLegs = async (ordering: string[]): Promise<ScoredRoute> => {
    const basePromise = scoreRoute(ordering, startDate, travelers, cityMap, nightsFor(ordering), ctx);
    if (!homeKnown) return basePromise;

    // The inter-city legs and both home legs are independent searches, so
    // they run together. They used to run legs → outbound → return, which
    // put two Duffel round trips (~1.5-1.9s each) after the slowest leg of
    // every ordering.
    const lastIdx = ordering.length - 1;
    const [baseRoute, ...homeCosts] = await Promise.all([
      basePromise,
      // Outbound leg: home → first destination, on the trip's start date.
      homeLegCost(ordering[0], false),
      // Return leg: last destination → home. Uses the departure date of
      // the last city (when they'd be leaving it to go home).
      ...(returnToHome ? [homeLegCost(ordering[lastIdx], true)] : []),
    ]);

    // Same money/ranking split as scoreRoute. A home leg we couldn't price
    // used to add 0 to the total, so an ordering whose outbound doesn't
    // exist looked hundreds of dollars cheaper than one whose outbound
    // does, won the sort, and then buildHomeLeg returned null for it — the
    // user got a "search failed" outbound card and a total missing an
    // entire airfare.
    let totalCost = baseRoute.totalCost;
    let rankCost = baseRoute.rankCost;
    let unpricedLegs = baseRoute.unpricedLegs;
    for (const cost of homeCosts) {
      if (cost === Infinity) {
        rankCost += UNAVAILABLE_HOME_LEG_PENALTY;
        unpricedLegs++;
      } else {
        totalCost += cost;
        rankCost += cost;
      }
    }

    return { ...baseRoute, totalCost, rankCost, unpricedLegs };
  };

  const naiveOrdering = cities.map((c) => c.name);
  const naiveKey = naiveOrdering.join('|');

  // 4-5 cities with a home: the adaptive screen (rankByAdaptiveScreen) finds
  // the winner scoring every permutation would, in at most
  // PLAN_SEARCH_BUDGET searches (5 cities from Chicago: ≤ 42 instead of
  // 100). Everything else scores every candidate, as before.
  const adaptive = hasOrigin && cities.length >= 4 && cities.length <= 5;
  let routes: ScoredRoute[];
  let screenStats: { rounds: number; budgetStop: boolean; reserved: number } | undefined;
  if (adaptive) {
    const lastIdx = cities.length - 1;
    // Searches the winner's home flights will still send (its first and last
    // cities' airports ranking left out — HomeFares.complete), kept out of
    // best-first's share of PLAN_SEARCH_BUDGET. The winner is not known yet,
    // so: the most any first city needs plus the most any last city needs.
    let reserved = 0;
    // Home flights for every city that can start or end the trip (and the
    // typed order's ends, which savingsVsNaive prices), searched up front.
    const homeCosts = (async () => {
      if (!homeKnown) return () => [];
      const firstCities = [...new Set([naiveOrdering[0], ...orderings.map((o) => o[0])])];
      const lastCities = returnToHome ? [...new Set([naiveOrdering[lastIdx], ...orderings.map((o) => o[lastIdx])])] : [];
      const penalised = (cost: number) => (cost === Infinity ? UNAVAILABLE_HOME_LEG_PENALTY : cost);
      const [outbound, back] = await Promise.all([
        Promise.all(firstCities.map(async (c) => [c, penalised(await homeLegCost(c, false))] as const)),
        Promise.all(lastCities.map(async (c) => [c, penalised(await homeLegCost(c, true))] as const)),
      ]);
      if (homeFares) {
        const most = async (list: string[], reverse: boolean) =>
          Math.max(0, ...(await Promise.all(list.map((c) => homeFares.leftOut(c, reverse)))).map((l) => l.length));
        const candidateFirsts = [...new Set(orderings.map((o) => o[0]))];
        const candidateLasts = returnToHome ? [...new Set(orderings.map((o) => o[lastIdx]))] : [];
        reserved = (await most(candidateFirsts, false)) + (await most(candidateLasts, true));
      }
      const out = new Map(outbound);
      const ret = new Map(back);
      return (o: string[]) => [out.get(o[0])!, ...(returnToHome ? [ret.get(o[lastIdx])!] : [])];
    })();
    // The screen dates each leg by its position. With per-city nights that
    // is the typed order's dates, close for the others; the orderings it
    // keeps are then scored on their own dates (scoreOrderingWithHomeLegs).
    const screen = await rankByAdaptiveScreen({
      orderings,
      typed: naiveOrdering,
      legDate: (i) => legDateAt(startDate, nightsArray, i),
      priceLeg: (from, to, i, phase) =>
        ctx
          .phased(phase)
          .compare(legCompareParams(from, to, legDateAt(startDate, nightsArray, i), travelers, cityMap, ctx))
          .then(legCost),
      homeCosts,
      // Read before each round, when every search sent so far is in the ledger.
      budget: { remaining: () => PLAN_SEARCH_BUDGET - interCitySearches(ctx) - reserved },
    });
    screenStats = { rounds: screen.rounds, budgetStop: screen.budgetStop, reserved };
    // Every leg and home flight of these is priced already: no new searches.
    routes = await Promise.all(screen.ranked.map((ordering) => scoreOrderingWithHomeLegs(ordering)));
  } else {
    routes = await Promise.all(orderings.map((ordering) => scoreOrderingWithHomeLegs(ordering)));
  }

  // Step 4: sort by rankCost (real prices plus a penalty for any leg that
  // came back empty), keep top 3. Sorting on totalCost let a missing leg,
  // priced at $0, win.
  //
  // The adaptive screen returns only the routes it PROVED best — usually just
  // the winner, sometimes two or three — rather than buying the exact prices
  // of a second and third ordering nobody reads: the frontend builds the trip
  // from bestRoute alone (PlanningChat buildTripFromOptimize), and `routes`
  // is only carried through the API response.
  routes.sort((a, b) => a.rankCost - b.rankCost);
  const topRoutes = routes.slice(0, 3);

  // Step 5: compute savings vs naive (user's original ordering).
  //
  // The naive ordering is normally one of the candidates we just scored,
  // so reuse that result rather than re-pricing it. The old re-score
  // called scoreRoute with no nightsArray and no home legs, so on every
  // trip with an origin it compared a legs-only naive total against a best
  // total that included two airfares: the difference was negative,
  // Math.max clamped it, and savingsVsNaive was $0 for every such trip.
  // (After the adaptive screen it is priced already, typed legs and home
  // flights both, so this re-score searches nothing.)
  const naiveRoute =
    routes.find((r) => r.ordering.join('|') === naiveKey) ??
    (await scoreOrderingWithHomeLegs(naiveOrdering));
  // Money, not rankCost, on both sides — and only when BOTH routes are fully
  // priced. An unpriced leg is $0 in totalCost, so a subtraction across two
  // routes with different gaps compares different sets of legs: the winner
  // that dropped a $600 outbound "saved $480" against a naive route that
  // kept it (NYC → Zurich, Interlaken, Geneva, harness 2026-10-29). With a
  // gap on either side the honest saving is unknown, and unknown is $0.
  const bothFullyPriced = naiveRoute.unpricedLegs === 0 && topRoutes[0].unpricedLegs === 0;
  const savingsVsNaive = bothFullyPriced
    ? Math.max(0, naiveRoute.totalCost - topRoutes[0].totalCost)
    : 0;

  const bestOrdering = topRoutes[0].ordering;
  onProgress?.({ stage: 'finishing', bestOrder: bestOrdering });
  const rankingMs = Date.now() - runStarted;

  // Two-phase (OptimizeParams.onFirstAnswer): the trip as ranking priced it,
  // now; everything below finishes it.
  let firstAnswerMs: number | null = null;
  if (onFirstAnswer) {
    const first = await firstAnswer({
      ranked: topRoutes,
      savingsVsNaive,
      iataCodes,
      originClarification,
      ctx,
      railBoard,
      rankingTrainDay,
      startDate,
      travelers,
      cityMap,
      nights: nightsFor(bestOrdering),
      home: homeKnown
        ? {
            originAirports: resolvedOriginAirports,
            origin,
            returnToHome,
            outboundDate,
            returnDate,
            known: homeFares
              ? {
                  outbound: homeFares.offers(bestOrdering[0], false),
                  ret: homeFares.offers(bestOrdering[bestOrdering.length - 1], true),
                }
              : null,
          }
        : null,
    }).catch((err: any) => {
      logger.warn('Optimize first answer failed — the full answer still follows', { errMessage: err?.message });
      return null;
    });
    if (first) {
      firstAnswerMs = Date.now() - runStarted;
      onFirstAnswer(first);
    }
  }

  // Step 7: date-shift suggestion — probe a few ±1/±2 day offsets on the
  // winning ordering to see if leaving earlier/later saves meaningful money.
  // Runs in parallel; any failures silently skip this feature. Its new
  // searches go through `probeGate`, so that once the plan stops waiting
  // for it (DATE_SHIFT_GRACE_SHORT_TRIP_MS) the ones not yet sent never are.
  // Not started at all on 4+ cities (DATE_SHIFT_MAX_CITIES): no suggestion,
  // dateShiftChecked: false.
  //
  // Started here, as soon as ranking has picked the ordering: its searches
  // need only the ordering and the dates. Its baseline — the winner's legs on
  // their real days, below — follows (`probeBaseline`). It used to start
  // after them, and its Duffel searches were the last ~6 s of a 3-city plan.
  // Only when ranking priced every leg, though: then the real days price
  // them all too (a leg they can't price keeps its ranking answer, below).
  // A leg ranking left unpriced may still be priced on its real day, so that
  // probe waits for the baseline, as before — and is not started at all if
  // the gap stays (T4, Lisbon > Sintra: 8 Duffel searches for nothing).
  const rankedWinner = topRoutes[0];
  const dateShiftOutcome: DateShiftOutcome = { offsetsPriced: 0, hadCandidate: false, hotelsPriced: false };
  const probesDates = cities.length <= DATE_SHIFT_MAX_CITIES;
  const probeGate = createProbeGate(Infinity);
  const probeCtx = probeContext(ctx.phased('probe'), probeGate, undefined, retryRailAfterRanking ? ctx.rail.retry : ctx.rail.search);
  let settleProbeBaseline: (legsCost: number | null) => void = () => undefined;
  // The winner's inter-city legs at the requested dates, or null when one is
  // unpriced (its $0 would read as a saving): set once they are re-priced.
  const probeBaseline = new Promise<number | null>((resolve) => {
    settleProbeBaseline = resolve;
  });
  const dateShiftTransportTask = (async (): Promise<DateShiftSuggestion | undefined> => {
    if (!probesDates) return undefined;
    try {
      const home: DateShiftHome | null =
        hasOrigin && resolvedOriginAirports.length > 0
          ? { originAirports: resolvedOriginAirports, returnToHome, totalNights: totalNightsResolved }
          : null;
      // Probe when there's something real to compare: fully priced inter-
      // city legs and/or home flights (single-city trips now qualify too —
      // their home flights are exactly what moves with the date). Whether
      // every leg is priced is known only with the baseline, which
      // findDateShiftSuggestion checks before comparing.
      if (bestOrdering.length > 1 || home) {
        const rankedLegsPriced = rankedWinner.legs.every((leg) => leg.cost !== Infinity);
        if (!rankedLegsPriced && (await probeBaseline) === null) return undefined;
        // Optional work: its Duffel calls may not wait out a rate-limit
        // window (see DATE_SHIFT_RETRY_WAIT_MS). An offset they can't price
        // is simply not offered.
        return await withDuffelRetryBudget(DATE_SHIFT_RETRY_WAIT_MS, () =>
          findDateShiftSuggestion(
            bestOrdering,
            startDate,
            probeBaseline,
            travelers,
            cityMap,
            nightsFor(bestOrdering),
            home,
            probeCtx,
            dateShiftOutcome,
          ),
        );
      }
    } catch (err: any) {
      logger.warn('Date-shift probe failed (non-fatal)', { message: err?.message });
    }
    return undefined;
  })();

  // The work below searches once more a route-day whose answer had no priced
  // train (RunRail.retry; see retryRailAfterRanking).
  const realDayCtx = retryRailAfterRanking
    ? ctx.withTrainDate(undefined).withTrainSource({ id: 'retry', search: ctx.rail.retry })
    : ctx.withTrainDate(undefined);

  // The winner's inter-city legs on their real days (see rankingTrainDay):
  // its trains as the trip will show them, with that day's times and fares.
  // Its flights are the ones ranking searched (served from the memos), the
  // first leg is on the ranking day already, so this is one new rail search
  // per later leg. Home flights don't depend on the train day and are kept
  // as ranked. The savings above stay ranking-vs-ranking, both on one day.
  if (bestOrdering.length > 1) {
    const ranked = topRoutes[0];
    const [rankedLegs, exactLegs] = await Promise.all([
      scoreRoute(bestOrdering, startDate, travelers, cityMap, nightsFor(bestOrdering), ctx),
      scoreRoute(bestOrdering, startDate, travelers, cityMap, nightsFor(bestOrdering), realDayCtx),
    ]);
    // A leg the real day can't price (the rail search failed or hit the
    // quota) keeps its ranking-day answer: a priced leg must not turn into
    // a gap after the savings and the ranking were decided on it.
    const legs = exactLegs.legs.map((leg, i) =>
      leg.cost === Infinity && rankedLegs.legs[i].cost !== Infinity ? rankedLegs.legs[i] : leg,
    );
    const legsTotal = legs.reduce((sum, leg) => sum + (leg.cost === Infinity ? 0 : leg.cost), 0);
    const legsRank = legs.reduce((sum, leg) => sum + (leg.cost === Infinity ? UNAVAILABLE_LEG_PENALTY : leg.cost), 0);
    const legsUnpriced = legs.filter((leg) => leg.cost === Infinity).length;
    topRoutes[0] = {
      ...ranked,
      legs,
      totalCost: ranked.totalCost - rankedLegs.totalCost + legsTotal,
      rankCost: ranked.rankCost - rankedLegs.rankCost + legsRank,
      unpricedLegs: ranked.unpricedLegs - rankedLegs.unpricedLegs + legsUnpriced,
    };
  }
  {
    const winningLegs = topRoutes[0].legs;
    settleProbeBaseline(
      winningLegs.every((leg) => leg.cost !== Infinity) ? winningLegs.reduce((sum, leg) => sum + leg.cost, 0) : null,
    );
  }

  // Steps 7, 7.5 and 8 only READ the winning route and the trip's dates,
  // and none needs another's answer, so they run together. They used to run
  // one after the other, which stacked the date-shift probe's Duffel round
  // trips in front of the enrichment's and the home legs' (mocked-latency
  // harness: the tail alone was ~5-6s of a 3-city run). Each keeps its own
  // non-fatal error handling, exactly as before.

  // Step 7.5: enrich the winning route's inter-city legs with top-N
  // alternatives. The scoring pass uses compareLeg (1 cheapest pair)
  // because that's all permutation ranking needs; here we re-fetch the
  // full options list for the WINNING route only so the displayed
  // Connector cards have 4 alternatives by default.
  //
  // Why only the winner: M legs × N permutations of searchLegOptions
  // calls would explode API cost. M extra calls (one per winning leg)
  // is bounded and reuses Duffel's per-request offer caching from the
  // scoring pass that just ran.
  const enrichTask = Promise.all(
    topRoutes[0].legs.map(async (leg, i) => {
      try {
        const fromCity = cityMap.get(leg.from);
        const toCity = cityMap.get(leg.to);
        // Same date as scoring priced the i-th leg on, so its flight search
        // is the one flights.ts already holds.
        const legDate = legDateAt(startDate, nightsFor(bestOrdering), i);
        const result = await searchLegOptions({
          from: leg.from,
          to: leg.to,
          date: legDate,
          travelers,
          fromCountry: fromCity?.country ?? getCityCountry(leg.from),
          toCountry: toCity?.country ?? getCityCountry(leg.to),
          currentPrice: leg.cost,
          limit: 4,
          // Same airports the scoring priced: the trip decides which Lagos.
          tripCityNames: ctx.tripCityNames,
          // The run's rail answers, with the one retry the exact legs got —
          // never another search of the same route-day.
          searchTrains: retryRailAfterRanking ? ctx.rail.retry : ctx.rail.search,
        });
        if (result.options.length > 0) {
          leg.options = result.options;
        }
      } catch (err: any) {
        // Non-fatal — the leg keeps its `comparison` shape and
        // displays only 1 alternative (current behavior). Log for
        // observability so we can spot if a particular city pair
        // consistently fails enrichment.
        logger.warn('Top-4 enrichment failed for leg (non-fatal)', {
          from: leg.from,
          to: leg.to,
          message: err?.message,
        });
      }
    }),
  );

  // Step 8: build full HomeLeg objects for the winning route. We only
  // do this for the WINNING permutation (not all of them) to keep the
  // round-trip of API calls bounded. Already-cached searches from the
  // scoring pass mean these are typically fast. On 4+ cities they are the
  // offers ranking found (homeFares), plus a search of each of the
  // traveller's airports a metro answer left out, so the fare shown is the
  // cheapest from all of them (see searchHomeOffers). Outbound and return are
  // independent, so they are built together.
  const homeLegsCtx = homeFares ? ctx.phased('homeLegs') : ctx;
  const lastCity = bestOrdering[bestOrdering.length - 1];
  const homeLegsTask: Promise<[HomeLeg | null, HomeLeg | null]> = homeKnown
    ? Promise.all([
        buildHomeLeg(
          {
            originAirports: resolvedOriginAirports,
            destinationCity: bestOrdering[0],
            date: outboundDate,
            travelers,
            originCity: origin,
          },
          homeLegsCtx,
          homeFares?.complete(bestOrdering[0], false, homeLegsCtx),
        ),
        returnToHome
          ? // Return leg departs after spending all the trip's nights —
            // cumulative sum of the per-city nights array.
            buildHomeLeg(
              {
                originAirports: resolvedOriginAirports,
                destinationCity: lastCity,
                date: returnDate,
                travelers,
                reverse: true,
                originCity: origin,
              },
              homeLegsCtx,
              homeFares?.complete(lastCity, true, homeLegsCtx),
            )
          : Promise.resolve(null),
      ])
    : Promise.resolve([null, null]);

  // Step 7b: hold the best transport-only shift to the whole trip by
  // re-pricing its hotels at both dates (confirmDateShiftWithHotels). It
  // needs the trip's stays, which need the built outbound (the first stay
  // starts when it lands), so it starts as soon as the probe and the home
  // legs are both in — alongside the enrichment rather than after it. No
  // transport candidate, no hotel searches.
  const dateShiftTask = (async (): Promise<DateShiftSuggestion | undefined> => {
    const transport = await dateShiftTransportTask;
    // Given up on: nobody will read the answer, so no hotel searches for it.
    if (!transport || probeGate.abandoned) return undefined;
    dateShiftOutcome.hadCandidate = true;
    const [outbound] = await homeLegsTask;
    const planned = stayDates(bestOrdering, startDate, nightsFor(bestOrdering), outbound);
    const stays = bestOrdering.map((city) => ({
      city,
      checkin: planned[city].arrival,
      checkout: planned[city].departure,
    }));
    return confirmDateShiftWithHotels(transport, stays, travelers, dateShiftOutcome);
  })();

  // The core result: the winner's leg alternatives and home legs. The probe
  // gets until then plus a grace, and no longer — it is a banner. Given up
  // on, the plan goes out with no suggestion and dateShiftChecked: false (the
  // results header then makes no price claim); its unsent searches are
  // dropped (probeGate) and the few in flight finish into flights.ts' cache.
  const [, [outboundLeg, returnLeg]] = await Promise.all([enrichTask, homeLegsTask]);
  const graceMs = DATE_SHIFT_GRACE_SHORT_TRIP_MS;
  const PROBE_TIMED_OUT = Symbol('probe timed out');
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const probeResult = probesDates
    ? await Promise.race([
        dateShiftTask,
        new Promise<typeof PROBE_TIMED_OUT>((resolve) => {
          graceTimer = setTimeout(() => resolve(PROBE_TIMED_OUT), graceMs);
        }),
      ])
    : undefined;
  clearTimeout(graceTimer);
  const probeTimedOut = probeResult === PROBE_TIMED_OUT;
  if (probeTimedOut) {
    const { inFlight, waiting } = probeGate.abandon();
    logger.info('Date-shift probe given up: not done within the grace after the plan', {
      cities: cities.length,
      graceMs,
      inFlight,
      notSent: waiting,
    });
  }
  const dateShiftSuggestion = probeTimedOut ? undefined : (probeResult as DateShiftSuggestion | undefined);

  // Step 6: assign arrival/departure dates for the best ordering using
  // the per-city nights array. This keeps the displayed calendar
  // aligned with the dates we actually queried during scoring. (Computed
  // after the tail: it needs the built outbound flight.) The first stay
  // starts the day the outbound LANDS (firstStayArrival).
  const dates = stayDates(bestOrdering, startDate, nightsFor(bestOrdering), outboundLeg);

  // Every flight search failed and nothing else priced the trip (B14): this
  // is an outage, not a trip. It used to return 200 with every leg
  // "unavailable", both home flights null and totalCost $0 — a card that
  // reads like a real, free itinerary. A 502 lands in the planner's
  // existing error message instead. Narrow on purpose: one search that
  // ANSWERED (even with no offers), or one leg rail priced, and the trip is
  // returned as before.
  const { answered, threw, firstError } = ctx.flightOutcomes;
  const nothingPriced =
    topRoutes[0].legs.every((leg) => leg.cost === Infinity) && !outboundLeg && !returnLeg;
  if (answered === 0 && threw > 0 && nothingPriced) {
    logger.error('Optimize failed: every flight search errored', { threw });
    // flights.ts' own message ("Flight search failed: …"), the same text
    // /api/flights/search returns for the same failure.
    const message =
      firstError instanceof Error && firstError.message ? firstError.message : 'Flight search failed';
    throw new AppError(502, message, { source: 'duffel' });
  }

  // What this plan cost against Duffel's ~45-a-minute window (see
  // RunContext.searchLedger).
  const byPhase: Partial<Record<SearchPhase, number>> = {};
  for (const phase of ctx.searchLedger.values()) byPhase[phase] = (byPhase[phase] ?? 0) + 1;
  const sentByPhase: Partial<Record<SearchPhase, number>> = {};
  for (const phase of ctx.sentLedger.values()) sentByPhase[phase] = (sentByPhase[phase] ?? 0) + 1;
  logger.info('Optimize flight searches', {
    cities: cities.length,
    searches: ctx.searchLedger.size,
    byPhase,
    // Of those, the ones that were not already in flights.ts' cache.
    sent: ctx.sentLedger.size,
    sentByPhase,
    ...(screenStats
      ? { exactRounds: screenStats.rounds, budgetStop: screenStats.budgetStop, reservedForHomeLegs: screenStats.reserved }
      : {}),
  });
  // When the plan was decided and answered, and how much rail ranking had.
  logger.info('Optimize timing', {
    cities: cities.length,
    rankingMs,
    firstAnswerMs,
    fullAnswerMs: Date.now() - runStarted,
    rail: railBoard.stats(),
    railRetry: retryRailAfterRanking,
    rankingRail: quickRankingRail ? 'quick' : 'full',
  });

  const publicRoutes = topRoutes.map(toPublicRoute);
  return {
    routes: publicRoutes,
    bestRoute: publicRoutes[0],
    savingsVsNaive,
    iataCodes,
    dates,
    dateShiftSuggestion,
    dateShiftChecked:
      !probeTimedOut &&
      dateShiftOutcome.offsetsPriced > 0 &&
      (!dateShiftOutcome.hadCandidate || dateShiftOutcome.hotelsPriced),
    outboundLeg,
    returnLeg,
    // Only present when the origin had more than one real reading. The legs
    // above were priced from the first candidate, so this is how a caller
    // learns the total it is showing rests on a guess.
    ...(originClarification ? { originClarification } : {}),
  };
}
