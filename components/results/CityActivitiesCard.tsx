'use client';

import { motion } from 'framer-motion';
import { MapPin, Utensils, ChevronRight } from 'lucide-react';
import { City } from '@/lib/types';
import { getCityColor } from '@/lib/cityColors';

type CityActivitiesCardProps = {
  city: City;
  cityIndex: number;
  isActive: boolean;
  isDimmed: boolean;
  /** Whether this card's detail panel is open (drives border accent) */
  expanded: boolean;
  onHover: () => void;
  onLeave: () => void;
  onToggleExpand: () => void;
};

/**
 * Sub-card hanging below the main CityCard. Shows a compact preview of
 * activities and restaurants. Clicking opens the full ActivitiesDetailPanel.
 */
export default function CityActivitiesCard({
  city,
  cityIndex,
  isActive,
  isDimmed,
  expanded,
  onHover,
  onLeave,
  onToggleExpand,
}: CityActivitiesCardProps) {
  const color = getCityColor(city.colorIndex ?? cityIndex);
  const hasActivities = city.activities.length > 0;
  const hasRestaurants = city.restaurants.length > 0;

  if (!hasActivities && !hasRestaurants) return null;

  const totalItems = city.activities.length + city.restaurants.length;

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
      onClick={onToggleExpand}
      className="relative w-[300px] rounded-3xl border-2 cursor-pointer overflow-hidden outline-none"
      style={{
        background: `${color.bg}cc`,
        borderColor: expanded ? color.text : isActive ? color.text : color.border,
      }}
    >
      {/* Compact header */}
      <div className="px-5 pt-4 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center"
            style={{ background: `${color.text}18` }}
          >
            <MapPin size={10} style={{ color: color.text }} />
          </div>
          <span
            className="text-[11px] uppercase tracking-wider font-semibold"
            style={{ color: color.text }}
          >
            Activities & Dining
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={{ background: `${color.text}15`, color: `${color.text}88` }}
          >
            {totalItems}
          </span>
        </div>
        <ChevronRight size={14} style={{ color: `${color.text}60` }} />
      </div>

      {/* Activities preview */}
      {hasActivities && (
        <div className="px-6 pt-1 pb-3">
          <ul className="flex flex-col gap-1.5">
            {city.activities.slice(0, 3).map((activity, i) => (
              <li
                key={i}
                className="text-[13px] leading-snug flex gap-2 items-start"
                style={{ color: `${color.text}cc` }}
              >
                <span
                  className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: color.text }}
                />
                <span>{activity}</span>
              </li>
            ))}
            {city.activities.length > 3 && (
              <li
                className="text-[11px] ml-3.5"
                style={{ color: `${color.text}70` }}
              >
                +{city.activities.length - 3} more
              </li>
            )}
          </ul>
        </div>
      )}

      {hasActivities && hasRestaurants && (
        <div className="h-[2px] rounded-full mx-6" style={{ background: color.border }} />
      )}

      {/* Restaurants preview */}
      {hasRestaurants && (
        <div className="px-6 py-3">
          <ul className="flex flex-col gap-1">
            {city.restaurants.slice(0, 2).map((r, i) => (
              <li
                key={i}
                className="text-[13px] leading-snug flex items-center justify-between gap-2"
                style={{ color: `${color.text}cc` }}
              >
                <span className="truncate">{r.name}</span>
                <span className="text-[11px] flex-shrink-0" style={{ color: `${color.text}88` }}>
                  {r.priceRange}
                </span>
              </li>
            ))}
            {city.restaurants.length > 2 && (
              <li className="text-[11px]" style={{ color: `${color.text}70` }}>
                +{city.restaurants.length - 2} more
              </li>
            )}
          </ul>
        </div>
      )}
    </motion.div>
  );
}
