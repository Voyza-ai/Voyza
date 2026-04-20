'use client';

import { motion } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';

type BudgetOverBannerProps = {
  budget: number;
  totalCost: number;
};

/**
 * Amber warning banner shown on the results page when the computed trip
 * cost is higher than the budget the user specified. Informational only —
 * the user chose the cities, dates, and travelers, and our optimizer has
 * already picked the cheapest legs it could find; we're just being honest
 * about the gap rather than silently hiding it.
 *
 * Threshold: shown only if overage is at least $50 AND at least 5% of
 * their budget, so a $4 difference doesn't trigger a warning.
 */
export default function BudgetOverBanner({ budget, totalCost }: BudgetOverBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const overage = totalCost - budget;
  const overagePct = budget > 0 ? overage / budget : 0;

  // Don't render at all if we're within budget (or trivially over it).
  if (dismissed) return null;
  if (overage < 50 || overagePct < 0.05) return null;

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
          background: 'linear-gradient(90deg, rgba(245,158,11,0.10) 0%, rgba(245,158,11,0.04) 100%)',
          borderColor: 'rgba(245,158,11,0.30)',
        }}
      >
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(245,158,11,0.18)' }}
        >
          <AlertTriangle size={14} className="text-[#f59e0b]" />
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap text-[13px]">
          <span className="text-gray-700">
            This trip runs <strong className="text-[#f59e0b]">${Math.round(overage).toLocaleString()} over</strong> your
          </span>
          <span className="text-gray-500">${Math.round(budget).toLocaleString()} budget.</span>
          <span className="text-gray-500 italic">Try fewer cities, closer dates, or cheaper hotels to fit.</span>
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
