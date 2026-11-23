'use client';

import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import type { Trip } from '@/lib/types';
import { formatGroundRange } from '@/lib/groundEstimate';

/**
 * One line under the results header naming what the search could NOT price:
 * the flights from or back home, a leg between cities, or a city's hotel.
 *
 * Without it a destination nothing flies to (Tristan da Cunha) came back as a
 * normal-looking result with "TOTAL TRIP $0" and no word of explanation. The
 * cards still show "No direct option" / "No options found"; this says what
 * that means for the total. Same quiet style as NoRailDataNotice.
 */
export function missingPriceParts(trip: Pick<Trip, 'cities' | 'origin' | 'returnToHome'>): string[] {
  const cities = trip.cities ?? [];
  if (cities.length === 0) return [];
  const parts: string[] = [];
  const first = cities[0].name;
  const last = cities[cities.length - 1].name;
  if (trip.origin) {
    if (!trip.origin.outboundLeg) parts.push(`flights from ${trip.origin.city} to ${first}`);
    if (trip.returnToHome !== false && !trip.origin.returnLeg) {
      parts.push(`flights from ${last} back to ${trip.origin.returnCity ?? trip.origin.city}`);
    }
  }
  cities.slice(0, -1).forEach((c, i) => {
    // A hop with only absurd flights (no sensible one) is not "no way" there:
    // the card gives a train-or-bus estimate; the total leaves the leg out.
    // A hop with nothing bookable but a ground estimate gets its own line (estimatedLegNotes).
    if (c.transportOut?.unavailable && !(c.transportOut.groundEstimate && !c.transportOut.noSensibleFlight)) {
      parts.push(c.transportOut.noSensibleFlight ? `a sensible flight from ${c.name} to ${cities[i + 1].name}` : `a way from ${c.name} to ${cities[i + 1].name}`);
    }
  });
  // A city with nothing found keeps an empty placeholder hotel ({ name: '' }).
  const noHotel = cities.filter((c) => !c.hotel?.name && (c.hotels?.length ?? 0) === 0).map((c) => c.name);
  // "a hotel in London or Paris" — not "London, Paris", which reads as one place.
  if (noHotel.length > 0) parts.push(`a hotel in ${noHotel.length === 1 ? noHotel[0] : `${noHotel.slice(0, -1).join(', ')} or ${noHotel[noHotel.length - 1]}`}`);
  return parts;
}

/**
 * One line per leg with nothing bookable but a train-or-bus estimate:
 * "Lisbon → Sintra: no bookable train or flight; about 35–45 min by train or
 * bus (estimate), not in the total."
 */
export function estimatedLegNotes(trip: Pick<Trip, 'cities'>): string[] {
  const cities = trip.cities ?? [];
  return cities.slice(0, -1).flatMap((c, i) => {
    const t = c.transportOut;
    if (!t?.unavailable || t.noSensibleFlight || !t.groundEstimate) return [];
    return [`${c.name} → ${cities[i + 1].name}: no bookable train or flight; about ${formatGroundRange(t.groundEstimate.minutes)} by train or bus (estimate), not in the total.`];
  });
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

export default function MissingPricesNotice({
  trip,
}: {
  trip: Pick<Trip, 'cities' | 'origin' | 'returnToHome'>;
}) {
  const [dismissed, setDismissed] = useState(false);
  const parts = missingPriceParts(trip);
  const notes = estimatedLegNotes(trip);
  if (dismissed || (parts.length === 0 && notes.length === 0)) return null;

  return (
    <div className="mx-8 mt-3 mb-1" role="note" data-testid="missing-prices-notice">
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-xl border bg-white"
        style={{ borderColor: 'rgba(0,0,0,0.08)' }}
      >
        <AlertTriangle size={13} style={{ color: '#f59e0b' }} className="flex-shrink-0" />
        <span className="flex-1 min-w-0 text-gray-600 text-[12px]">
          {parts.length > 0 && (
            <>
              We couldn&apos;t find {joinParts(parts)}, so the total leaves {parts.length === 1 ? 'it' : 'them'} out. Try a bigger city nearby or
              other dates.
            </>
          )}
          {notes.map((n) => (
            <span key={n} className="block" data-testid="estimated-leg-note">
              {n}
            </span>
          ))}
        </span>
        <button
          onClick={() => setDismissed(true)}
          className="flex-shrink-0 text-gray-400 hover:text-gray-700 transition-colors p-0.5"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
