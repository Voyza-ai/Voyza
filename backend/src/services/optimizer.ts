import { compareLeg, LegComparison } from './compareLeg';
import { getIataCode } from './flights';
import { logger } from '../utils/logger';

type CityInput = {
  name: string;
  country?: string;
};

type OptimizedLeg = {
  from: string;
  to: string;
  comparison: LegComparison;
  cost: number;
};

type OptimizedRoute = {
  ordering: string[];
  totalCost: number;
  legs: OptimizedLeg[];
};

export type OptimizeResult = {
  routes: OptimizedRoute[];
  bestRoute: OptimizedRoute;
  savingsVsNaive: number;
  iataCodes: Record<string, string>;
  dates: Record<string, { arrival: string; departure: string }>;
};

type OptimizeParams = {
  cities: CityInput[];
  startDate: string;
  travelers: number;
  budget?: number;
};

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

function nearestNeighborRoute(
  cities: CityInput[],
  startIdx: number,
  distanceFn: (a: string, b: string) => number,
): string[] {
  const visited = new Set<number>();
  const route: string[] = [];
  let current = startIdx;

  visited.add(current);
  route.push(cities[current].name);

  while (visited.size < cities.length) {
    let nearest = -1;
    let nearestDist = Infinity;

    for (let i = 0; i < cities.length; i++) {
      if (visited.has(i)) continue;
      const dist = distanceFn(cities[current].name, cities[i].name);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    }

    if (nearest === -1) break;
    visited.add(nearest);
    route.push(cities[nearest].name);
    current = nearest;
  }

  return route;
}

async function scoreRoute(
  ordering: string[],
  date: string,
  travelers: number,
  cityMap: Map<string, CityInput>,
): Promise<OptimizedRoute> {
  const legs: OptimizedLeg[] = [];

  // Compare legs in parallel
  const legPromises = [];
  for (let i = 0; i < ordering.length - 1; i++) {
    const from = ordering[i];
    const to = ordering[i + 1];
    const fromCity = cityMap.get(from);
    const toCity = cityMap.get(to);

    legPromises.push(
      compareLeg({
        origin: from,
        destination: to,
        date, // simplified — real impl would offset dates per city
        travelers,
        originCountry: fromCity?.country,
        destinationCountry: toCity?.country,
      }).then((comparison) => ({
        from,
        to,
        comparison,
        cost: Math.min(
          comparison.flightOption?.price ?? Infinity,
          comparison.trainOption?.price ?? Infinity,
        ),
      })),
    );
  }

  const resolvedLegs = await Promise.all(legPromises);
  legs.push(...resolvedLegs);

  const totalCost = legs.reduce((sum, leg) => {
    const cost = leg.cost === Infinity ? 0 : leg.cost;
    return sum + cost;
  }, 0);

  return { ordering, totalCost, legs };
}

export async function optimize(params: OptimizeParams): Promise<OptimizeResult> {
  const { cities, startDate, travelers } = params;

  if (cities.length < 2) {
    throw new Error('Need at least 2 cities to optimize');
  }

  // Step 1: resolve IATA codes in parallel
  const iataCodes: Record<string, string> = {};
  await Promise.all(
    cities.map(async (city) => {
      try {
        iataCodes[city.name] = await getIataCode(city.name);
      } catch {
        logger.warn('Could not resolve IATA for', { city: city.name });
      }
    }),
  );

  const cityMap = new Map(cities.map((c) => [c.name, c]));

  // Step 2: generate permutations
  let orderings: string[][];

  if (cities.length <= 5) {
    // Full permutations, fix first city
    const rest = cities.slice(1);
    const perms = getPermutations(rest);
    orderings = perms.map((p) => [cities[0].name, ...p.map((c) => c.name)]);
  } else {
    // Nearest-neighbor heuristic with 3 random seeds
    const simpleDistFn = (a: string, b: string) => {
      // Use a simple hash-based pseudo-distance for heuristic ordering
      const hash = (s: string) =>
        s.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
      return Math.abs(hash(a) - hash(b));
    };

    const seeds = [0, Math.floor(cities.length / 2), cities.length - 1];
    orderings = seeds.map((seed) => nearestNeighborRoute(cities, seed, simpleDistFn));
  }

  // Step 3: score each permutation
  const routes = await Promise.all(
    orderings.map((ordering) => scoreRoute(ordering, startDate, travelers, cityMap)),
  );

  // Step 4: sort by totalCost, return top 3
  routes.sort((a, b) => a.totalCost - b.totalCost);
  const topRoutes = routes.slice(0, 3);

  // Step 5: compute savings vs naive (original order)
  const naiveOrdering = cities.map((c) => c.name);
  const naiveRoute = await scoreRoute(naiveOrdering, startDate, travelers, cityMap);
  const savingsVsNaive = Math.max(0, naiveRoute.totalCost - topRoutes[0].totalCost);

  // Step 6: assign dates — 2 nights per city default
  const dates: Record<string, { arrival: string; departure: string }> = {};
  const bestOrdering = topRoutes[0].ordering;
  let currentDate = new Date(startDate);

  for (const cityName of bestOrdering) {
    const arrival = currentDate.toISOString().split('T')[0];
    currentDate.setDate(currentDate.getDate() + 2);
    const departure = currentDate.toISOString().split('T')[0];
    dates[cityName] = { arrival, departure };
  }

  return {
    routes: topRoutes,
    bestRoute: topRoutes[0],
    savingsVsNaive,
    iataCodes,
    dates,
  };
}
