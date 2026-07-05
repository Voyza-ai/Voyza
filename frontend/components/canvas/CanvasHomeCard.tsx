'use client';

import { Home, Plane, Pencil, Loader2 } from 'lucide-react';
import { getAirportName } from '@/lib/airportNames';

type CanvasHomeCardProps = {
  origin: {
    city: string;
    airports: string[];
    outboundLeg?: any;
    returnLeg?: any;
    /** Independent back-home overrides — set when the user edits the
     *  back-home card. Fall back to the shared city/airports. */
    returnCity?: string;
    returnAirports?: string[];
  };
  direction: 'outbound' | 'inbound';
  /** Opens the edit popup for this card. Absent for viewers. */
  onEdit?: () => void;
  /** True while this direction's flight is being re-searched. */
  legLoading?: boolean;
};

const HOME_COLOR = {
  bg: '#FDE2E2',
  text: '#7C1A1A',
  border: '#F0B8B8',
};

export default function CanvasHomeCard({ origin, direction, onEdit, legLoading }: CanvasHomeCardProps) {
  const isInbound = direction === 'inbound';
  const leg = isInbound ? origin.returnLeg : origin.outboundLeg;

  // The two cards are independent: the back-home card prefers its own
  // returnCity/returnAirports when the user has customized them.
  const city = isInbound ? origin.returnCity ?? origin.city : origin.city;
  const airports = isInbound
    ? origin.returnAirports ?? origin.airports
    : origin.airports;
  const airport = isInbound
    ? leg?.destAirport ?? airports?.[0] ?? ''
    : leg?.originAirport ?? airports?.[0] ?? '';

  const airportName = airport ? getAirportName(airport) : null;
  const label = isInbound ? 'Back home' : 'Home';
  const time = isInbound ? leg?.arriveTime : leg?.departTime;
  const date = leg?.departDate ?? '';

  const formatDate = (iso: string) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (isNaN(y)) return '';
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <div
      className="flex-shrink-0 w-[200px] rounded-2xl border-2 overflow-hidden group"
      style={{
        background: HOME_COLOR.bg,
        borderColor: HOME_COLOR.border,
      }}
    >
      {/* Header bar */}
      <div
        className="px-4 py-2 flex items-center gap-2"
        style={{ background: `${HOME_COLOR.text}18` }}
      >
        <Home size={12} style={{ color: HOME_COLOR.text }} />
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: HOME_COLOR.text }}>
          {label}
        </span>
        {onEdit && (
          <button
            onClick={onEdit}
            title={`Edit ${label.toLowerCase()} card`}
            className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-white/40"
          >
            <Pencil size={11} style={{ color: HOME_COLOR.text }} />
          </button>
        )}
      </div>

      {/* City */}
      <div className="px-4 pt-3 pb-1">
        <div className="text-[16px] font-semibold" style={{ color: HOME_COLOR.text }}>
          {city}
        </div>
      </div>

      {/* Airport */}
      <div className="px-4 pb-1">
        <div className="text-[11px]" style={{ color: `${HOME_COLOR.text}aa` }}>
          {airportName ?? (airport || 'No airport')}
        </div>
        {airport && (
          <div className="text-[10px] font-mono" style={{ color: `${HOME_COLOR.text}77` }}>
            {airport}
            {airports.length > 1 && (
              <span style={{ color: `${HOME_COLOR.text}55` }}>
                {' '}+{airports.length - 1} more
              </span>
            )}
          </div>
        )}
      </div>

      {/* Date + Time */}
      <div className="px-4 pb-3 flex items-center gap-2">
        {date && (
          <span className="text-[11px]" style={{ color: `${HOME_COLOR.text}99` }}>
            {formatDate(date)}
          </span>
        )}
        {time && (
          <span className="text-[12px] font-mono font-medium" style={{ color: HOME_COLOR.text }}>
            {time}
          </span>
        )}
      </div>

      {/* Flight pill — live price, or a searching state during re-search */}
      {legLoading ? (
        <div
          className="mx-3 mb-3 px-3 py-1.5 rounded-lg flex items-center gap-2"
          style={{ background: `${HOME_COLOR.text}12` }}
        >
          <Loader2 size={10} className="animate-spin" style={{ color: HOME_COLOR.text }} />
          <span className="text-[11px]" style={{ color: `${HOME_COLOR.text}aa` }}>
            Finding flight…
          </span>
        </div>
      ) : (
        leg?.price > 0 && (
          <div
            className="mx-3 mb-3 px-3 py-1.5 rounded-lg flex items-center gap-2"
            style={{ background: `${HOME_COLOR.text}12` }}
          >
            <Plane size={10} style={{ color: HOME_COLOR.text }} />
            <span className="text-[11px] font-semibold" style={{ color: HOME_COLOR.text }}>
              ${leg.price}
            </span>
            {leg.durationMinutes > 0 && (
              <span className="text-[10px] ml-auto" style={{ color: `${HOME_COLOR.text}88` }}>
                {Math.floor(leg.durationMinutes / 60)}h {leg.durationMinutes % 60}m
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}
