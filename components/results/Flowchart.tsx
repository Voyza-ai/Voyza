'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Trip } from '@/lib/types';
import CityCard from './CityCard';
import CityActivitiesCard from './CityActivitiesCard';
import Connector from './Connector';

/**
 * Approximate height of the main CityCard. We use this to vertically center
 * the horizontal Connector (flight/train) on the main card region, since the
 * full city column (main + sub-card) is much taller.
 */
const MAIN_CARD_HEIGHT = 320;

type FlowchartProps = {
  trip: Trip;
  onCityClick?: (cityIndex: number) => void;
};

export default function Flowchart({ trip, onCityClick }: FlowchartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Sub-card hover is independent from main card hover — each card is its
  // own object even though they're visually linked.
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null);
  const [openConnectors, setOpenConnectors] = useState<Set<number>>(new Set());
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
          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full flex items-center justify-center text-white/70 hover:text-white border border-white/10 hover:border-white/25 backdrop-blur-md transition-all hover:scale-105 active:scale-95"
          style={{ background: 'rgba(15,15,26,0.85)' }}
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
          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full flex items-center justify-center text-white/70 hover:text-white border border-white/10 hover:border-white/25 backdrop-blur-md transition-all hover:scale-105 active:scale-95"
          style={{ background: 'rgba(15,15,26,0.85)' }}
          aria-label="Scroll right"
        >
          <ChevronRight size={18} />
        </motion.button>
      )}

      {/* Edge fade gradients */}
      <div
        className="pointer-events-none absolute left-0 top-0 bottom-0 w-16 z-10 transition-opacity"
        style={{
          background: 'linear-gradient(90deg, #0f0f1a 0%, transparent 100%)',
          opacity: canScrollLeft ? 1 : 0,
        }}
      />
      <div
        className="pointer-events-none absolute right-0 top-0 bottom-0 w-16 z-10 transition-opacity"
        style={{
          background: 'linear-gradient(270deg, #0f0f1a 0%, transparent 100%)',
          opacity: canScrollRight ? 1 : 0,
        }}
      />

      {/* Scrollable flowchart window — scrolls both horizontally (between
          cities) and vertically (when sub-cards push past the viewport) */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden scrollbar-hide"
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

        <div className="flex items-start px-12 pt-3 pb-12 min-w-max gap-6">
          {trip.cities.map((city, idx) => {
            const hasSub =
              city.activities.length > 0 || city.restaurants.length > 0;
            // Dimming is city-level: if ANY card (main or sub) in any other
            // city is hovered, this city's cards dim. Whichever card in the
            // same city is hovered stays bright for both cards.
            const hoveredCity = activeIndex ?? activeSubIndex;
            const isDimmed = hoveredCity !== null && hoveredCity !== idx;
            return (
              <div key={city.name} className="flex items-stretch">
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
                            'linear-gradient(180deg, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0.08) 100%)',
                        }}
                      />
                      <CityActivitiesCard
                        city={city}
                        isActive={activeSubIndex === idx}
                        isDimmed={isDimmed}
                        onHover={() => setActiveSubIndex(idx)}
                        onLeave={() => setActiveSubIndex(null)}
                        onClick={() => onCityClick?.(idx)}
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
              </div>
            );
          })}
        </div>
      </div>

      {/* Hint — pinned below the scroll window */}
      <div className="flex-shrink-0 text-center pt-2 pb-1 text-white/25 text-xs">
        Hover or use ← → keys to focus a stop · Click to open the full guide
      </div>
    </div>
  );
}
