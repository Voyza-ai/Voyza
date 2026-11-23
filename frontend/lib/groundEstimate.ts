import type { GroundEstimate } from './types';

/** "35–45 min" under two hours, "4–6 h" above. */
export function formatGroundRange([low, high]: GroundEstimate['minutes']): string {
  if (high < 120) return `${low}–${high} min`;
  const h = (m: number) => Math.round(m / 60);
  return `${h(low)}–${h(high)} h`;
}

/** The card's line: "About 35–45 min by train or bus (estimate)". */
export function groundEstimateLine(g: GroundEstimate): string {
  return `About ${formatGroundRange(g.minutes)} by train or bus (estimate)`;
}
