'use client';

import { motion } from 'framer-motion';
import { MapPin, Utensils } from 'lucide-react';
import { City } from '@/lib/types';
import { getCityTheme } from '@/lib/cityTheme';

type CityActivitiesCardProps = {
  city: City;
  /** This specific sub-card is being hovered — drives the scale-up */
  isActive: boolean;
  /** Another city is being hovered — drives the dim-out */
  isDimmed: boolean;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
};

/**
 * Sub-card hanging below the main CityCard. Holds the lighter "what to do here"
 * info (activities + restaurants). Same visual family as CityCard but slightly
 * more muted so the eye lands on the main card first.
 */
export default function CityActivitiesCard({
  city,
  isActive,
  isDimmed,
  onHover,
  onLeave,
  onClick,
}: CityActivitiesCardProps) {
  const theme = getCityTheme(city.country, city.vibes);
  const hasActivities = city.activities.length > 0;
  const hasRestaurants = city.restaurants.length > 0;

  if (!hasActivities && !hasRestaurants) return null;

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
      className="relative w-[300px] rounded-3xl border cursor-pointer overflow-hidden outline-none"
      style={{
        background: theme.subGradient,
        borderColor: isActive ? theme.borderActive : theme.borderRest,
      }}
    >
      {hasActivities && (
        <div className="px-6 pt-5 pb-3">
          <div className="flex items-center gap-2 text-white/40 text-[11px] uppercase tracking-wider mb-2">
            <MapPin size={11} />
            <span>Top picks</span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {city.activities.slice(0, 3).map((activity, i) => (
              <li
                key={i}
                className="text-white/75 text-[13px] leading-snug flex gap-2"
              >
                <span
                  className="flex-shrink-0"
                  style={{ color: `${theme.vibeAccent}aa` }}
                >
                  ·
                </span>
                <span>{activity}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasActivities && hasRestaurants && (
        <div className="h-px bg-white/8 mx-6" />
      )}

      {hasRestaurants && (
        <div className="px-6 py-4">
          <div className="flex items-center gap-2 text-white/40 text-[11px] uppercase tracking-wider mb-2">
            <Utensils size={11} />
            <span>Eat here</span>
          </div>
          <ul className="flex flex-col gap-1">
            {city.restaurants.slice(0, 2).map((r, i) => (
              <li
                key={i}
                className="text-white/75 text-[13px] leading-snug flex items-center justify-between gap-2"
              >
                <span className="truncate">{r.name}</span>
                <span className="text-white/35 text-[11px] flex-shrink-0">
                  {r.priceRange}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
}
