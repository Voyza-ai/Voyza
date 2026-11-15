import type { City, Trip } from './types';
import { effectiveHotel } from './tripTotals';

/**
 * What the green "You can save" box offers when clicked: the cheaper choices
 * the trip ALREADY holds prices for — another hotel in the same city's
 * ranked list, another departure on an inter-city leg, another flight out
 * or home. Each is the single best one for its stay or leg, priced the way
 * the header total prices it, so applying it lowers the total by exactly
 * `savings`. Nothing here searches; a choice with no price is never offered.
 */
export type SaveAction =
  | { kind: 'hotel'; cityIndex: number; hotelIndex: number }
  | { kind: 'leg'; cityIndex: number; altIndex: number }
  | { kind: 'home'; direction: 'outbound' | 'return'; altIndex: number };

export type SaveOption = {
  id: string;
  /** "Cheaper hotel in Osaka" */
  title: string;
  /** "Hotel Chuo Bridge · ★ 7.9" */
  detail: string;
  /** Group total saved (same units as the header total). */
  savings: number;
  action: SaveAction;
};

/** Below this a switch isn't worth a row. */
const MIN_SAVING = 5;

const hotelTotal = (c: City, hotelIndex: number) =>
  effectiveHotel({ ...c, customHotel: undefined, selectedHotelIndex: hotelIndex, hotel: c.hotels[hotelIndex] }).total;

const priced = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0;

const clock = (t?: string | null) => (t ? t.slice(0, 5) : '');

export function waysToSave(trip: Trip): SaveOption[] {
  const out: SaveOption[] = [];

  trip.cities.forEach((c, ci) => {
    // Hotels: the cheapest bookable alternative to what is picked. A custom
    // hotel the traveller typed in is their choice, not ours to undercut.
    if (!c.customHotel && Array.isArray(c.hotels) && c.hotels.length > 1) {
      const now = effectiveHotel(c).total;
      let best: { j: number; saving: number } | null = null;
      c.hotels.forEach((h, j) => {
        if (j === c.selectedHotelIndex || !h?.name || !priced(h.pricePerNight)) return;
        const saving = now - hotelTotal(c, j);
        if (saving >= MIN_SAVING && (!best || saving > best.saving)) best = { j, saving };
      });
      if (best) {
        const { j, saving } = best as { j: number; saving: number };
        const h = c.hotels[j];
        out.push({
          id: `hotel:${ci}:${j}`,
          title: `Cheaper hotel in ${c.name}`,
          detail: [h.name, h.rating ? `★ ${h.rating}` : ''].filter(Boolean).join(' · '),
          savings: Math.round(saving),
          action: { kind: 'hotel', cityIndex: ci, hotelIndex: j },
        });
      }
    }

    // Inter-city leg out of this stay.
    const t = c.transportOut;
    const next = trip.cities[ci + 1];
    if (next && t && priced(t.price) && Array.isArray(t.alternatives)) {
      let best: { j: number; saving: number } | null = null;
      t.alternatives.forEach((a, j) => {
        if (!a || a.unavailable || !priced(a.price)) return;
        const saving = t.price - a.price;
        if (saving >= MIN_SAVING && (!best || saving > best.saving)) best = { j, saving };
      });
      if (best) {
        const { j, saving } = best as { j: number; saving: number };
        const a = t.alternatives[j];
        const mode = a.mode === t.mode ? `Another ${a.mode}` : `Take the ${a.mode}`;
        out.push({
          id: `leg:${ci}:${j}`,
          title: `${mode} ${c.name} → ${next.name}`,
          detail: [a.operator, clock(a.departTime)].filter(Boolean).join(' · '),
          savings: Math.round(saving),
          action: { kind: 'leg', cityIndex: ci, altIndex: j },
        });
      }
    }
  });

  // Flights out and home.
  for (const direction of ['outbound', 'return'] as const) {
    const leg = direction === 'outbound' ? trip.origin?.outboundLeg : trip.origin?.returnLeg;
    if (!leg || !priced(leg.price) || !Array.isArray(leg.alternatives)) continue;
    let best: { j: number; saving: number } | null = null;
    leg.alternatives.forEach((a, j) => {
      if (!a || !priced(a.price)) return;
      const saving = leg.price - a.price;
      if (saving >= MIN_SAVING && (!best || saving > best.saving)) best = { j, saving };
    });
    if (!best) continue;
    const { j, saving } = best as { j: number; saving: number };
    const a = leg.alternatives[j];
    out.push({
      id: `home:${direction}:${j}`,
      title: direction === 'outbound' ? 'Cheaper flight out' : 'Cheaper flight home',
      detail: [a.operator, `${a.originAirport}→${a.destAirport}`, clock(a.departTime), a.stops ? `${a.stops} stop${a.stops === 1 ? '' : 's'}` : 'nonstop']
        .filter(Boolean)
        .join(' · '),
      savings: Math.round(saving),
      action: { kind: 'home', direction, altIndex: j },
    });
  }

  return out.sort((a, b) => b.savings - a.savings);
}
