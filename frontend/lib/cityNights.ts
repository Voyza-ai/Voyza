/**
 * A staged per-city night split ("Plan a similar trip" keeps a preset's own:
 * Lisbon 3, Sintra 1), checked against the trip about to be planned. It is
 * sent to the optimizer only while it still describes that trip: one whole,
 * positive number of nights for exactly each destination, adding up to the
 * trip's nights. Anything else (the traveller changed the cities or the
 * length in the chat since) falls back to the optimizer's even split.
 */
export function usableCityNights(
  cityNights: Record<string, number> | undefined,
  destinations: string[],
  totalNights: number | undefined,
): Record<string, number> | undefined {
  if (!cityNights || destinations.length === 0) return undefined;
  const key = (name: string) => name.trim().toLowerCase();
  const byKey = new Map(Object.entries(cityNights).map(([name, n]) => [key(name), n]));
  if (byKey.size !== destinations.length || byKey.size !== Object.keys(cityNights).length) return undefined;
  const out: Record<string, number> = {};
  for (const name of destinations) {
    const n = byKey.get(key(name));
    if (n === undefined || !Number.isInteger(n) || n <= 0) return undefined;
    out[name] = n;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (typeof totalNights === 'number' && sum !== totalNights) return undefined;
  return out;
}

/** A staged country for `name`, matched like `usableCityNights` matches nights. */
export function stagedCountry(cityCountries: Record<string, string> | undefined, name: string): string | undefined {
  if (!cityCountries) return undefined;
  const key = name.trim().toLowerCase();
  const hit = Object.entries(cityCountries).find(([n]) => n.trim().toLowerCase() === key);
  return hit?.[1] || undefined;
}
