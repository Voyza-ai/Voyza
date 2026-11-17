'use client';

import { Fragment } from 'react';
import { Plane, TrainFront, Home, Loader2, ChevronRight, Plus, Minus, X as XIcon, Hotel as HotelIcon } from 'lucide-react';
import type { City, Transport, Trip } from '@/lib/types';
import { getCityColor, HOME_COLOR } from '@/lib/cityColors';
import { effectiveHotel, displayAmount } from '@/lib/tripTotals';
import { nightsBetween } from '@/lib/hotelScore';
import { humanDay } from '@/lib/dateHelpers';
import { VIBE_LABEL } from '@/lib/cityTheme';
import { hasStay } from '@/components/results/CityCard';
import { homeLegToTransport } from '@/components/results/Flowchart';
import { useTripStore } from '@/store/tripStore';
import { M, dashedRoute } from './theme';

/** Which leg a tap opened: a city→city leg (by from-city index) or a home flight. */
export type LegRef = { kind: 'city'; index: number } | { kind: 'outbound' } | { kind: 'return' };

/** The Transport a leg ref points at on this trip, or null when there is none yet. */
export function legTransport(trip: Trip, ref: LegRef): Transport | null {
  if (ref.kind === 'city') return trip.cities[ref.index]?.transportOut ?? null;
  const o = trip.origin;
  if (!o?.city || trip.cities.length === 0) return null;
  if (ref.kind === 'outbound') return o.outboundLeg ? homeLegToTransport(o.outboundLeg, o.city, trip.cities[0].name) : null;
  const last = trip.cities[trip.cities.length - 1];
  return o.returnLeg ? homeLegToTransport(o.returnLeg, last.name, o.returnCity ?? o.city) : null;
}

type Props = {
  trip: Trip;
  editable: boolean;
  homeLegSearch: { outbound: boolean; return: boolean };
  refreshingLegs: string[];
  onOpenCity: (index: number) => void;
  onOpenLeg: (ref: LegRef) => void;
  onNightsChange: (index: number, nights: number) => void;
  onAddCity: () => void;
  onEditHome: (direction: 'outbound' | 'inbound') => void;
};

/**
 * The flowchart, turned vertical for a phone: the home card, then each stay
 * as a pastel city card, with the dashed route running down between them and
 * the leg's transport pill on it. Tap a city for its guide, a leg for its
 * details and options.
 */
export default function MobileItinerary({
  trip,
  editable,
  homeLegSearch,
  refreshingLegs,
  onOpenCity,
  onOpenLeg,
  onNightsChange,
  onAddCity,
  onEditHome,
}: Props) {
  const origin = trip.origin?.city ? trip.origin : null;
  const last = trip.cities.length - 1;

  return (
    <div className="px-4 pt-3 pb-8" data-testid="m-itinerary">
      {origin && (
        <>
          <HomeRow
            label="Leaving from"
            city={origin.city}
            date={origin.outboundLeg?.departDate}
            airports={origin.airports}
            onEdit={editable ? () => onEditHome('outbound') : undefined}
          />
          <LegRow
            transport={legTransport(trip, { kind: 'outbound' })}
            searching={homeLegSearch.outbound}
            onOpen={() => onOpenLeg({ kind: 'outbound' })}
            color="#9ca3af"
          />
        </>
      )}

      {trip.cities.map((city, i) => (
        <Fragment key={`${city.name}-${i}`}>
          <CityRow
            city={city}
            index={i}
            travelers={trip.travelers}
            onOpen={() => onOpenCity(i)}
            onNightsChange={editable ? (n) => onNightsChange(i, n) : undefined}
          />
          {i < last && (
            <LegRow
              transport={city.transportOut}
              searching={refreshingLegs.includes(`${city.name}→${trip.cities[i + 1].name}`)}
              onOpen={() => onOpenLeg({ kind: 'city', index: i })}
              color={getCityColor(city.colorIndex ?? i).text}
              legDate={city.dates.departure}
            />
          )}
        </Fragment>
      ))}

      {origin && trip.returnToHome && (
        <>
          <LegRow
            transport={legTransport(trip, { kind: 'return' })}
            searching={homeLegSearch.return}
            onOpen={() => onOpenLeg({ kind: 'return' })}
            color="#9ca3af"
          />
          <HomeRow
            label="Back home"
            city={origin.returnCity ?? origin.city}
            date={origin.returnLeg?.arriveDate ?? origin.returnLeg?.departDate}
            airports={origin.returnAirports ?? origin.airports}
            onEdit={editable ? () => onEditHome('inbound') : undefined}
          />
        </>
      )}

      {editable && (
        <button
          onClick={onAddCity}
          className="mt-4 w-full min-h-[52px] flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-[15px] font-medium"
          style={{ borderColor: 'rgba(37,99,235,0.35)', color: M.blue, background: 'rgba(37,99,235,0.04)' }}
          data-testid="m-add-city"
        >
          <Plus size={17} /> Add a city
        </button>
      )}
    </div>
  );
}

function HomeRow({
  label,
  city,
  date,
  airports,
  onEdit,
}: {
  label: string;
  city: string;
  date?: string | null;
  airports?: string[];
  onEdit?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-2xl border-2 px-4 py-3"
      style={{ background: HOME_COLOR.bg, borderColor: HOME_COLOR.border, color: HOME_COLOR.text }}
      data-testid="m-home-card"
    >
      <span className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.6)' }}>
        <Home size={18} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] uppercase tracking-wider opacity-70">{label}</div>
        <div className="text-[17px] font-semibold leading-tight truncate">{city}</div>
        <div className="text-[12px] opacity-80 truncate">
          {[date ? humanDay(date) : null, airports && airports.length > 0 ? airports.slice(0, 3).join(' · ') : null].filter(Boolean).join('  ·  ')}
        </div>
      </div>
      {onEdit && (
        <button onClick={onEdit} className="min-h-[44px] px-3 rounded-full text-[13px] font-medium" style={{ background: 'rgba(255,255,255,0.6)' }}>
          Change
        </button>
      )}
    </div>
  );
}

function CityRow({
  city,
  index,
  travelers,
  onOpen,
  onNightsChange,
}: {
  city: City;
  index: number;
  travelers: number;
  onOpen: () => void;
  onNightsChange?: (nights: number) => void;
}) {
  const priceMode = useTripStore((s) => s.priceMode);
  const color = getCityColor(city.colorIndex ?? index);
  const nights = city.dates.arrival && city.dates.departure ? nightsBetween(city.dates.arrival, city.dates.departure) : 0;
  const eff = effectiveHotel(city);
  const stay = isNaN(eff.total) ? 0 : displayAmount(eff.total, priceMode, travelers);
  const hotelName = city.customHotel?.name ?? city.hotels?.[city.selectedHotelIndex]?.name ?? city.hotel?.name;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      className="relative rounded-3xl border-2 px-5 pt-4 pb-3 active:scale-[0.99] transition-transform outline-none"
      style={{ background: color.bg, borderColor: color.border, color: color.text }}
      data-testid="m-city-card"
      aria-label={`${city.name}, open guide`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium opacity-70">{String(index + 1).padStart(2, '0')} · {city.country}</div>
          <h3 className="text-[24px] font-semibold leading-tight">{city.name}</h3>
          <div className="text-[13px] mt-0.5 opacity-85">
            {city.dates.arrival ? humanDay(city.dates.arrival) : '—'} → {city.dates.departure ? humanDay(city.dates.departure) : '—'}
          </div>
        </div>
        {hasStay(city) && (
          <div className="flex flex-col items-end px-2.5 py-1.5 rounded-xl border tabular-nums" style={{ background: 'rgba(255,255,255,0.65)', borderColor: 'rgba(0,0,0,0.1)' }}>
            <span className="text-[9px] uppercase tracking-wider opacity-60">Stay</span>
            <span className="text-[16px] font-bold leading-none">${stay.toLocaleString()}</span>
          </div>
        )}
      </div>

      {city.vibes && city.vibes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {city.vibes.slice(0, 3).map((v) => (
            <span key={v} className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.7)' }}>
              {VIBE_LABEL[v]}
            </span>
          ))}
        </div>
      )}

      {hotelName && (
        <div className="mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[13px]" style={{ background: `${color.text}12` }}>
          <HotelIcon size={14} className="flex-shrink-0 opacity-70" />
          <span className="truncate font-medium">{hotelName}</span>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        {onNightsChange && nights > 0 ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              aria-label={`One night fewer in ${city.name}`}
              disabled={nights <= 1}
              onClick={() => onNightsChange(nights - 1)}
              className="w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-30"
              style={{ background: 'rgba(255,255,255,0.65)' }}
            >
              <Minus size={15} />
            </button>
            <span className="min-w-[64px] text-center text-[14px] font-medium" data-testid="m-nights">
              {nights} {nights === 1 ? 'night' : 'nights'}
            </span>
            <button
              aria-label={`One more night in ${city.name}`}
              onClick={() => onNightsChange(nights + 1)}
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.65)' }}
            >
              <Plus size={15} />
            </button>
          </div>
        ) : (
          <span className="text-[14px] font-medium">{nights} {nights === 1 ? 'night' : 'nights'}</span>
        )}
        <span className="ml-auto flex items-center gap-0.5 text-[13px] font-medium opacity-80">
          Guide <ChevronRight size={15} />
        </span>
      </div>
    </div>
  );
}

function LegRow({
  transport,
  searching,
  onOpen,
  color,
  legDate,
}: {
  transport: Transport | null;
  searching: boolean;
  onOpen: () => void;
  color: string;
  legDate?: string;
}) {
  const priceMode = useTripStore((s) => s.priceMode);
  const travelers = useTripStore((s) => s.currentTrip?.travelers ?? 1);

  let pill: React.ReactNode;
  if (searching) {
    pill = (
      <span className="flex items-center gap-2 text-[13px] text-gray-500">
        <Loader2 size={14} className="animate-spin" /> Finding options…
      </span>
    );
  } else if (!transport || (!transport.operator && !transport.price && !transport.unavailable)) {
    pill = <span className="text-[13px] text-gray-500">No travel booked yet</span>;
  } else if (transport.unavailable) {
    pill = (
      <span className="flex items-center gap-2 text-[13px] text-gray-600">
        <XIcon size={14} /> No direct option — tap for ideas
      </span>
    );
  } else {
    const isFlight = transport.mode === 'flight';
    const Icon = isFlight ? Plane : TrainFront;
    const accent = isFlight ? M.flight : M.train;
    const price = displayAmount(transport.price, priceMode, travelers);
    const date = transport.departDate ?? legDate;
    pill = (
      <span className="flex items-center gap-2.5 min-w-0">
        <span className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${accent}18`, color: accent }}>
          <Icon size={15} />
        </span>
        <span className="flex flex-col min-w-0 text-left">
          <span className="text-[14px] font-semibold text-gray-900 truncate">
            {transport.operator || (isFlight ? 'Flight' : 'Train')}
            {transport.departTime ? ` · ${transport.departTime}` : ''}
          </span>
          <span className="text-[12px] text-gray-500 truncate">
            {[date ? humanDay(date) : null, transport.duration || null, isFlight && typeof transport.layovers === 'number' ? (transport.layovers === 0 ? 'Nonstop' : `${transport.layovers} stop${transport.layovers > 1 ? 's' : ''}`) : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className="ml-auto pl-2 text-[15px] font-bold tabular-nums" style={{ color: accent }}>${price.toLocaleString()}</span>
      </span>
    );
  }

  return (
    <div className="relative flex items-stretch min-h-[76px]" data-testid="m-leg">
      {/* The dashed route, running down the card column's left third. */}
      <div className="w-10 flex-shrink-0 flex justify-center">
        <span className="block w-[2px] h-full" style={{ backgroundImage: dashedRoute(`${color}aa`) }} aria-hidden />
      </div>
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 my-2.5 flex items-center gap-2 rounded-2xl bg-white border px-3 py-2 min-h-[52px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] active:bg-gray-50"
        style={{ borderColor: M.line }}
        aria-label="Leg details"
      >
        {pill}
        <ChevronRight size={16} className="flex-shrink-0 text-gray-400" />
      </button>
    </div>
  );
}
