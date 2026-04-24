/**
 * Trip constraints — user-stated intent that the AI chat collects and
 * the optimizer honors. Lives in `trips.constraints` jsonb.
 *
 * Three flavors for the current MVP:
 *   - Pinned cities:   "I need to be in Rome March 5-10" → lock exact dates
 *   - Min days:        "at least 3 days in Tokyo"        → extend stay
 *   - Transport windows: "no flights before 5pm"          → filter options
 *
 * Applied eagerly for the first two (dates change immediately, shown in
 * the proposal diff). Stored-but-not-yet-applied for transport windows
 * (full filtering requires a compareLeg refactor; MVP acknowledges the
 * constraint and honors it on next explicit re-optimize).
 */

export type PinnedCity = {
  city: string;
  arrival: string; // YYYY-MM-DD
  departure: string; // YYYY-MM-DD
};

export type MinDaysRule = {
  city: string;
  minNights: number;
};

export type TransportWindow = {
  from: string;
  to: string;
  earliestDepart?: string | null; // HH:MM
  latestDepart?: string | null;
  earliestArrive?: string | null;
  latestArrive?: string | null;
};

export type TripConstraints = {
  pinned_cities?: PinnedCity[];
  min_days?: MinDaysRule[];
  transport_windows?: TransportWindow[];
};

/** Advance an ISO date by N days, returning YYYY-MM-DD. */
function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/** Nights between two YYYY-MM-DD dates (min 1 so even same-day shows as a 1-night stay). */
function nightsBetween(arrival: string, departure: string): number {
  const ms = new Date(departure).getTime() - new Date(arrival).getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}

/** Compare by first-day-of-stay so callers can keep the ordering stable. */
function byArrival(a: { arrival_date?: string | null }, b: { arrival_date?: string | null }): number {
  return (a.arrival_date ?? '').localeCompare(b.arrival_date ?? '');
}

/**
 * Apply pinned-city + min-days constraints to a trip's city list and
 * return the new city dates. Order of cities is preserved — we only
 * recompute arrival/departure.
 *
 * Algorithm:
 *   1. For each city, start with its current (arrival, departure).
 *   2. Find the index of the first pinned city in the sequence. Walk
 *      backward from it setting preceding cities' departures to end by
 *      the pin's arrival (preserving each city's original night count).
 *   3. Walk forward from it setting following cities' arrivals to start
 *      after the pin's departure (preserving nights).
 *   4. Same pass for any additional pinned cities — later pins win if
 *      they conflict with computed values from earlier pins (user
 *      intent > algorithm).
 *   5. min_days: if any city's resulting nights < minNights, extend its
 *      departure forward and shift everything after.
 *
 * Returns: the new cities array with updated arrival/departure, plus a
 * diff describing what moved, for the proposal card.
 */
export function applyDateConstraints<
  TCity extends {
    name: string;
    arrival_date?: string | null;
    departure_date?: string | null;
  },
>(
  cities: TCity[],
  constraints: TripConstraints,
): {
  cities: TCity[];
  diff: Array<{ city: string; oldArrival: string | null; newArrival: string; oldDeparture: string | null; newDeparture: string }>;
} {
  if (cities.length === 0) return { cities: [...cities], diff: [] };

  // Work on a copy so we never mutate caller state.
  const next = cities.map((c) => ({ ...c })) as TCity[];

  // Remember each city's original night count — we preserve stay length
  // when shifting around pins.
  const originalNights: Record<string, number> = {};
  for (const c of next) {
    if (c.arrival_date && c.departure_date) {
      originalNights[c.name] = nightsBetween(c.arrival_date, c.departure_date);
    } else {
      originalNights[c.name] = 2; // sensible default; matches optimizer's NIGHTS_PER_CITY
    }
  }

  const pinned = constraints.pinned_cities ?? [];
  const pinnedByName = new Map<string, PinnedCity>();
  for (const p of pinned) pinnedByName.set(p.city.toLowerCase(), p);

  // --- Pass 1: set pinned cities' own dates.
  for (const c of next) {
    const pin = pinnedByName.get(c.name.toLowerCase());
    if (pin) {
      c.arrival_date = pin.arrival;
      c.departure_date = pin.departure;
    }
  }

  // --- Pass 2: propagate from each pinned city outward (both directions).
  //    If a city isn't pinned, its dates are computed based on the
  //    nearest pinned neighbor(s), preserving night count.
  // Find pinned indices in sequence order.
  const pinnedIndices: number[] = [];
  next.forEach((c, i) => {
    if (pinnedByName.has(c.name.toLowerCase())) pinnedIndices.push(i);
  });

  if (pinnedIndices.length > 0) {
    // For each pinned city, shift its neighbors.
    for (const pinIdx of pinnedIndices) {
      const pinnedCity = next[pinIdx];
      const pinArrival = pinnedCity.arrival_date!;
      const pinDeparture = pinnedCity.departure_date!;

      // Walk backward: city i-1's departure = pin.arrival, arrival = that - nights[i-1].
      let cursorDate = pinArrival;
      for (let i = pinIdx - 1; i >= 0; i--) {
        if (pinnedByName.has(next[i].name.toLowerCase())) break; // stop at another pin
        const nights = originalNights[next[i].name] ?? 2;
        next[i].departure_date = cursorDate;
        next[i].arrival_date = addDays(cursorDate, -nights);
        cursorDate = next[i].arrival_date!;
      }

      // Walk forward: city i+1's arrival = pin.departure, departure = that + nights[i+1].
      cursorDate = pinDeparture;
      for (let i = pinIdx + 1; i < next.length; i++) {
        if (pinnedByName.has(next[i].name.toLowerCase())) break; // stop at another pin
        const nights = originalNights[next[i].name] ?? 2;
        next[i].arrival_date = cursorDate;
        next[i].departure_date = addDays(cursorDate, nights);
        cursorDate = next[i].departure_date!;
      }
    }
  }

  // --- Pass 3: enforce min_days. If a city's current stay is shorter
  //    than the required minNights, extend its departure and shift all
  //    subsequent cities forward by the same delta (preserving their
  //    stay length). Pinned cities are NEVER shrunk or shifted — the
  //    user explicitly set them.
  const minByName = new Map<string, number>();
  for (const m of constraints.min_days ?? []) minByName.set(m.city.toLowerCase(), m.minNights);

  if (minByName.size > 0) {
    for (let i = 0; i < next.length; i++) {
      const city = next[i];
      if (!city.arrival_date || !city.departure_date) continue;
      if (pinnedByName.has(city.name.toLowerCase())) continue; // don't touch pinned
      const min = minByName.get(city.name.toLowerCase());
      if (!min) continue;
      const currentNights = nightsBetween(city.arrival_date, city.departure_date);
      if (currentNights >= min) continue;

      const delta = min - currentNights;
      city.departure_date = addDays(city.departure_date, delta);

      // Shift every following non-pinned city by `delta`.
      for (let j = i + 1; j < next.length; j++) {
        if (pinnedByName.has(next[j].name.toLowerCase())) break; // respect the next pin
        if (next[j].arrival_date) next[j].arrival_date = addDays(next[j].arrival_date!, delta);
        if (next[j].departure_date) next[j].departure_date = addDays(next[j].departure_date!, delta);
      }
    }
  }

  // Build a diff for the proposal card — any city whose dates changed.
  const diff: Array<{
    city: string;
    oldArrival: string | null;
    newArrival: string;
    oldDeparture: string | null;
    newDeparture: string;
  }> = [];
  for (let i = 0; i < cities.length; i++) {
    const oldA = cities[i].arrival_date ?? null;
    const oldD = cities[i].departure_date ?? null;
    const newA = next[i].arrival_date ?? null;
    const newD = next[i].departure_date ?? null;
    if (oldA !== newA || oldD !== newD) {
      diff.push({
        city: cities[i].name,
        oldArrival: oldA,
        newArrival: newA ?? '',
        oldDeparture: oldD,
        newDeparture: newD ?? '',
      });
    }
  }
  // Keep cities array ordered as the caller provided (not re-sorted by
  // arrival) — the trip's sequence is canonical, not chronological.
  void byArrival;

  return { cities: next, diff };
}

/**
 * Merge a partial constraint update onto existing constraints. Later
 * writes supersede earlier ones for the same target (e.g. pinning Rome
 * to a new date range replaces the previous Rome pin).
 */
export function mergeConstraints(
  base: TripConstraints,
  update: TripConstraints,
): TripConstraints {
  const merged: TripConstraints = {
    pinned_cities: [...(base.pinned_cities ?? [])],
    min_days: [...(base.min_days ?? [])],
    transport_windows: [...(base.transport_windows ?? [])],
  };

  for (const pin of update.pinned_cities ?? []) {
    merged.pinned_cities = merged.pinned_cities!.filter(
      (p) => p.city.toLowerCase() !== pin.city.toLowerCase(),
    );
    merged.pinned_cities!.push(pin);
  }

  for (const rule of update.min_days ?? []) {
    merged.min_days = merged.min_days!.filter(
      (r) => r.city.toLowerCase() !== rule.city.toLowerCase(),
    );
    merged.min_days!.push(rule);
  }

  for (const window of update.transport_windows ?? []) {
    merged.transport_windows = merged.transport_windows!.filter(
      (w) =>
        !(
          w.from.toLowerCase() === window.from.toLowerCase() &&
          w.to.toLowerCase() === window.to.toLowerCase()
        ),
    );
    merged.transport_windows!.push(window);
  }

  return merged;
}
