'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Star,
  Building2,
  Utensils,
  MapPin,
  ChevronLeft,
  ChevronRight,
  Zap,
  Info,
} from 'lucide-react';
import { City } from '@/lib/types';
import { getCityTheme, getVibeColor, VIBE_LABEL } from '@/lib/cityTheme';
import { effectiveHotel } from '@/lib/tripTotals';
import { useTripStore } from '@/store/tripStore';

type CityCardProps = {
  city: City;
  index: number;
  isActive: boolean;
  isAnyActive: boolean;
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
  isAnyActive,
  onHover,
  onLeave,
  onClick,
}: CityCardProps) {
  const theme = getCityTheme(city.country, city.vibes);
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
        opacity: isAnyActive && !isActive ? 0.55 : 1,
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
      className="relative flex-shrink-0 w-[300px] rounded-3xl border cursor-pointer overflow-hidden transition-colors duration-300 outline-none"
      style={{
        background: theme.gradient,
        borderColor: isActive ? theme.borderActive : theme.borderRest,
        boxShadow: isActive ? theme.glow : 'none',
      }}
    >
      {/* Top accent bar — country base color, fading to vibe accent */}
      <div
        className="absolute top-0 left-0 right-0 h-[3px] opacity-80"
        style={{
          background: `linear-gradient(90deg, ${theme.countryBase} 0%, ${theme.vibeAccent} 100%)`,
        }}
      />

      {/* City number + stay total badge */}
      <div className="absolute top-4 right-4 flex flex-col items-end gap-1.5">
        <span
          className="text-[11px] font-medium leading-none"
          style={{ color: theme.numberColor }}
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
            background: 'rgba(255,255,255,0.04)',
            borderColor: 'rgba(255,255,255,0.1)',
          }}
        >
          <span className="text-[9px] uppercase tracking-wider text-white/40 leading-none mb-0.5">
            Stay
          </span>
          <span className="text-white text-[15px] font-semibold leading-none">
            ${stayTotal.toLocaleString()}
          </span>
        </motion.div>
      </div>

      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-baseline gap-2 mb-1">
          <h3 className="text-2xl font-semibold text-white">{city.name}</h3>
        </div>
        <p className="text-white/45 text-sm">{city.country}</p>

        <div className="flex items-center gap-2 mt-3 text-white/55 text-[13px]">
          <span>{arrival}</span>
          <span className="text-white/20">→</span>
          <span>{departure}</span>
          <span className="text-white/25 ml-1">
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
                    background: `${c}1a`,
                    borderColor: `${c}40`,
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

      {/* Divider */}
      <div className="h-px bg-white/5 mx-6" />

      {/* Hotel */}
      <HotelSection city={city} cityIndex={index} />

      <div className="h-px bg-white/5 mx-6" />

      {/* Activities */}
      <div className="px-6 py-4">
        <div className="flex items-center gap-2 text-white/35 text-[11px] uppercase tracking-wider mb-2">
          <MapPin size={11} />
          <span>Top picks</span>
        </div>
        <ul className="flex flex-col gap-1.5">
          {city.activities.slice(0, 3).map((activity, i) => (
            <li key={i} className="text-white/70 text-[13px] leading-snug flex gap-2">
              <span className="flex-shrink-0" style={{ color: `${theme.vibeAccent}99` }}>
                ·
              </span>
              <span>{activity}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="h-px bg-white/5 mx-6" />

      {/* Restaurants */}
      <div className="px-6 py-4">
        <div className="flex items-center gap-2 text-white/35 text-[11px] uppercase tracking-wider mb-2">
          <Utensils size={11} />
          <span>Eat here</span>
        </div>
        <ul className="flex flex-col gap-1">
          {city.restaurants.slice(0, 2).map((r, i) => (
            <li
              key={i}
              className="text-white/70 text-[13px] leading-snug flex items-center justify-between gap-2"
            >
              <span className="truncate">{r.name}</span>
              <span className="text-white/30 text-[11px] flex-shrink-0">{r.priceRange}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Open detail hint */}
      <div className="px-6 pb-5 pt-1">
        <div
          className="text-center text-[11px] uppercase tracking-wider transition-colors"
          style={{ color: isActive ? theme.countryBase : 'rgba(255,255,255,0.2)' }}
        >
          Click to open full guide
        </div>
      </div>
    </motion.div>
  );
}

/* ----------------------------- Hotel section ----------------------------- */

function HotelSection({ city, cityIndex }: { city: City; cityIndex: number }) {
  const cycleHotel = useTripStore((s) => s.cycleHotel);
  const eff = effectiveHotel(city);
  const isCustom = eff.isCustom;
  const ranked = !isCustom && city.hotels.length > 1;
  const [slideDir, setSlideDir] = useState<1 | -1>(1);
  const [showFees, setShowFees] = useState(false);

  const room = Math.round(eff.roomSubtotal);
  const taxes = Math.round(eff.taxesSubtotal);
  const total = Math.round(eff.total);
  const hasTaxes = taxes > 0;

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
        <div className="flex items-center gap-2 text-white/35 text-[11px] uppercase tracking-wider">
          <Building2 size={11} />
          <span>Stay</span>
          {isCustom && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-white/8 border border-white/15 text-white/60 text-[9px] tracking-wider">
              YOUR PICK
            </span>
          )}
          {!isCustom && eff.bookable && (
            <span
              className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] tracking-wider"
              style={{
                background: 'rgba(79,142,247,0.12)',
                border: '1px solid rgba(79,142,247,0.3)',
                color: '#7aa9f8',
              }}
              title="Bookable directly through Voyza in your one upfront payment"
            >
              <Zap size={9} fill="currentColor" />
              <span>VOYZA BOOK</span>
            </span>
          )}
        </div>
        {ranked && (
          <div className="flex items-center gap-1 text-white/35 text-[10px]">
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                handleCycle(-1);
              }}
              className="w-5 h-5 rounded-full flex items-center justify-center text-white/55 hover:text-white hover:bg-white/8 transition-colors"
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
              className="w-5 h-5 rounded-full flex items-center justify-center text-white/55 hover:text-white hover:bg-white/8 transition-colors"
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
              <div className="text-white/85 text-sm font-medium leading-tight truncate">
                {eff.name}
              </div>
              {eff.area && (
                <div className="text-white/35 text-[12px] mt-0.5 truncate">{eff.area}</div>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              {eff.rating != null && (
                <div className="flex items-center justify-end gap-1 text-[#fbbf24] text-xs">
                  <Star size={11} fill="currentColor" />
                  <span>{eff.rating}</span>
                </div>
              )}
              <div className="text-white/55 text-xs mt-0.5">
                ${Math.round(eff.pricePerNight)}/night
              </div>
            </div>
          </div>

          {/* Stay total breakdown */}
          <div className="mt-3 pt-2 border-t border-white/5">
            <div className="flex items-center justify-between text-[11px]">
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  if (hasTaxes) setShowFees((v) => !v);
                }}
                className="flex items-center gap-1 text-white/35 uppercase tracking-wider hover:text-white/60 transition-colors"
              >
                <span>Stay total</span>
                {hasTaxes && <Info size={10} className="opacity-70" />}
              </button>
              <span className="text-white/85 font-semibold tabular-nums">
                ${total.toLocaleString()}
              </span>
            </div>

            {hasTaxes && showFees && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                transition={{ duration: 0.2 }}
                className="mt-1.5 flex flex-col gap-0.5 text-[10.5px] text-white/45 tabular-nums"
              >
                <div className="flex justify-between">
                  <span>
                    Room · ${Math.round(eff.pricePerNight)} × {eff.nights}n
                  </span>
                  <span>${room.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Taxes & fees</span>
                  <span>${taxes.toLocaleString()}</span>
                </div>
              </motion.div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
