/**
 * The planner's search screen: which steps of a "Find my trip" search are
 * done, which is running, and the live numbers behind it.
 *
 * Every number shown comes from work actually done — the optimizer's own
 * counts (GET /api/optimize/progress/:id, see backend optimizeProgress.ts) or
 * the planner's hotel searches as they start and finish. When the backend's
 * counts are unavailable the steps show without numbers rather than with
 * made-up ones.
 */

/** Mirrors backend/src/services/optimizeProgress.ts. */
export type OptimizeProgress = {
  stage: 'airports' | 'routes' | 'finishing' | 'done';
  orderings: number;
  legsAsked: number;
  legsPriced: number;
  flightSearches: number;
  bestOrder?: string[];
  updatedAt: number;
};

export type SearchProgressState = {
  /** The cities searched, as asked. */
  cities: string[];
  /** Home city, when the trip has one. */
  origin?: string;
  /** Wall-clock start of the search (ms). */
  startedAt: number;
  phase: 'optimize' | 'hotels' | 'opening';
  /** Latest optimizer counts; null until (or unless) the backend reports any. */
  optimize: OptimizeProgress | null;
  /** Hotel searches: cities in flight and cities answered. */
  hotelsActive: string[];
  hotelsDone: string[];
};

export type StepStatus = 'done' | 'active' | 'pending';

export type SearchStep = {
  key: 'places' | 'compare' | 'best' | 'hotels';
  label: string;
  detail?: string;
  status: StepStatus;
};

export function startSearchProgress(cities: string[], origin?: string, now = Date.now()): SearchProgressState {
  return {
    cities,
    origin: origin || undefined,
    startedAt: now,
    phase: 'optimize',
    optimize: null,
    hotelsActive: [],
    hotelsDone: [],
  };
}

/** "Munich", "Munich and Vienna", "Munich, Vienna and Prague". */
export function listCities(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const STAGE_RANK: Record<OptimizeProgress['stage'], number> = { airports: 0, routes: 1, finishing: 2, done: 3 };

export function searchSteps(s: SearchProgressState): SearchStep[] {
  const opt = s.optimize;
  const optimizeDone = s.phase !== 'optimize';
  // Without counts the optimizer's inner stages are unknown: everything up to
  // "best order" reads as one running step.
  const rank = optimizeDone ? 3 : opt ? STAGE_RANK[opt.stage] : -1;
  const status = (from: number, until: number): StepStatus =>
    rank >= until ? 'done' : rank >= from ? 'active' : 'pending';

  const places = [...s.cities, ...(s.origin ? [s.origin] : [])];
  const steps: SearchStep[] = [
    {
      key: 'places',
      label: 'Finding stations and airports',
      detail: listCities(places),
      status: rank === -1 ? 'active' : status(0, 1),
    },
  ];

  let compareDetail: string | undefined;
  if (opt && opt.legsAsked > 0) {
    compareDetail = `${opt.legsPriced} of ${plural(opt.legsAsked, 'train-vs-flight comparison', 'train-vs-flight comparisons')} done`;
    if (opt.orderings > 1) compareDetail += ` · ${opt.orderings} possible orders`;
  } else if (opt && opt.orderings > 1) {
    compareDetail = `${opt.orderings} possible orders`;
  }
  steps.push({
    key: 'compare',
    label:
      s.cities.length > 1
        ? 'Comparing trains and flights between your cities'
        : `Comparing flights to ${s.cities[0] ?? 'your city'}`,
    detail: compareDetail,
    status: rank === -1 ? 'active' : status(1, 2),
  });

  const best = opt?.bestOrder;
  steps.push({
    key: 'best',
    label: s.origin ? `Pricing the best order and flights from ${s.origin}` : 'Pricing the best order',
    detail: best && best.length > 1 ? best.join(' → ') : undefined,
    status: status(2, 3),
  });

  const total = s.cities.length;
  const hotelsDone = s.phase === 'opening';
  let hotelLabel = 'Pricing hotels';
  if (s.phase === 'hotels' && s.hotelsActive.length > 0) hotelLabel = `Pricing hotels in ${listCities(s.hotelsActive)}`;
  steps.push({
    key: 'hotels',
    label: hotelLabel,
    detail:
      s.phase === 'hotels' || hotelsDone
        ? `${hotelsDone ? total : s.hotelsDone.length} of ${plural(total, 'city', 'cities')} done`
        : undefined,
    status: hotelsDone ? 'done' : s.phase === 'hotels' ? 'active' : 'pending',
  });
  return steps;
}

/** Whole seconds since the search started. */
export function elapsedSeconds(s: Pick<SearchProgressState, 'startedAt'>, now = Date.now()): number {
  return Math.max(0, Math.floor((now - s.startedAt) / 1000));
}
