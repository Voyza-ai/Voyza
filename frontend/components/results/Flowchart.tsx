'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
// PenSquare and Link were left over from before the Edit-in-Canvas button
// got consolidated into ResultsHeader (backend_gohiltalla). Keeping the
// `Transport` type — still referenced by the homeLegToTransport helper
// further down in this file.
import { ChevronLeft, ChevronRight, Home } from 'lucide-react';
import { Trip, HomeLeg, Transport } from '@/lib/types';
import CityCard from './CityCard';
import CityActivitiesCard from './CityActivitiesCard';
import Connector from './Connector';
import { useTripStore } from '@/store/tripStore';
import { getAirportName } from '@/lib/airportNames';

/**
 * Kept as a constant because some downstream calculations use it,
 * but the alignment strategy no longer hinges on it. Alignment works
 * like this: the parent scroll container uses items-stretch, so
 * every row (city column + connector, or home card + connector)
 * stretches to the tallest row's height. Within each row, both
 * children also use items-stretch so they fill that height. The
 * connector and home-card inner content use items-center so they
 * sit at the EXACT vertical middle of every row — which is the same
 * Y across the entire flowchart, regardless of how tall individual
 * activity columns get.
 */
const MAIN_CARD_HEIGHT = 320;
/**
 * HomeCard dimensions. Slightly smaller than a CityCard (which is
 * 300×~320) so the home anchors read as "bookends" rather than full
 * destinations. Still large enough to surface the specific airport,
 * date, and time for the leg that touches home.
 */
const HOME_CARD_WIDTH = 260;
const HOME_CARD_HEIGHT = 280;
/**
 * Flat red palette for the home-anchor cards. Matches the pastel
 * theme in `cityColors.ts` — solid background, darker text color,
 * mid-tone border. No gradient; same visual language as CityCard.
 */
const HOME_COLOR = {
  bg: '#FDE2E2',
  text: '#7C1A1A',
  border: '#F0B8B8',
};

type FlowchartProps = {
  trip: Trip;
  onCityClick?: (cityIndex: number) => void;
  onActivitiesClick?: (cityIndex: number) => void;
};

export default function Flowchart({ trip, onCityClick, onActivitiesClick }: FlowchartProps) {
  const setHomeLegAlternative = useTripStore((s) => s.setHomeLegAlternative);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Sub-card hover is independent from main card hover — each card is its
  // own object even though they're visually linked.
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null);
  const [openConnectors, setOpenConnectors] = useState<Set<number>>(new Set());
  const [expandedActivities, setExpandedActivities] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 8);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 8);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateScrollState, { passive: true });
    window.addEventListener('resize', updateScrollState);
    return () => {
      el.removeEventListener('scroll', updateScrollState);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [updateScrollState]);

  // Scroll an active card into view smoothly
  const scrollCardIntoView = useCallback((index: number) => {
    const card = cardRefs.current[index];
    const container = scrollRef.current;
    if (!card || !container) return;
    const cardRect = card.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const offset =
      cardRect.left - containerRect.left - containerRect.width / 2 + cardRect.width / 2;
    container.scrollBy({ left: offset, behavior: 'smooth' });
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        setActiveIndex((curr) => {
          const next = curr === null ? 0 : Math.min(trip.cities.length - 1, curr + 1);
          scrollCardIntoView(next);
          return next;
        });
      } else if (e.key === 'ArrowLeft') {
        setActiveIndex((curr) => {
          const next = curr === null ? 0 : Math.max(0, curr - 1);
          scrollCardIntoView(next);
          return next;
        });
      } else if (e.key === 'Escape') {
        setActiveIndex(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [trip.cities.length, scrollCardIntoView]);

  const scrollByAmount = (dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -480 : 480, behavior: 'smooth' });
  };

  return (
    <div className="relative h-full flex flex-col min-h-0">

      {/* Left scroll button */}
      {canScrollLeft && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => scrollByAmount('left')}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full flex items-center justify-center text-gray-600 hover:text-gray-900 border border-gray-200 hover:border-gray-400 backdrop-blur-md transition-all hover:scale-105 active:scale-95"
          style={{ background: '#ffffff' }}
          aria-label="Scroll left"
        >
          <ChevronLeft size={18} />
        </motion.button>
      )}

      {/* Right scroll button */}
      {canScrollRight && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => scrollByAmount('right')}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full flex items-center justify-center text-gray-600 hover:text-gray-900 border border-gray-200 hover:border-gray-400 backdrop-blur-md transition-all hover:scale-105 active:scale-95"
          style={{ background: '#ffffff' }}
          aria-label="Scroll right"
        >
          <ChevronRight size={18} />
        </motion.button>
      )}

      {/* Edge fade gradients removed — clean canvas, no tint */}

      {/* Scrollable flowchart window — scrolls both horizontally (between
          cities) and vertically (when sub-cards push past the viewport) */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-x-auto overflow-y-auto scrollbar-hide"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        <style jsx>{`
          div::-webkit-scrollbar {
            display: none;
          }
        `}</style>

        <motion.div
          className="flex items-stretch px-3 pt-3 pb-4 min-w-max gap-6 h-full"
          initial="hidden"
          animate="visible"
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.12 } },
          }}
        >
          {/* Leading home card + outbound leg. HomeCard and its Connector
              share ONE stretched motion.div — same pattern as city
              columns below — so Connector's self-center lands at the
              same Y position as between-city connectors.
              cityIndex = -1 is a sentinel so nothing downstream
              mistakes it for a real trip city. */}
          {trip.origin?.city && (
            <motion.div
              className="flex items-stretch"
              variants={{
                hidden: { opacity: 0, y: 24 },
                visible: { opacity: 1, y: 0, transition: { duration: 0.45 } },
              }}
            >
              <HomeCard
                city={trip.origin.city}
                airports={trip.origin.airports}
                label="Home"
                direction="outbound"
                leg={trip.origin.outboundLeg ?? null}
              />
              {trip.origin.outboundLeg && (
                <div className="flex items-center flex-shrink-0 mx-2">
                  <Connector
                    transport={homeLegToTransport(
                      trip.origin.outboundLeg,
                      trip.origin.city,
                      trip.cities[0]?.name ?? '',
                    )}
                    index={-1}
                    cityIndex={-1}
                    isExpanded={openConnectors.has(-1)}
                    onToggle={() =>
                      setOpenConnectors((curr) => {
                        const next = new Set(curr);
                        if (next.has(-1)) next.delete(-1);
                        else next.add(-1);
                        return next;
                      })
                    }
                    onPickAlternative={(altIdx) =>
                      setHomeLegAlternative('outbound', altIdx)
                    }
                  />
                </div>
              )}
            </motion.div>
          )}

          {trip.cities.map((city, idx) => {
            const hasSub =
              city.activities.length > 0 || city.restaurants.length > 0;
            // Dimming is city-level: if ANY card (main or sub) in any other
            // city is hovered, this city's cards dim. Whichever card in the
            // same city is hovered stays bright for both cards.
            const hoveredCity = activeIndex ?? activeSubIndex;
            const isDimmed = hoveredCity !== null && hoveredCity !== idx;
            return (
              <motion.div
                key={city.name}
                className="flex items-stretch"
                variants={{
                  hidden: { opacity: 0, y: 24 },
                  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 0.61, 0.36, 1] } },
                }}
              >
                {/* City column: main card → linker line → sub-card */}
                <div
                  ref={(el) => {
                    cardRefs.current[idx] = el;
                  }}
                  className="flex flex-col items-center"
                >
                  <CityCard
                    city={city}
                    index={idx}
                    isActive={activeIndex === idx}
                    isDimmed={isDimmed}
                    onHover={() => setActiveIndex(idx)}
                    onLeave={() => setActiveIndex(null)}
                    onClick={() => onCityClick?.(idx)}
                  />

                  {hasSub && (
                    <>
                      {/* Small connector line linking main card to sub-card */}
                      <div
                        className="w-px h-5"
                        style={{
                          background:
                            'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.06) 100%)',
                        }}
                      />
                      <CityActivitiesCard
                        city={city}
                        cityIndex={idx}
                        isActive={activeSubIndex === idx}
                        isDimmed={isDimmed}
                        expanded={expandedActivities === idx}
                        onHover={() => setActiveSubIndex(idx)}
                        onLeave={() => setActiveSubIndex(null)}
                        onToggleExpand={() => {
                          if (onActivitiesClick) {
                            onActivitiesClick(idx);
                          } else {
                            setExpandedActivities((prev) => (prev === idx ? null : idx));
                          }
                        }}
                      />
                    </>
                  )}
                </div>

                {/* Connector to next city — stretches to the row's
                    full height (parent uses items-stretch), then
                    centers its content vertically. Since the parent
                    scroll container also uses items-stretch, every
                    row has the same height = tallest city column,
                    so every connector's vertical center lands at the
                    same Y on the flowchart. */}
                {idx < trip.cities.length - 1 && (
                  <div className="flex items-center flex-shrink-0 mx-2">
                    <Connector
                      transport={city.transportOut}
                      index={idx}
                      cityIndex={idx}
                      isExpanded={openConnectors.has(idx)}
                      onToggle={() =>
                        setOpenConnectors((curr) => {
                          const next = new Set(curr);
                          if (next.has(idx)) next.delete(idx);
                          else next.add(idx);
                          return next;
                        })
                      }
                    />
                  </div>
                )}
              </motion.div>
            );
          })}

          {/* Trailing return leg + "Back home" card. Same motion.div
              shape as outbound: Connector first, then HomeCard, in one
              stretched container. cityIndex = -2 keeps its expanded
              state separate from outbound. */}
          {trip.origin?.city && trip.returnToHome && (
            <motion.div
              className="flex items-stretch"
              variants={{
                hidden: { opacity: 0, y: 24 },
                visible: { opacity: 1, y: 0, transition: { duration: 0.45 } },
              }}
            >
              {trip.origin.returnLeg && (
                <div className="flex items-center flex-shrink-0 mx-2">
                  <Connector
                    transport={homeLegToTransport(
                      trip.origin.returnLeg,
                      trip.cities[trip.cities.length - 1]?.name ?? '',
                      trip.origin.city,
                    )}
                    index={-2}
                    cityIndex={-2}
                    isExpanded={openConnectors.has(-2)}
                    onToggle={() =>
                      setOpenConnectors((curr) => {
                        const next = new Set(curr);
                        if (next.has(-2)) next.delete(-2);
                        else next.add(-2);
                        return next;
                      })
                    }
                    onPickAlternative={(altIdx) =>
                      setHomeLegAlternative('return', altIdx)
                    }
                  />
                </div>
              )}
              <HomeCard
                city={trip.origin.city}
                airports={trip.origin.airports}
                label="Back home"
                direction="inbound"
                leg={trip.origin.returnLeg ?? null}
              />
            </motion.div>
          )}
        </motion.div>
      </div>

      {/* Hint — pinned below the scroll window */}
      <div className="flex-shrink-0 text-center pt-2 pb-1 text-gray-500 text-xs">
        Hover or use ← → keys to focus a stop · Click to open the full guide
      </div>
    </div>
  );
}

// ─── Home anchor cards ──────────────────────────────────────
// Anchors that bracket the itinerary. Same visual language as a
// CityCard but slightly smaller and red — these aren't destinations
// the user is visiting, they're the bookends of the trip. The card
// surfaces the SPECIFIC airport, date, and time for the leg that
// touches home:
//   outbound → origin airport + depart date/time (leaving home)
//   inbound  → destination airport (home) + arrival date/time
// Terminal/gate info is omitted because our current flight data
// source doesn't return it; if we upgrade to Amadeus/Duffel we'll
// surface it here too.
function HomeCard({
  city,
  airports,
  label,
  direction,
  leg,
}: {
  city: string;
  airports: string[];
  label: string;
  direction: 'outbound' | 'inbound';
  leg: HomeLeg | null;
}) {
  // Pick the airport IATA on the HOME side of this leg. Outbound
  // leaves from home (originAirport). Inbound arrives at home
  // (destAirport). Fall back to the first configured airport when
  // there's no leg yet (pre-price trip state).
  const iata =
    (direction === 'outbound' ? leg?.originAirport : leg?.destAirport) ||
    airports[0] ||
    '';
  const airportName = getAirportName(iata);

  const dateIso = leg?.departDate;
  const dateLabel = dateIso ? formatHomeDate(dateIso) : null;
  const time = direction === 'outbound' ? leg?.departTime : leg?.arriveTime;
  const timeLabel = direction === 'outbound' ? 'Depart' : 'Arrive';

  return (
    <div className="flex-shrink-0 flex items-center justify-center">
      <div
        className="rounded-3xl border-2 overflow-hidden flex flex-col"
        style={{
          width: HOME_CARD_WIDTH,
          height: HOME_CARD_HEIGHT,
          background: HOME_COLOR.bg,
          borderColor: HOME_COLOR.border,
        }}
      >
        <div
          className="px-4 py-2 flex items-center gap-2"
          style={{ background: HOME_COLOR.text, color: 'white' }}
        >
          <Home size={14} />
          <div className="text-[11px] uppercase tracking-wider font-semibold">{label}</div>
        </div>

        <div className="flex-1 flex flex-col px-4 py-4 gap-3">
          {/* City */}
          <div
            className="text-[20px] font-semibold text-center leading-tight"
            style={{ color: HOME_COLOR.text }}
          >
            {city}
          </div>

          {/* Airport name + IATA */}
          {(airportName || iata) && (
            <div className="flex flex-col items-center gap-0.5">
              {airportName && (
                <div
                  className="text-[12px] font-medium text-center leading-tight"
                  style={{ color: `${HOME_COLOR.text}cc` }}
                >
                  {airportName}
                </div>
              )}
              {iata && (
                <div
                  className="text-[10px] font-mono uppercase tracking-wider"
                  style={{ color: `${HOME_COLOR.text}99` }}
                >
                  {iata}
                </div>
              )}
            </div>
          )}

          {/* Date + time */}
          <div
            className="mt-auto flex items-center justify-between gap-2 pt-2 border-t"
            style={{ borderColor: `${HOME_COLOR.text}26` }}
          >
            <div className="flex flex-col">
              <div
                className="text-[9px] uppercase tracking-wider"
                style={{ color: `${HOME_COLOR.text}88` }}
              >
                Date
              </div>
              <div
                className="text-[11px] font-medium tabular-nums"
                style={{ color: HOME_COLOR.text }}
              >
                {dateLabel || '—'}
              </div>
            </div>
            <div className="flex flex-col items-end">
              <div
                className="text-[9px] uppercase tracking-wider"
                style={{ color: `${HOME_COLOR.text}88` }}
              >
                {timeLabel}
              </div>
              <div
                className="text-[11px] font-mono font-semibold tabular-nums"
                style={{ color: HOME_COLOR.text }}
              >
                {time || '—:—'}
              </div>
            </div>
          </div>

          {/* All configured airports — small hint if there's more than one */}
          {airports.length > 1 && (
            <div
              className="text-[9px] uppercase tracking-wider text-center"
              style={{ color: `${HOME_COLOR.text}88` }}
              title={`Also searched: ${airports.filter((a) => a !== iata).join(', ')}`}
            >
              +{airports.length - 1} more airport{airports.length - 1 > 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Format an ISO date (YYYY-MM-DD) in a compact way for the home
 * card's footer row. Example: "May 24" / "Wed · May 24".
 */
function formatHomeDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Convert a HomeLeg (flight from/to the user's origin airports) into
 * the Transport shape <Connector /> renders. Both collapsed-pill and
 * expanded-card views work without modification because Connector
 * doesn't care whether a transport connects two real cities or a
 * home-anchor to a real city.
 *
 * `fromCity` / `toCity` here are the human-readable city names — the
 * Connector's "EXPANDED" view displays these on the depart/arrive
 * blocks alongside the IATA codes. For an outbound leg: fromCity =
 * origin ("New York"), toCity = first destination. For a return leg
 * it's reversed.
 *
 * Alternatives are left unset — home legs don't have the flight-vs-
 * train swap list that between-city legs do. Connector gracefully
 * hides the "Other options" section when alternatives is empty.
 */
function homeLegToTransport(leg: HomeLeg, fromCity: string, toCity: string): Transport {
  const fmt = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return mins > 0 ? (h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`) : '';
  };

  const baseFrom = (
    src: HomeLeg | Omit<HomeLeg, 'alternatives'>,
    f: string,
    t: string,
  ): Transport => ({
    mode: 'flight',
    operator: src.operator || src.carrierCode || 'Flight',
    duration: fmt(src.durationMinutes ?? 0),
    price: Number(src.price ?? 0),
    from: f,
    to: t,
    fromStation: src.originAirport,
    toStation: src.destAirport,
    departTime: src.departTime ?? undefined,
    arriveTime: src.arriveTime ?? undefined,
    departDate: src.departDate,
    layovers: src.stops ?? 0,
    flightNumber: src.carrierCode ?? undefined,
    bookingUrl: src.bookingUrl ?? undefined,
  });

  const main = baseFrom(leg, fromCity, toCity);
  if (leg.alternatives && leg.alternatives.length > 0) {
    main.alternatives = leg.alternatives.map((a) => baseFrom(a, fromCity, toCity));
  }
  return main;
}

