'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Star,
  Building2,
  ChevronLeft,
  ChevronRight,
  Zap,
} from 'lucide-react';
import { City } from '@/lib/types';
import { getCityColor } from '@/lib/cityColors';
import { getVibeColor, VIBE_LABEL } from '@/lib/cityTheme';
import { effectiveHotel } from '@/lib/tripTotals';
import { useTripStore } from '@/store/tripStore';

type CityCardProps = {
  city: City;
  index: number;
  /** This specific card is being hovered — drives the scale-up animation */
  isActive: boolean;
  /** Another city is being hovered — drives the dim-out animation */
  isDimmed: boolean;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
};

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const parseLocal = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

export default function CityCard({
  city,
  index,
  isActive,
  isDimmed,
  onHover,
  onLeave,
  onClick,
}: CityCardProps) {
  const color = getCityColor(city.colorIndex ?? index);
  const arrival = formatDate(city.dates.arrival);
  const departure = formatDate(city.dates.departure);
  const nights = Math.round(
    (parseLocal(city.dates.departure).getTime() - parseLocal(city.dates.arrival).getTime()) /
      (1000 * 60 * 60 * 24)
  );
  const eff = effectiveHotel(city);
  const stayTotal = Math.round(eff.total);

  return (
    <motion.div
      animate={{
        opacity: isDimmed ? 0.35 : 1,
        scale: isActive ? 1.04 : 1,
      }}
      transition={{
        opacity: { duration: 0.25 },
        scale: { type: 'spring', stiffness: 260, damping: 22 },
      }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
      tabIndex={0}
      className="relative flex-shrink-0 w-[300px] rounded-3xl border-2 cursor-pointer overflow-hidden transition-colors duration-300 outline-none"
      style={{
        background: color.bg,
        borderColor: isActive ? color.text : color.border,
        boxShadow: isActive ? `0 0 20px ${color.border}` : 'none',
      }}
    >
      {/* City number + stay total badge */}
      <div className="absolute top-4 right-4 flex flex-col items-end gap-1.5">
        <span
          className="text-[11px] font-medium leading-none"
          style={{ color: color.text }}
        >
          {String(index + 1).padStart(2, '0')}
        </span>
        <motion.div
          key={`stay-${stayTotal}`}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="flex flex-col items-end px-2.5 py-1 rounded-lg border tabular-nums"
          style={{
            background: 'rgba(255,255,255,0.65)',
            borderColor: 'rgba(0,0,0,0.12)',
          }}
        >
          <span className="text-[9px] uppercase tracking-wider leading-none mb-0.5" style={{ color: `${color.text}99` }}>
            Stay
          </span>
          <span className="text-[15px] font-bold leading-none" style={{ color: color.text }}>
            ${stayTotal.toLocaleString()}
          </span>
        </motion.div>
      </div>

      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-baseline gap-2 mb-1">
          <h3 className="text-2xl font-semibold" style={{ color: color.text }}>{city.name}</h3>
        </div>
        <p className="text-sm font-medium" style={{ color: `${color.text}bb` }}>{city.country}</p>

        <div className="flex items-center gap-2 mt-3 text-[13px]" style={{ color: `${color.text}cc` }}>
          <span>{arrival}</span>
          <span style={{ color: `${color.text}88` }}>→</span>
          <span>{departure}</span>
          <span className="ml-1" style={{ color: `${color.text}aa` }}>
            · {nights} {nights === 1 ? 'night' : 'nights'}
          </span>
        </div>

        {/* Vibe chips */}
        {city.vibes && city.vibes.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {city.vibes.map((v) => {
              const c = getVibeColor(v);
              return (
                <span
                  key={v}
                  className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border"
                  style={{
                    background: `rgba(255,255,255,0.7)`,
                    borderColor: `${c}60`,
                    color: c,
                  }}
                >
                  {VIBE_LABEL[v]}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Hotel pill — darker shade of card bg */}
      <div
        className="mx-4 rounded-2xl"
        style={{ background: `${color.text}15` }}
      >
        <HotelSection city={city} cityIndex={index} color={color} />
      </div>

      {/* Open detail hint */}
      <div className="px-6 pb-5 pt-1">
        <div
          className="text-center text-[11px] uppercase tracking-wider transition-colors"
          style={{ color: isActive ? color.text : 'rgba(0,0,0,0.35)' }}
        >
          Click to open full guide
        </div>
      </div>

      {/* Color picker on hover */}
    </motion.div>
  );
}

/* ----------------------------- Hotel section ----------------------------- */

function HotelSection({ city, cityIndex, color }: { city: City; cityIndex: number; color: { bg: string; text: string; border: string; name: string } }) {
  const cycleHotel = useTripStore((s) => s.cycleHotel);
  const eff = effectiveHotel(city);
  const isCustom = eff.isCustom;
  const ranked = !isCustom && city.hotels.length > 1;
  const [slideDir, setSlideDir] = useState<1 | -1>(1);

  const stop = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleCycle = (dir: 1 | -1) => {
    setSlideDir(dir);
    cycleHotel(cityIndex, dir);
  };

  // Animation key — bumps every time the chosen hotel changes (or custom toggles)
  const animKey = isCustom ? 'custom' : `slot-${city.selectedHotelIndex}`;

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider" style={{ color: `${color.text}aa` }}>
          <Building2 size={11} />
          <span>Stay</span>
          {isCustom && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-black/5 border border-black/8 text-gray-500 text-[9px] tracking-wider">
              YOUR PICK
            </span>
          )}
          {!isCustom && eff.bookable && (
            <span
              className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] tracking-wider"
              style={{
                background: 'rgba(46,107,196,0.14)',
                border: '1px solid rgba(46,107,196,0.35)',
                color: '#2e6bc4',
              }}
              title="Bookable directly through Voyza in your one upfront payment"
            >
              <Zap size={9} fill="currentColor" />
              <span>VOYZA BOOK</span>
            </span>
          )}
        </div>
        {ranked && (
          <div className="flex items-center gap-1 text-gray-400 text-[10px]">
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                handleCycle(-1);
              }}
              className="w-5 h-5 rounded-full flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-black/5 transition-colors"
              aria-label="Previous hotel option"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                handleCycle(1);
              }}
              className="w-5 h-5 rounded-full flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-black/5 transition-colors"
              aria-label="Next hotel option"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Animated hotel content — slides in on each change */}
      <div className="relative overflow-hidden">
        <motion.div
          key={animKey}
          initial={{ opacity: 0, x: slideDir * 28 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.32, ease: [0.22, 0.61, 0.36, 1] }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight truncate" style={{ color: color.text }}>
                {eff.name}
              </div>
              {eff.area && (
                <div className="text-[12px] mt-0.5 truncate" style={{ color: `${color.text}99` }}>{eff.area}</div>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              {eff.rating != null && (
                <div className="flex items-center justify-end gap-1 text-[#fbbf24] text-xs">
                  <Star size={11} fill="currentColor" />
                  <span>{eff.rating}</span>
                </div>
              )}
              <div className="text-xs mt-0.5 font-medium" style={{ color: `${color.text}aa` }}>
                ${Math.round(eff.pricePerNight)}/night
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
