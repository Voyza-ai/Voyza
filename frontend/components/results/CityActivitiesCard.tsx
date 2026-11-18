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
  /**
   * The city's AI picks are still on their way (/results opens before
   * them). With none yet, the card keeps its place with faded lines.
   */
  loading?: boolean;
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
  loading = false,
  onHover,
  onLeave,
  onToggleExpand,
}: CityActivitiesCardProps) {
  const color = getCityColor(city.colorIndex ?? cityIndex);
  const hasActivities = city.activities.length > 0;
  const hasRestaurants = city.restaurants.length > 0;

  if (!hasActivities && !hasRestaurants) {
    return loading ? (
      <LoadingCard color={color} isActive={isActive} isDimmed={isDimmed} onHover={onHover} onLeave={onLeave} />
    ) : null;
  }

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

/**
 * The card while the city's AI picks load: the same card, header and colours,
 * with faded lines where the activities and restaurants will be. Not
 * clickable — there is nothing to open yet.
 */
function LoadingCard({
  color,
  isActive,
  isDimmed,
  onHover,
  onLeave,
}: {
  color: ReturnType<typeof getCityColor>;
  isActive: boolean;
  isDimmed: boolean;
  onHover: () => void;
  onLeave: () => void;
}) {
  const line = (width: string) => (
    <span className="h-2.5 rounded-full" style={{ width, background: `${color.text}1f` }} />
  );
  return (
    <motion.div
      animate={{ opacity: isDimmed ? 0.35 : 1, scale: isActive ? 1.04 : 1 }}
      transition={{
        opacity: { duration: 0.25 },
        scale: { type: 'spring', stiffness: 260, damping: 22 },
      }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      aria-busy="true"
      aria-label="Loading activities and dining"
      className="relative w-[300px] rounded-3xl border-2 overflow-hidden outline-none"
      style={{ background: `${color.bg}cc`, borderColor: isActive ? color.text : color.border }}
    >
      <div className="px-5 pt-4 pb-2 flex items-center gap-2">
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
      </div>
      {/* Rows sized like the real card's (13px snug text, its "+N more"
          lines), so nothing moves when the picks land. */}
      <div className="animate-pulse">
        <ul className="px-6 pt-1 pb-3 flex flex-col gap-1.5">
          {['72%', '58%', '66%'].map((w) => (
            <li key={w} className="h-[18px] flex gap-2 items-center">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: `${color.text}40` }} />
              {line(w)}
            </li>
          ))}
          <li className="h-[16px] ml-3.5 flex items-center">{line('16%')}</li>
        </ul>
        <div className="h-[2px] rounded-full mx-6" style={{ background: color.border }} />
        <ul className="px-6 py-3 flex flex-col gap-1">
          {['64%', '48%'].map((w) => (
            <li key={w} className="h-[18px] flex items-center justify-between gap-2">
              {line(w)}
              {line('12%')}
            </li>
          ))}
          <li className="h-[16px] flex items-center">{line('14%')}</li>
        </ul>
      </div>
    </motion.div>
  );
}
