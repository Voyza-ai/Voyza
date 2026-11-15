'use client';

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { motion, Reorder, useDragControls } from 'framer-motion';
// PenSquare and Link were left over from before the Edit-in-Canvas button
// got consolidated into ResultsHeader (backend_gohiltalla). Keeping the
// `Transport` type — still referenced by the homeLegToTransport helper
// further down in this file.
import { ChevronLeft, ChevronRight, Home, Loader2, GripHorizontal, X, Plus, Pencil } from 'lucide-react';
import { Trip, HomeLeg, Transport, City } from '@/lib/types';
import CityCard from './CityCard';
import CityActivitiesCard from './CityActivitiesCard';
import Connector from './Connector';
import { legNoRailRegion } from '@/lib/railCoverage';
import { useTripStore, cityPicksLoading } from '@/store/tripStore';
import { useAirportNames } from '@/lib/airportNames';

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
  /** True per direction while the results page is backfilling a missing
   *  home-leg flight — shows a searching pill instead of an empty gap. */
  homeLegSearch?: { outbound: boolean; return: boolean };
  /**
   * The trip can be rearranged here (what the canvas used to do): drag a
   * city by its handle, remove it, add one between two stops, change the
   * home airports. Off for people the trip was shared with to view.
   */
  editable?: boolean;
  /** A drag ended with the cities in a new order. */
  onReorder?: (cities: City[]) => void;
  onRemoveCity?: (index: number) => void;
  /** A stay's nights changed from its card's − / + control. */
  onNightsChange?: (index: number, nights: number) => void;
  /** Add a city after this index (-1 = before the first). */
  onAddCityAfter?: (index: number) => void;
  onEditHome?: (direction: 'outbound' | 'inbound') => void;
  /** Inter-city legs being searched again, keyed "From→To". */
  refreshingLegs?: string[];
};

export default function Flowchart({
  trip,
  onCityClick,
  onActivitiesClick,
  homeLegSearch,
  editable = false,
  onReorder,
  onRemoveCity,
  onNightsChange,
  onAddCityAfter,
  onEditHome,
  refreshingLegs = [],
}: FlowchartProps) {
  // The order while a city is being dragged; committed on drop.
  const [dragOrder, setDragOrder] = useState<City[] | null>(null);
  const dragOrderRef = useRef<City[] | null>(null);
  dragOrderRef.current = dragOrder;
  const cities = dragOrder ?? trip.cities;
  const canAdd = editable && !!onAddCityAfter;
  const canRemove = editable && !!onRemoveCity && trip.cities.length > 1;
  const commitDrag = () => {
    const order = dragOrderRef.current;
    setDragOrder(null);
    if (!order) return;
    const moved = order.some((c, i) => c !== trip.cities[i]);
    if (moved) onReorder?.(order);
  };
  const setHomeLegAlternative = useTripStore((s) => s.setHomeLegAlternative);
  // AI picks still on their way (/results opens before them; see startTripPicks).
  const tripPicks = useTripStore((s) => s.tripPicks);
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

  // ── Scrolling the row while a city is dragged ──
  // Dragging a city toward an edge of the cards area scrolls it, faster the
  // closer the pointer is, so a city can go from one end of a long trip to
  // the other in one drag (it used to take a drag per screen and the arrows
  // in between).
  const dragX = useRef<number | null>(null);
  const autoRaf = useRef<number | null>(null);
  const stopAutoScroll = useCallback(() => {
    dragX.current = null;
    if (autoRaf.current != null) cancelAnimationFrame(autoRaf.current);
    autoRaf.current = null;
  }, []);
  const startAutoScroll = useCallback(
    (e: React.PointerEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      dragX.current = e.clientX;
      let lastY = e.clientY;
      // The drag places the card by how far the POINTER moved since it began;
      // scrolling the row moves the card with the content, away from a still
      // pointer (measured: the card scrolled off and the city moved one slot).
      // So the drag is shown the pointer shifted by how far the row has
      // scrolled since the drag began — the card stays under the pointer and
      // the order is checked against where it really is.
      const scroll0 = el.scrollLeft;
      const shifted = (type: string, x: number, y: number, src?: PointerEvent) =>
        new PointerEvent(type, {
          clientX: x + (el.scrollLeft - scroll0),
          clientY: y,
          bubbles: true,
          cancelable: true,
          pointerId: src?.pointerId ?? 1,
          pointerType: src?.pointerType ?? 'mouse',
          isPrimary: true,
          buttons: type === 'pointermove' ? 1 : 0,
        });
      const relay = (ev: PointerEvent) => {
        if (!ev.isTrusted) return; // our own relayed copy: let it through
        ev.stopImmediatePropagation();
        dragX.current = ev.clientX;
        lastY = ev.clientY;
        window.dispatchEvent(shifted(ev.type, ev.clientX, ev.clientY, ev));
        if (ev.type !== 'pointermove') end();
      };
      const end = () => {
        window.removeEventListener('pointermove', relay, true);
        window.removeEventListener('pointerup', relay, true);
        window.removeEventListener('pointercancel', relay, true);
        stopAutoScroll();
      };
      window.addEventListener('pointermove', relay, true);
      window.addEventListener('pointerup', relay, true);
      window.addEventListener('pointercancel', relay, true);
      const EDGE = 110; // px from either edge where scrolling starts
      const MAX = 24; // px per frame at the very edge
      const tick = () => {
        const x = dragX.current;
        if (x == null) return;
        const r = el.getBoundingClientRect();
        let v = 0;
        if (x < r.left + EDGE) v = -MAX * Math.min(1, (r.left + EDGE - x) / EDGE);
        else if (x > r.right - EDGE) v = MAX * Math.min(1, (x - (r.right - EDGE)) / EDGE);
        if (v !== 0) {
          const before = el.scrollLeft;
          el.scrollLeft = before + v;
          // The row moved under a still pointer: tell the drag.
          if (el.scrollLeft !== before) window.dispatchEvent(shifted('pointermove', x, lastY));
        }
        autoRaf.current = requestAnimationFrame(tick);
      };
      if (autoRaf.current != null) cancelAnimationFrame(autoRaf.current);
      autoRaf.current = requestAnimationFrame(tick);
    },
    [stopAutoScroll],
  );
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

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
      {/* layoutScroll: the cards' positions are measured net of this
          container's scroll, so scrolling it during a drag isn't taken for
          the dragged card having moved (see startAutoScroll). */}
      <motion.div
        layoutScroll
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
                onEdit={editable && onEditHome ? () => onEditHome('outbound') : undefined}
              />
              {/* Always show SOMETHING between home and the first city:
                  the real flight, a searching state while the backfill
                  runs, or an honest "no flights found" card. */}
              {trip.origin.outboundLeg ? (
                <AddSlot show={canAdd} onAdd={() => onAddCityAfter?.(-1)} label="Add a city before the first stop">
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
                </AddSlot>
              ) : homeLegSearch?.outbound ? (
                <HomeLegSearchingPill />
              ) : (
                <AddSlot show={canAdd} onAdd={() => onAddCityAfter?.(-1)} label="Add a city before the first stop">
                  <Connector
                    transport={{
                      mode: 'flight',
                      operator: '',
                      duration: '',
                      price: 0,
                      from: trip.origin.city,
                      to: trip.cities[0]?.name ?? '',
                      unavailable: true,
                    }}
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
                </AddSlot>
              )}
            </motion.div>
          )}

          <Reorder.Group
            as="div"
            axis="x"
            values={cities}
            onReorder={(order: City[]) => setDragOrder(order)}
            className="flex items-stretch gap-6"
          >
          {cities.map((city, idx) => {
            const picksLoading = cityPicksLoading(tripPicks, trip, city.name);
            const hasSub =
              city.activities.length > 0 || city.restaurants.length > 0 || picksLoading;
            // Dimming is city-level: if ANY card (main or sub) in any other
            // city is hovered, this city's cards dim. Whichever card in the
            // same city is hovered stays bright for both cards.
            const hoveredCity = activeIndex ?? activeSubIndex;
            const isDimmed = hoveredCity !== null && hoveredCity !== idx;
            return (
              <CityReorderItem
                // Stable across a reorder: the old fallback to the position
                // (`idx`) — trips without colour indices, e.g. one just
                // planned — remounted the dragged card at its first swap, and
                // the drag stopped there (a city moved one place per drag).
                key={stableCityKey(cities, idx)}
                city={city}
                editable={editable && !!onReorder}
                onDragEnd={commitDrag}
                onDragStart={startAutoScroll}
              >
                {(startDrag) => (
                  <>
                {/* City column: main card → linker line → sub-card */}
                <div
                  ref={(el) => {
                    cardRefs.current[idx] = el;
                  }}
                  className="relative group flex flex-col items-center"
                >
                  {editable && (
                    <CityEditControls
                      cityName={city.name}
                      onStartDrag={startDrag}
                      onRemove={canRemove ? () => onRemoveCity?.(idx) : undefined}
                    />
                  )}
                  <CityCard
                    city={city}
                    index={idx}
                    isActive={activeIndex === idx}
                    isDimmed={isDimmed}
                    onHover={() => setActiveIndex(idx)}
                    onLeave={() => setActiveIndex(null)}
                    onClick={() => onCityClick?.(idx)}
                    onNightsChange={
                      editable && onNightsChange && !dragOrder ? (n) => onNightsChange(idx, n) : undefined
                    }
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
                        loading={picksLoading}
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
                {idx < cities.length - 1 && !dragOrder &&
                  refreshingLegs.includes(`${city.name}→${cities[idx + 1]?.name ?? ''}`) ? (
                  <HomeLegSearchingPill label="Finding transport…" />
                ) : idx < cities.length - 1 && (
                  <AddSlot
                    show={canAdd && !dragOrder}
                    onAdd={() => onAddCityAfter?.(idx)}
                    label={`Add a city after ${city.name}`}
                  >
                    <Connector
                      transport={city.transportOut}
                      legDate={city.dates?.departure}
                      noRailRegion={legNoRailRegion(
                        city.country,
                        cities[idx + 1]?.country,
                        city.transportOut,
                      )}
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
                  </AddSlot>
                )}
                  </>
                )}
              </CityReorderItem>
            );
          })}
          </Reorder.Group>

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
              {trip.origin.returnLeg ? (
                <AddSlot show={canAdd} onAdd={() => onAddCityAfter?.(trip.cities.length - 1)} label="Add a city after the last stop">
                  <Connector
                    transport={homeLegToTransport(
                      trip.origin.returnLeg,
                      trip.cities[trip.cities.length - 1]?.name ?? '',
                      trip.origin.returnCity ?? trip.origin.city,
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
                </AddSlot>
              ) : homeLegSearch?.return ? (
                <HomeLegSearchingPill />
              ) : (
                <AddSlot show={canAdd} onAdd={() => onAddCityAfter?.(trip.cities.length - 1)} label="Add a city after the last stop">
                  <Connector
                    transport={{
                      mode: 'flight',
                      operator: '',
                      duration: '',
                      price: 0,
                      from: trip.cities[trip.cities.length - 1]?.name ?? '',
                      to: trip.origin.returnCity ?? trip.origin.city,
                      unavailable: true,
                    }}
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
                </AddSlot>
              )}
              <HomeCard
                city={trip.origin.returnCity ?? trip.origin.city}
                airports={trip.origin.returnAirports ?? trip.origin.airports}
                label="Back home"
                direction="inbound"
                leg={trip.origin.returnLeg ?? null}
                onEdit={editable && onEditHome ? () => onEditHome('inbound') : undefined}
              />
            </motion.div>
          )}

          {/* No back-home card to hang a "+" on: add after the last stop here. */}
          {canAdd && !(trip.origin?.city && trip.returnToHome) && (
            <div className="flex items-center flex-shrink-0">
              <button
                type="button"
                onClick={() => onAddCityAfter?.(trip.cities.length - 1)}
                aria-label="Add a city after the last stop"
                title="Add a city"
                className="w-12 h-12 rounded-full flex items-center justify-center border-2 border-dashed text-gray-400 transition-all hover:scale-110 hover:border-[#2563eb] hover:text-[#2563eb]"
                style={{ borderColor: 'rgba(0,0,0,0.15)' }}
              >
                <Plus size={20} />
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>

      {/* Hint — pinned below the scroll window */}
      <div className="flex-shrink-0 text-center pt-2 pb-1 text-gray-500 text-xs">
        Hover or use ← → keys to focus a stop · Click to open the full guide
        {editable && onReorder ? ' · Drag a city by its handle to reorder' : ''}
      </div>
    </div>
  );
}

/** Compact pill shown in a home connector's slot while the results page
 *  backfills that direction's flight. */
function HomeLegSearchingPill({ label = 'Finding flights…' }: { label?: string } = {}) {
  return (
    <div className="flex items-center flex-shrink-0 mx-2">
      <div
        className="flex items-center gap-2 px-3.5 py-2 rounded-xl border text-[12px] text-gray-500"
        style={{ background: '#ffffff', borderColor: 'rgba(0,0,0,0.08)' }}
      >
        <Loader2 size={13} className="animate-spin" style={{ color: '#2563eb' }} />
        {label}
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
export function HomeCard({
  city,
  airports,
  label,
  direction,
  leg,
  onEdit,
}: {
  city: string;
  airports: string[];
  label: string;
  direction: 'outbound' | 'inbound';
  leg: HomeLeg | null;
  /** Change this direction's home city / airports (editable trips). */
  onEdit?: () => void;
}) {
  // Pick the airport IATA on the HOME side of this leg. Outbound
  // leaves from home (originAirport). Inbound arrives at home
  // (destAirport). Fall back to the first configured airport when
  // there's no leg yet (pre-price trip state).
  const iata =
    (direction === 'outbound' ? leg?.originAirport : leg?.destAirport) ||
    airports[0] ||
    '';
  // Generated from OurAirports, so any of the 4,008 scheduled IATA airports
  // the resolver can return has a name — not just the ~100 a hand-written
  // table used to carry. The table is a deferred chunk, so this is null on
  // first paint and the card shows the bare code until it lands.
  const airportName = useAirportNames()(iata);

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
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Change ${direction === 'outbound' ? 'home' : 'back-home'} airports`}
              title="Change city or airports"
              className="ml-auto w-6 h-6 rounded-md flex items-center justify-center text-white/75 hover:text-white hover:bg-white/15 transition-colors"
            >
              <Pencil size={12} />
            </button>
          )}
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


/**
 * A connector slot that also offers "add a city here" on hover — the canvas's
 * between-cards "+". The slot keeps the connector's layout (stretched,
 * content centred); the button sits just under the leg card.
 */
function AddSlot({
  show,
  onAdd,
  label,
  children,
}: {
  show: boolean;
  onAdd: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="relative group/add flex items-center flex-shrink-0 mx-2">
      {children}
      {show && (
        <button
          type="button"
          onClick={onAdd}
          aria-label={label}
          title="Add a city here"
          className="absolute left-1/2 -translate-x-1/2 w-7 h-7 rounded-full flex items-center justify-center bg-white border border-dashed text-gray-400 opacity-0 group-hover/add:opacity-100 focus:opacity-100 transition-all hover:border-[#2563eb] hover:text-[#2563eb] hover:scale-110"
          style={{ top: 'calc(50% + 84px)', borderColor: 'rgba(0,0,0,0.2)' }}
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * A small hover toolbar at the top centre of an editable city: the drag
 * handle and, when the city can go, a remove button. Kept off the card's
 * name and its number/stay badges.
 */
function CityEditControls({
  cityName,
  onStartDrag,
  onRemove,
}: {
  cityName: string;
  onStartDrag: (e: React.PointerEvent) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="absolute top-1.5 left-1/2 -translate-x-1/2 z-10 flex items-center rounded-full bg-white/90 border border-black/10 shadow-sm opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button
        type="button"
        onPointerDown={(e) => {
          e.preventDefault();
          onStartDrag(e);
        }}
        aria-label={`Drag to move ${cityName}`}
        title="Drag to reorder"
        className="px-2 py-0.5 flex items-center justify-center text-gray-500 cursor-grab active:cursor-grabbing hover:text-gray-800"
        style={{ touchAction: 'none' }}
      >
        <GripHorizontal size={14} />
      </button>
      {onRemove && (
        <>
          <span className="w-px h-3.5 bg-black/10" />
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${cityName}`}
            title={`Remove ${cityName}`}
            className="px-1.5 py-0.5 flex items-center justify-center text-gray-500 hover:text-red-600"
          >
            <X size={12} />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * One city's column in the reorderable row. Dragging starts only from the
 * handle (so a click on the card still opens its guide); the order is kept
 * locally while dragging and committed on drop.
 */
function CityReorderItem({
  city,
  editable,
  onDragEnd,
  onDragStart,
  children,
}: {
  city: City;
  editable: boolean;
  onDragEnd: () => void;
  onDragStart?: (e: React.PointerEvent) => void;
  children: (startDrag: (e: React.PointerEvent) => void) => ReactNode;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      as="div"
      value={city}
      dragListener={false}
      dragControls={controls}
      drag={editable ? 'x' : false}
      onDragEnd={onDragEnd}
      className="flex items-stretch"
      whileDrag={{ scale: 1.03, zIndex: 50 }}
      variants={{
        hidden: { opacity: 0, y: 24 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 0.61, 0.36, 1] } },
      }}
    >
      {children((e) => {
        if (!editable) return;
        controls.start(e);
        onDragStart?.(e);
      })}
    </Reorder.Item>
  );
}

/** A React key for a city that survives reordering: its name, plus which of the same-named stays it is. */
function stableCityKey(cities: City[], idx: number): string {
  const name = cities[idx].name;
  let nth = 0;
  for (let i = 0; i < idx; i++) if (cities[i].name === name) nth++;
  return `${name}|${nth}`;
}
