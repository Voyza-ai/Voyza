'use client';

import { useState } from 'react';
import { ExternalLink, MapPin } from 'lucide-react';
import type { DinnerPlan } from '@/lib/types';
import { nightLabel } from '@/lib/dinnerPlace';

/** Google Maps directions to the restaurant — by its address when known, else its name in its city. */
export function directionsUrl(d: Pick<DinnerPlan, 'restaurant' | 'city' | 'address'>): string {
  const to = d.address ? `${d.restaurant}, ${d.address}` : `${d.restaurant}, ${d.city}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(to)}`;
}

/** Google Maps search for the restaurant in its city: its page shows the address. */
export function placeUrl(d: Pick<DinnerPlan, 'restaurant' | 'city' | 'address'>): string {
  const q = d.address ? `${d.restaurant}, ${d.address}` : `${d.restaurant}, ${d.city}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * The reservation's address on demand: "Address" shows it (selectable, to
 * copy) with Directions; without a known address it opens the restaurant on
 * the map, where the address is.
 */
export function ReservationAddress({ dinner, color, size = 'sm' }: { dinner: DinnerPlan; color: string; size?: 'xs' | 'sm' }) {
  const [open, setOpen] = useState(false);
  const icon = size === 'xs' ? 8 : 9;
  if (!dinner.address) {
    return (
      <a
        href={placeUrl(dinner)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={stop}
        onMouseDown={stop}
        className="inline-flex items-center gap-0.5 font-semibold whitespace-nowrap hover:underline"
        style={{ color }}
        title={`Opens ${dinner.restaurant} on Google Maps, with its address`}
        data-testid="reservation-address-map"
      >
        <MapPin size={icon} /> Address
      </a>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseDown={stop}
        className="inline-flex items-center gap-0.5 font-semibold whitespace-nowrap hover:underline"
        style={{ color }}
        aria-expanded={open}
        data-testid="reservation-address-toggle"
      >
        <MapPin size={icon} /> {open ? 'Hide address' : 'Address'}
      </button>
      {open && (
        <span className="basis-full flex items-center gap-1.5 flex-wrap" onClick={stop} onMouseDown={stop} data-testid="reservation-address">
          <span className="select-text" style={{ color }}>
            {dinner.address}
          </span>
          <a
            href={directionsUrl(dinner)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-semibold whitespace-nowrap hover:underline"
            style={{ color: '#2e6bc4' }}
            data-testid="reservation-directions"
          >
            Directions <ExternalLink size={icon} />
          </a>
        </span>
      )}
    </>
  );
}

/**
 * "Not booked yet" + Reserve, for a dinner plan wherever the trip shows it
 * (schedule day cards, the day planner, the calendar, the city guide). The
 * dashed outline is the product's own "not settled yet" line — the dashed
 * route — in the city's colour. The link opens the restaurant where the
 * traveller books it; nothing in BlueMurr books a table.
 */
export default function DinnerBadge({
  dinner,
  accent,
  size = 'sm',
  showReserve = true,
}: {
  dinner: DinnerPlan;
  accent: string;
  size?: 'xs' | 'sm';
  showReserve?: boolean;
}) {
  const text = size === 'xs' ? 'text-[9px]' : 'text-[10px]';
  return (
    <span className={`inline-flex items-center gap-1.5 flex-wrap ${text}`} data-testid="dinner-badge">
      <span
        className="font-medium px-1.5 py-[1px] rounded whitespace-nowrap"
        style={{ color: accent, border: `1px dashed ${accent}aa`, background: '#ffffffaa' }}
      >
        Not booked yet
      </span>
      {showReserve && (
        <a
          href={dinner.reserveUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-0.5 font-semibold whitespace-nowrap hover:underline"
          style={{ color: '#2e6bc4' }}
          title={`Opens ${dinner.restaurant} on ${dinner.reserveVia} — book the table there`}
          data-testid="dinner-badge-reserve"
        >
          Reserve <ExternalLink size={size === 'xs' ? 8 : 9} />
        </a>
      )}
      {showReserve && <ReservationAddress dinner={dinner} color="#2e6bc4" size={size} />}
      {dinner.movedFrom && (
        <span className="whitespace-nowrap" style={{ color: `${accent}99` }} data-testid="dinner-moved">
          moved from {nightLabel(dinner.movedFrom)} — your dates changed
        </span>
      )}
    </span>
  );
}
