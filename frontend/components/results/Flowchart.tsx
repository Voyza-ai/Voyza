'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, PenSquare, Home } from 'lucide-react';
import { Trip, HomeLeg } from '@/lib/types';
import Link from 'next/link';
import CityCard from './CityCard';
import CityActivitiesCard from './CityActivitiesCard';
import Connector from './Connector';

/**
 * Approximate height of the main CityCard. We use this to vertically center
 * the horizontal Connector (flight/train) on the main card region, since the
 * full city column (main + sub-card) is much taller.
 */
const MAIN_CARD_HEIGHT = 320;
/**
 * Approximate height of a full city column (CityCard + small spacer +
 * CityActivitiesCard). Measured from the rendered flowchart — city
 * columns for a typical trip are ~440px tall. We size the HomeCard
 * to match so its adjacent Connector's self-center lands at the same
 * Y position as connectors between real cities. If activities lists
 * grow much taller this may need a small tweak, but 440 is the
 * average-case pixel position that lines everything up.
 */
const HOME_COLUMN_HEIGHT = 500;

type FlowchartProps = {
  trip: Trip;
  onCityClick?: (cityIndex: number) => void;
  onActivitiesClick?: (cityIndex: number) => void;
};

export default function Flowchart({ trip, onCityClick, onActivitiesClick }: FlowchartProps) {
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
      {/* Edit in Canvas button — top right */}
      {trip.id && (
        <Link
          href={`/canvas/${trip.id}`}
          target="_blank"
          className="absolute top-3 right-3 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-white transition-all hover:brightness-110"
          style={{ background: '#4f8ef7' }}
        >
          <PenSquare size={12} />
          Edit in Canvas
        </Link>
      )}

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
          className="flex items-start px-12 pt-3 pb-8 min-w-max gap-6"
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

                {/* Connector to next city — vertically centered on the whole city column (main + sub) */}
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
                  />
                </div>
              )}
              <HomeCard
                city={trip.origin.city}
                airports={trip.origin.airports}
                label="Back home"
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
// Small pills that bracket the itinerary on the flowchart. Intentionally
// visually different from CityCard (narrower, single-color, "Home" icon)
// so the user knows this isn't a destination they're visiting — it's
// their starting/ending point.
function HomeCard({
  city,
  airports,
  label,
}: {
  city: string;
  airports: string[];
  label: string;
}) {
  return (
    <div
      className="flex-shrink-0 w-[180px] rounded-2xl border-2 overflow-hidden flex flex-col"
      style={{
        background: 'linear-gradient(180deg, #eef3fb 0%, #dde7f5 100%)',
        borderColor: '#2e6bc4',
        // Match the full city-column height (CityCard + activities card +
        // spacer) so the adjacent Connector's self-center lands at the
        // same Y position as between-city connectors.
        minHeight: HOME_COLUMN_HEIGHT,
      }}
    >
      <div
        className="px-4 py-2 flex items-center gap-2"
        style={{ background: '#2e6bc4', color: 'white' }}
      >
        <Home size={14} />
        <div className="text-[11px] uppercase tracking-wider font-semibold">{label}</div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 gap-3">
        <div className="text-[18px] font-semibold text-gray-900 text-center leading-tight">
          {city}
        </div>
        {airports.length > 0 && (
          <div
            className="text-[11px] font-mono uppercase tracking-wider text-gray-600 text-center"
            title={`Searching ${airports.join(', ')}`}
          >
            {airports.slice(0, 3).join(' · ')}
          </div>
        )}
        <div className="text-[10px] text-gray-500 text-center mt-2">
          {label === 'Home' ? 'Starting point' : 'Returning here'}
        </div>
      </div>
    </div>
  );
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
function homeLegToTransport(leg: HomeLeg, fromCity: string, toCity: string): any {
  const mins = leg.durationMinutes ?? 0;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const durationStr =
    mins > 0 ? (h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`) : '';

  return {
    mode: 'flight',
    operator: leg.operator || leg.carrierCode || 'Flight',
    duration: durationStr,
    price: Number(leg.price ?? 0),
    // Connector reads from/to for the expanded card's route row.
    // We put the city names here and the IATA codes go into the
    // station fields so the UI shows both.
    from: fromCity,
    to: toCity,
    fromStation: leg.originAirport,
    toStation: leg.destAirport,
    departTime: leg.departTime ?? undefined,
    arriveTime: leg.arriveTime ?? undefined,
    departDate: leg.departDate,
    layovers: leg.stops ?? 0,
    stops: leg.stops ?? 0,
    currency: leg.currency ?? 'USD',
    carrierCode: leg.carrierCode ?? undefined,
    flightNumber: leg.carrierCode ?? undefined,
    bookingUrl: leg.bookingUrl ?? undefined,
  };
}

