/**
 * Turning a set of city positions into the label a traveller recognises.
 *
 * City pins are numbered by visit order — 1, 2, 3, 4. When cities collapse
 * into their countries, the badge has to keep meaning the same thing. Showing
 * a COUNT there instead reads as an order: a trip through France (2 stops),
 * the Netherlands (1) and Czechia (1) renders as "2 · 1 · 1", which looks like
 * stop 2 followed by stop 1 twice. The order is what the badge must say.
 */

/**
 * Visit-order label for the stops in one group, 1-based.
 *
 *   [0, 1]       → "1–2"
 *   [2]          → "3"
 *   [0, 2]       → "1, 3"     (a country returned to later in the trip)
 *   [0, 1, 3, 4] → "1–2, 4–5"
 *
 * Consecutive stops collapse into a range; a gap starts a new group, so a trip
 * that leaves a country and comes back reads honestly rather than claiming an
 * unbroken stretch.
 */
export function visitOrderLabel(indexes: number[]): string {
  if (indexes.length === 0) return '';
  const sorted = indexes
    .filter((n, i) => indexes.indexOf(n) === i)
    .sort((a, b) => a - b);

  const runs: [number, number][] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    runs.push([start, prev]);
    start = sorted[i];
    prev = sorted[i];
  }
  runs.push([start, prev]);

  return runs
    .map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`))
    .join(', ');
}
