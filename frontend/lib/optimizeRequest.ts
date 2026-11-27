import type { PlanningAnswers } from './types';
import { parseDateInput } from './parseDate';
import { stagedCountry, usableCityNights } from './cityNights';

/**
 * The trip part of a POST /api/optimize body, built from the planner's
 * answers — the ONE place it is built, so the home-flight pre-search sent
 * during the chat (POST /api/optimize/prewarm) and the plan itself describe
 * the same trip, and the backend's flight cache serves the plan from the
 * pre-search (exp/optimizer-speed).
 *
 * Total nights, in order: an explicit nights pick, else the length of a
 * concrete date range, else omitted (the backend uses 2 nights per city).
 */
export type OptimizeTripRequest = {
  cities: Array<{ name: string; country?: string }>;
  startDate: string;
  travelers: number;
  origin?: string;
  originAirports?: string[];
  returnToHome: boolean;
  totalNights?: number;
  cityNights?: Record<string, number>;
};

type Answers = Pick<
  PlanningAnswers,
  'cityCountries' | 'origin' | 'originAirports' | 'returnToHome' | 'nights' | 'dateRange' | 'cityNights'
>;

export function totalNightsFor(answers: Pick<PlanningAnswers, 'nights' | 'dateRange'>): number | undefined {
  if (typeof answers.nights === 'number' && answers.nights > 0) return answers.nights;
  const range = answers.dateRange;
  if (range?.start && range?.end) {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (iso.test(range.start) && iso.test(range.end)) {
      const ms = new Date(range.end).getTime() - new Date(range.start).getTime();
      if (ms > 0) return Math.max(1, Math.round(ms / 86_400_000));
    }
  }
  return undefined;
}

export function optimizeTripRequest(input: {
  destinations: string[];
  travelers: number;
  /** The trip's start, as typed or picked; normalized to YYYY-MM-DD. */
  startRaw: string | undefined | null;
  answers: Answers;
}): OptimizeTripRequest {
  const { destinations, travelers, answers } = input;
  const totalNights = totalNightsFor(answers);
  return {
    cities: destinations.map((d) => {
      const country = stagedCountry(answers.cityCountries, d);
      return country ? { name: d, country } : { name: d };
    }),
    startDate: parseDateInput(input.startRaw ?? ''),
    travelers,
    origin: answers.origin ?? undefined,
    originAirports: answers.originAirports ?? undefined,
    returnToHome: answers.returnToHome ?? true,
    totalNights,
    cityNights: usableCityNights(answers.cityNights, destinations, totalNights),
  };
}
