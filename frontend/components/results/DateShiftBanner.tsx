'use client';

import { motion } from 'framer-motion';
import { TrendingDown, X } from 'lucide-react';
import { useState } from 'react';

type DateShiftBannerProps = {
  suggestion: {
    dayOffset: number;
    newStartDate: string;
    newTotalCost: number;
    savings: number;
  };
};

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

/**
 * Non-blocking banner shown above the results header when shifting the trip
 * by ±1 or ±2 days would save meaningful money. Informational only — the
 * primary itinerary stays the same unless the user replans with new dates.
 * Dismissable with the X button.
 *
 * (Previously had a "Shift my trip" action button that wasn't wired up.
 * Removed until we have a real replan flow — showing a button that silently
 * does nothing is worse than not showing it at all.)
 */
export default function DateShiftBanner({ suggestion }: DateShiftBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const { dayOffset, newStartDate, savings } = suggestion;
  const direction = dayOffset < 0 ? 'earlier' : 'later';
  const days = Math.abs(dayOffset);
  const dayWord = days === 1 ? 'day' : 'days';

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, height: 0 }}
      animate={{ opacity: 1, y: 0, height: 'auto' }}
      exit={{ opacity: 0, y: -8, height: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="mx-8 mt-4 mb-1"
    >
      <div
        className="flex items-center gap-3 px-4 py-2.5 rounded-xl border"
        style={{
          background: 'linear-gradient(90deg, rgba(52,211,153,0.10) 0%, rgba(52,211,153,0.04) 100%)',
          borderColor: 'rgba(52,211,153,0.30)',
        }}
      >
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(52,211,153,0.18)' }}
        >
          <TrendingDown size={14} className="text-[#22c088]" />
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap text-[13px]">
          <span className="text-gray-700">
            Heads up — starting <strong className="text-[#22c088]">{days} {dayWord} {direction}</strong>
          </span>
          <span className="text-gray-500">({formatDate(newStartDate)})</span>
          <span className="text-gray-700">
            would save about <strong className="text-[#22c088]">${Math.round(savings).toLocaleString()}</strong>.
          </span>
        </div>

        <button
          onClick={() => setDismissed(true)}
          className="flex-shrink-0 text-gray-400 hover:text-gray-700 transition-colors p-1"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </motion.div>
  );
}
