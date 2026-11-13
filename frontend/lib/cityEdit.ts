import type { City, HomeLeg, Transport, Trip } from './types';
import type { CityEditProposal, LegOption } from './api';
import { hotelFromResult } from './hotelShape';
import { liveTripTotal } from './tripTotals';
import { buildCityScheduleFromSuggestions } from './dayScheduleDefaults';
import { countryForCity } from '@/data/worldCities';
import { nextColorIndex, withColorIndices } from './cityColors';

/**
 * Apply an AI chat city edit (add_city / remove_city / replace_city) to a
 * trip. The backend planned the new city list and priced only what changed
 * (services/cityEdit.ts there); this puts those pieces on the trip:
 *
 *  - a city the edit didn't touch is the trip's own object, unchanged;
 *  - a city whose dates moved keeps everything but gets the new dates and,
 *    when the backend searched them, its new hotels (the traveller's pick
 *    kept by name when it is still listed);
 *  - a new city gets its searched hotels, the trip's vibes, empty picks and
 *    a transport-only schedule (what the planner gives a city before its AI
 *    picks land);
 *  - a priced leg replaces whatever was between those two cities; a pair
 *    the backend didn't price keeps the trip's leg;
 *  - re-searched home flights replace the old ones.
 *
 * Pure: the same proposal gives the same trip, so the diff card can preview
 * it and Accept can apply it to the trip as it is then.
 */
export function applyCityEdit(input: Trip, proposal: CityEditProposal): Trip {
  // Lock each city's colour to where it is now, so inserting a city doesn't
  // repaint the ones after it, and the new one takes a colour of its own.
  const trip: Trip = { ...input, cities: withColorIndices(input.cities) };
  const byName = new Map(trip.cities.map((c) => [c.name.toLowerCase(), c]));
  const vibes = trip.cities.find((c) => c.vibes && c.vibes.length > 0)?.vibes ?? [];
  const placeholder = { name: '', rating: 0, pricePerNight: 0, area: '' };
  const empty = (from: string, to: string): Transport => ({ mode: 'flight', operator: '', duration: '', price: 0, from, to });

  const used: City[] = [];
  const cities: City[] = proposal.after.map((stop) => {
    const dates = { arrival: stop.arrival, departure: stop.departure };
    const hotels = stop.hotels ? stop.hotels.map(hotelFromResult) : null;
    const own = stop.status === 'kept' || stop.status === 'moved' ? byName.get(stop.name.toLowerCase()) : undefined;
    if (own) {
      if (stop.status === 'kept' && own.dates.arrival === stop.arrival && own.dates.departure === stop.departure && !hotels) {
        return own;
      }
      let next: City = { ...own, dates };
      if (hotels && hotels.length > 0) {
        const picked = own.hotels[own.selectedHotelIndex]?.name;
        const keep = picked ? hotels.findIndex((h) => h.name === picked) : -1;
        const sel = keep >= 0 ? keep : 0;
        next = { ...next, hotels, hotel: hotels[sel], selectedHotelIndex: sel };
      }
      return next;
    }
    const city: City = {
      name: stop.name,
      country: countryForCity(stop.name),
      dates,
      transportIn: empty('', stop.name),
      transportOut: empty(stop.name, ''),
      hotel: hotels?.[0] ?? placeholder,
      hotels: hotels ?? [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      vibes,
      colorIndex: nextColorIndex([...trip.cities, ...used]),
    };
    used.push(city);
    return city;
  });

  // Legs: priced ones from the proposal; unpriced pairs keep the trip's leg.
  const priced = new Map(proposal.legs.map((l) => [l.index, l]));
  for (let i = 0; i < cities.length - 1; i++) {
    const from = cities[i];
    const to = cities[i + 1];
    const leg = priced.get(i);
    let out: Transport;
    if (leg) {
      out = legToTransport(leg.options, from.name, to.name, leg.date);
    } else if (to.transportIn?.from?.toLowerCase() === from.name.toLowerCase() && from.transportOut?.to?.toLowerCase() !== to.name.toLowerCase()) {
      out = { ...to.transportIn };
    } else {
      // The pair the trip already had (the backend prices every pair it changed).
      out = from.transportOut;
    }
    const { alternatives: _alts, ...flat } = out;
    cities[i] = { ...cities[i], transportOut: out };
    cities[i + 1] = { ...cities[i + 1], transportIn: flat };
  }
  // The ends face home, not another city.
  const first = cities[0];
  const last = cities[cities.length - 1];
  if (first && first.transportIn?.from && byName.has(first.transportIn.from.toLowerCase())) {
    cities[0] = { ...first, transportIn: empty('', first.name) };
  }
  if (last && last.transportOut?.to && byName.has(last.transportOut.to.toLowerCase())) {
    cities[cities.length - 1] = { ...cities[cities.length - 1], transportOut: empty(last.name, '') };
  }

  let origin = trip.origin;
  if (origin && 'outboundLeg' in proposal) origin = { ...origin, outboundLeg: (proposal.outboundLeg ?? null) as HomeLeg | null };
  if (origin && 'returnLeg' in proposal) origin = { ...origin, returnLeg: (proposal.returnLeg ?? null) as HomeLeg | null };

  const oldTitle = trip.cities.map((c) => c.name).join(' → ');
  const next: Trip = {
    ...trip,
    title: !trip.title || trip.title === oldTitle ? cities.map((c) => c.name).join(' → ') : trip.title,
    cities,
    origin,
    // "Saved $X vs your original city order" was about the old city list.
    savings: 0,
    // The date-shift check priced the old trip; its suggestion no longer applies.
    dateShiftSuggestion: undefined,
    dateShiftChecked: false,
    // A date edit (pin / minimum stay) keeps its constraint for the next turns.
    ...(proposal.constraints ? { constraints: proposal.constraints } : {}),
  };

  // New cities: a transport-only schedule, as the planner gives a city
  // before its picks land. (A moved city keeps its own schedule, the same as
  // an accepted date shift.)
  next.cities = next.cities.map((c, idx) => {
    const status = proposal.after[idx].status;
    if (status !== 'added' && status !== 'replaced') return c;
    const built = buildCityScheduleFromSuggestions([], [], c, idx, next);
    return { ...c, schedule: built.schedule, unscheduled: built.unscheduled };
  });
  next.totalCost = liveTripTotal(next);
  return next;
}

/** A leg's searched options as the flowchart's Transport: cheapest first, the rest as alternatives. */
export function legToTransport(options: LegOption[], from: string, to: string, date: string): Transport {
  const toT = (o: LegOption): Transport => ({
    mode: o.mode,
    operator: o.operator ?? '',
    duration: o.duration ?? '',
    price: o.price ?? 0,
    from,
    to,
    departTime: o.departTime ?? undefined,
    arriveTime: o.arriveTime ?? undefined,
    departDate: date,
    layovers: o.mode === 'flight' ? (o.stops ?? 0) : 0,
    bookingUrl: o.bookingUrl ?? undefined,
    flightNumber: o.mode === 'flight' ? (o.flightNumber ?? undefined) : undefined,
    trainNumber: o.mode === 'train' ? (o.flightNumber ?? undefined) : undefined,
  });
  const [main, ...rest] = options;
  if (!main) return { mode: 'flight', operator: '', duration: '', price: 0, from, to, departDate: date, unavailable: true };
  const t = toT(main);
  t.alternatives = rest.map(toT);
  if (main.mode === 'flight' && !options.some((o) => o.mode === 'train') && (main.durationMinutes ?? 999) <= 360) {
    t.noTrainData = true;
  }
  return t;
}

/** One row of the diff card. */
export type CityEditRow =
  | { kind: 'added' | 'replaced' | 'moved' | 'kept'; name: string; replaces?: string; oldDates?: { arrival: string; departure: string }; dates: { arrival: string; departure: string }; hotel?: { name: string; pricePerNight: number } | null }
  | { kind: 'removed'; name: string; oldDates: { arrival: string; departure: string } };

/** What the diff card shows: each city before → after, and the trip total before → after. */
export function cityEditDiff(trip: Trip, proposal: CityEditProposal): { rows: CityEditRow[]; before: number; after: number; preview: Trip } {
  const preview = applyCityEdit(trip, proposal);
  const beforeByName = new Map(proposal.before.map((s) => [s.name.toLowerCase(), s]));
  const rows: CityEditRow[] = [];
  proposal.after.forEach((s, i) => {
    const c = preview.cities[i];
    const hotel = c.hotel?.name ? { name: c.hotel.name, pricePerNight: c.hotel.pricePerNight } : null;
    const old = beforeByName.get(s.name.toLowerCase());
    if (s.status === 'added' || s.status === 'replaced') {
      // A removed city shows right where its replacement now sits.
      rows.push({ kind: s.status, name: s.name, replaces: s.replaces, dates: { arrival: s.arrival, departure: s.departure }, hotel });
    } else {
      const moved = !!old && (old.arrival !== s.arrival || old.departure !== s.departure);
      rows.push({
        kind: moved ? 'moved' : 'kept',
        name: s.name,
        oldDates: old ? { arrival: old.arrival, departure: old.departure } : undefined,
        dates: { arrival: s.arrival, departure: s.departure },
      });
    }
  });
  if (proposal.op.kind === 'remove') {
    for (const name of proposal.removed) {
      const old = beforeByName.get(name.toLowerCase());
      if (!old) continue;
      const at = proposal.before.findIndex((b) => b.name === old.name);
      rows.splice(Math.min(at, rows.length), 0, { kind: 'removed', name: old.name, oldDates: { arrival: old.arrival, departure: old.departure } });
    }
  }
  return { rows, before: liveTripTotal(trip), after: preview.totalCost, preview };
}
