'use client';

import { motion } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type { VibeTierUpSuggestion } from '@/lib/types';

type VibeTierUpBannerProps = {
  tierUp: VibeTierUpSuggestion;
};

/**
 * Surfaced on the results page when Claude flagged that bumping the
 * user's per-person budget by a modest amount would unlock far more
 * aspirational destinations.
 *
 * Visual treatment intentionally distinct from BudgetOverBanner —
 * that one is a warning (amber, "you're over"); this one is an
 * opportunity (blue/sparkle, "you could go even bigger"). Both are
 * dismissible.
 *
 * No action button yet — clicking through to "re-run with bumped
 * budget" is a follow-up feature. For now this is informational and
 * the user can adjust their budget manually via the AI chat panel
 * which already supports trip edits.
 */
export default function VibeTierUpBanner({ tierUp }: VibeTierUpBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const bump = Math.round(tierUp.min_budget_increase_per_person_usd);
  const newBudget = Math.round(tierUp.new_budget_per_person_usd);
  const examples = tierUp.destination_examples.slice(0, 3).join(', ');

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, height: 0 }}
      animate={{ opacity: 1, y: 0, height: 'auto' }}
      exit={{ opacity: 0, y: -8, height: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="mx-8 mt-4 mb-1"
    >
      <div
        className="flex items-start gap-3 px-4 py-3 rounded-xl border"
        style={{
          background:
            'linear-gradient(90deg, rgba(46,107,196,0.10) 0%, rgba(46,107,196,0.04) 100%)',
          borderColor: 'rgba(46,107,196,0.30)',
        }}
      >
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
          style={{ background: 'rgba(46,107,196,0.18)' }}
        >
          <Sparkles size={14} style={{ color: '#2e6bc4' }} />
        </div>

        <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
          <span className="text-gray-700">
            Bumping your budget by{' '}
            <strong style={{ color: '#2e6bc4' }}>${bump.toLocaleString()}</strong>
            {' '}per person (to ~${newBudget.toLocaleString()}) would open up{' '}
            <strong className="text-gray-900">{examples}</strong>.
          </span>
          <div className="text-gray-500 mt-1 italic">
            {tierUp.why_worth_it}
          </div>
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
