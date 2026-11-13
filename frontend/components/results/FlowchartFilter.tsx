'use client';

import { motion } from 'framer-motion';
import { Route, Building2, MapPin, Loader2 } from 'lucide-react';
import { City, Trip } from '@/lib/types';
import { getCityColor } from '@/lib/cityColors';
import { hasStay } from './CityCard';
import { MODE_COLORS } from './Connector';

/**
 * Type filter inside the Flowchart tab: All · Travel · Hotels · Activities.
 * The city sequence and the dashed-route spine stay on screen in every state;
 * only the cards change (see Flowchart).
 */
export type FlowchartFilter = 'all' | 'travel' | 'hotels' | 'activities';

export const FLOWCHART_FILTERS: FlowchartFilter[] = ['all', 'travel', 'hotels', 'activities'];

/** `?show=` value → filter. `flights` is the chip's old name; anything unknown is All. */
export function parseFlowchartFilter(value: string | null | undefined): FlowchartFilter {
  if (value === 'flights') return 'travel';
  return (FLOWCHART_FILTERS as string[]).includes(value ?? '') ? (value as FlowchartFilter) : 'all';
}

/**
 * The `?show=` the flowchart opens on. Read from the address bar itself on
 * the client: a tab switch writes it back just before the flowchart mounts,
 * and Next's own search params catch up a render later.
 */
export function readShowParam(fallback: URLSearchParams | null | undefined): string | null {
  if (typeof window !== 'undefined') return new URLSearchParams(window.location.search).get('show');
  return fallback?.get('show') ?? null;
}

const replaceUrl = (url: URL) =>
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);

/** Put the filter in `?show=` (none for All). Leaves the URL alone when it already says so. */
export function writeShowParam(filter: FlowchartFilter): void {
  try {
    const url = new URL(window.location.href);
    const want = filter === 'all' ? null : filter;
    if (url.searchParams.get('show') === want) return;
    if (want) url.searchParams.set('show', want);
    else url.searchParams.delete('show');
    replaceUrl(url);
  } catch {
    // URL sync is a convenience; the filter itself already changed
  }
}

// `?show=` taken off the URL while another tab is open, put back on return.
let parkedShow: string | null = null;

/**
 * Results-page tab change: `?show=` belongs to the Flowchart tab only.
 * Calendar, Schedule and Map drop it; coming back to the Flowchart puts it
 * back, so the flowchart opens on the filter it was left on.
 */
export function syncShowParamForTab(view: string): void {
  try {
    const url = new URL(window.location.href);
    if (view === 'flowchart') {
      if (!parkedShow) return;
      url.searchParams.set('show', parkedShow);
      parkedShow = null;
    } else {
      const show = url.searchParams.get('show');
      if (!show) return;
      parkedShow = show;
      url.searchParams.delete('show');
    }
    replaceUrl(url);
  } catch {
    // as above
  }
}

/** Tests only: forget a parked `?show=`. */
export function resetParkedShowParam(): void {
  parkedShow = null;
}

/**
 * What each chip would show:
 *  - travel: every leg of the journey, any mode, the home flights included;
 *  - hotels: stays with a hotel picked;
 *  - activities: activities + restaurants, the same number the cards' badges add up to.
 */
export function flowchartFilterCounts(trip: Trip): Record<Exclude<FlowchartFilter, 'all'>, number> {
  const home = trip.origin?.city ? 1 + (trip.returnToHome ? 1 : 0) : 0;
  return {
    travel: Math.max(0, trip.cities.length - 1) + home,
    hotels: trip.cities.filter(hasStay).length,
    activities: trip.cities.reduce((n, c) => n + c.activities.length + c.restaurants.length, 0),
  };
}

const CHIPS: { id: FlowchartFilter; label: string; icon?: typeof Route }[] = [
  { id: 'all', label: 'All' },
  { id: 'travel', label: 'Travel', icon: Route },
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

const EMPTY_COPY: Record<Exclude<FlowchartFilter, 'all'>, string> = {
  travel: 'No travel legs on this trip.',
  hotels: 'No hotels picked yet — open a city to choose one.',
  activities: 'No activities yet — ask BlueMurr AI to add some.',
};

/**
 * One quiet line beside the chips when the chosen filter has nothing to show
 * (count 0). While the AI picks are still on their way, Activities says so —
 * the cities' loading cards stay on the spine underneath.
 */
export function FlowchartFilterEmpty({
  filter,
  loading = false,
}: {
  filter: Exclude<FlowchartFilter, 'all'>;
  loading?: boolean;
}) {
  const Icon = CHIPS.find((c) => c.id === filter)?.icon ?? Route;
  return (
    <div role="status" data-filter-empty={filter} className="flex items-center gap-1.5 text-[12px] text-gray-500">
      {loading ? (
        <Loader2 size={12} className="animate-spin" style={{ color: '#2563eb' }} />
      ) : (
        <Icon size={12} className="text-gray-400" />
      )}
      <span>{loading ? 'BlueMurr AI is still picking activities…' : EMPTY_COPY[filter]}</span>
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
  stacked = false,
  isActive,
  isDimmed,
  onHover,
  onLeave,
  onClick,
}: {
  city: City;
  index: number;
  /** px — 136 between Travel's legs, 300 to sit over an Activities card. */
  width: number;
  /** Dates and nights on lines of their own, for the narrow Travel node. */
  stacked?: boolean;
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
  const nightsLabel = `${nights} ${nights === 1 ? 'night' : 'nights'}`;
  return (
    <motion.div
      animate={{ opacity: isDimmed ? 0.35 : 1, scale: isActive ? 1.04 : 1 }}
      transition={{ opacity: { duration: 0.25 }, scale: { type: 'spring', stiffness: 260, damping: 22 } }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
      tabIndex={0}
      title={city.name}
      data-compact-city={city.name}
      className={`relative flex-shrink-0 rounded-2xl border-2 cursor-pointer overflow-hidden outline-none py-3 transition-colors duration-300 ${
        stacked ? 'px-3' : 'px-4'
      }`}
      style={{ width, background: color.bg, borderColor: isActive ? color.text : color.border }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3
          className={`${stacked ? 'text-[15px]' : 'text-[17px]'} font-semibold leading-tight truncate`}
          style={{ color: color.text }}
        >
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
        {!stacked && <span style={{ color: `${color.text}aa` }}>· {nightsLabel}</span>}
      </div>
      {stacked && (
        <div className="mt-0.5 text-[12px] whitespace-nowrap" style={{ color: `${color.text}aa` }}>
          {nightsLabel}
        </div>
      )}
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
