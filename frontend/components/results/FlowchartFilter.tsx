'use client';

import { motion } from 'framer-motion';
import { Plane, Building2, MapPin } from 'lucide-react';
import { City, Trip } from '@/lib/types';
import { getCityColor } from '@/lib/cityColors';
import { hasStay } from './CityCard';
import { MODE_COLORS } from './Connector';

/**
 * Type filter inside the Flowchart tab: All · Flights · Hotels · Activities.
 * The city sequence and the dashed-route spine stay on screen in every state;
 * only the cards change (see Flowchart). MOCK for design approval.
 */
export type FlowchartFilter = 'all' | 'flights' | 'hotels' | 'activities';

export const FLOWCHART_FILTERS: FlowchartFilter[] = ['all', 'flights', 'hotels', 'activities'];

/** `?show=` value → filter. Anything unknown is All. */
export function parseFlowchartFilter(value: string | null | undefined): FlowchartFilter {
  return (FLOWCHART_FILTERS as string[]).includes(value ?? '') ? (value as FlowchartFilter) : 'all';
}

/**
 * What each chip would show:
 *  - flights: legs with a transport on them (home legs included, "no direct
 *    option" legs not) — a train leg counts too;
 *  - hotels: stays with a hotel picked;
 *  - activities: activities + restaurants, the same number the cards' badges add up to.
 */
export function flowchartFilterCounts(trip: Trip): Record<Exclude<FlowchartFilter, 'all'>, number> {
  let flights = 0;
  if (trip.origin?.city && trip.origin.outboundLeg) flights += 1;
  trip.cities.forEach((c, i) => {
    if (i < trip.cities.length - 1 && c.transportOut && !c.transportOut.unavailable) flights += 1;
  });
  if (trip.origin?.city && trip.returnToHome && trip.origin.returnLeg) flights += 1;
  return {
    flights,
    hotels: trip.cities.filter(hasStay).length,
    activities: trip.cities.reduce((n, c) => n + c.activities.length + c.restaurants.length, 0),
  };
}

const CHIPS: { id: FlowchartFilter; label: string; icon?: typeof Plane }[] = [
  { id: 'all', label: 'All' },
  { id: 'flights', label: 'Flights', icon: Plane },
  { id: 'hotels', label: 'Hotels', icon: Building2 },
  { id: 'activities', label: 'Activities', icon: MapPin },
];

/**
 * The chip row. Same segmented-pill shape as ViewTabs (and the header's
 * Total / Per person toggle), inverted for the light canvas: white track,
 * brand-blue active pill. Icons are the ones the cards themselves use.
 */
export function FlowchartFilterChips({
  value,
  onChange,
  counts,
}: {
  value: FlowchartFilter;
  onChange: (f: FlowchartFilter) => void;
  counts: Record<Exclude<FlowchartFilter, 'all'>, number>;
}) {
  return (
    <div
      role="group"
      aria-label="Show in flowchart"
      className="inline-flex items-center gap-0.5 p-0.5 rounded-full border bg-white"
      style={{ borderColor: 'rgba(37,99,235,0.22)' }}
    >
      {CHIPS.map((chip) => {
        const Icon = chip.icon;
        const active = value === chip.id;
        const count = chip.id === 'all' ? null : counts[chip.id];
        return (
          <button
            key={chip.id}
            type="button"
            data-filter-chip={chip.id}
            aria-pressed={active}
            onClick={() => onChange(chip.id)}
            className={`relative flex items-center gap-1.5 px-3 py-1 text-[12px] rounded-full transition-colors ${
              active ? 'text-white' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {active && (
              <motion.div
                layoutId="active-flowchart-filter"
                className="absolute inset-0 rounded-full"
                style={{ background: '#2563eb' }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
            {Icon && <Icon size={12} className="relative z-10" />}
            <span className="relative z-10 font-medium">{chip.label}</span>
            {count !== null && (
              <span
                className="relative z-10 text-[11px] tabular-nums"
                style={{ color: active ? 'rgba(255,255,255,0.75)' : '#9ca3af' }}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const nightsBetween = (a: string, b: string) => {
  const p = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1).getTime();
  };
  return Math.round((p(b) - p(a)) / 86_400_000);
};

/**
 * A city shrunk to its name and dates — the CityCard's own palette, type and
 * number, without the stay. Used where the filter hides hotel details.
 */
export function CompactCityNode({
  city,
  index,
  width,
  isActive,
  isDimmed,
  onHover,
  onLeave,
  onClick,
}: {
  city: City;
  index: number;
  /** px — 200 beside expanded flights, 300 to sit over an Activities card. */
  width: number;
  isActive: boolean;
  isDimmed: boolean;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const color = getCityColor(city.colorIndex ?? index);
  const arrival = city.dates.arrival ? formatDate(city.dates.arrival) : '';
  const departure = city.dates.departure ? formatDate(city.dates.departure) : '';
  const nights =
    city.dates.arrival && city.dates.departure ? nightsBetween(city.dates.arrival, city.dates.departure) : 0;
  return (
    <motion.div
      animate={{ opacity: isDimmed ? 0.35 : 1, scale: isActive ? 1.04 : 1 }}
      transition={{ opacity: { duration: 0.25 }, scale: { type: 'spring', stiffness: 260, damping: 22 } }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
      tabIndex={0}
      data-compact-city={city.name}
      className="relative flex-shrink-0 rounded-2xl border-2 cursor-pointer overflow-hidden outline-none px-4 py-3 transition-colors duration-300"
      style={{ width, background: color.bg, borderColor: isActive ? color.text : color.border }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[17px] font-semibold leading-tight truncate" style={{ color: color.text }}>
          {city.name}
        </h3>
        <span className="text-[11px] font-medium leading-none flex-shrink-0" style={{ color: color.text }}>
          {String(index + 1).padStart(2, '0')}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 text-[12px] whitespace-nowrap" style={{ color: `${color.text}cc` }}>
        <span>{arrival}</span>
        <span style={{ color: `${color.text}88` }}>→</span>
        <span>{departure}</span>
        <span style={{ color: `${color.text}aa` }}>
          · {nights} {nights === 1 ? 'night' : 'nights'}
        </span>
      </div>
    </motion.div>
  );
}

/**
 * A leg shrunk to the bare dashed route — the Connector's own dashes in the
 * leg's mode colour (grey for a leg with no option), no pill, no price.
 */
export function PlainRoute({ mode, muted = false }: { mode?: string; muted?: boolean }) {
  const c = muted ? '#888888' : MODE_COLORS[mode ?? 'flight'] ?? '#2e6bc4';
  return (
    <div className="flex items-center flex-shrink-0 mx-2" data-plain-route>
      <div
        className="w-[96px] h-[2px]"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, ${c}aa 0px, ${c}aa 6px, transparent 6px, transparent 11px)`,
        }}
      />
    </div>
  );
}
