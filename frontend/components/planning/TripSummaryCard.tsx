'use client';

import { Fragment } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { PlanningAnswers } from '@/lib/types';
import { summarizeAnswers, summaryText, type SummaryField } from '@/lib/tripSummary';

type Props = {
  answers: PlanningAnswers;
  /** Called when a fact is clicked. Omit to render the line read-only. */
  onEdit?: (field: SummaryField) => void;
  /** Facts that can be clicked; others render as plain text. Default: all. */
  editable?: (field: SummaryField) => boolean;
  className?: string;
};

/**
 * The running "trip so far" line above the /plan input bar. Hidden until the
 * first answer; each new or changed fact fades in from the brand blue so the
 * traveller sees what their last answer added.
 */
export default function TripSummaryCard({ answers, onEdit, editable, className = '' }: Props) {
  const groups = summarizeAnswers(answers);

  return (
    <AnimatePresence initial={false}>
      {groups.length > 0 && (
        <motion.div
          key="trip-summary"
          data-testid="trip-summary"
          aria-label={`Trip so far: ${summaryText(groups)}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className={`pointer-events-auto w-full rounded-2xl border border-white/10 px-4 py-2.5 ${className}`}
          style={{ background: 'rgba(15,15,26,0.92)' }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4f8ef7]" aria-hidden />
            <span className="text-white/40 text-[11px] uppercase tracking-[0.18em] font-medium">Trip so far</span>
          </div>
          <p className="text-[15px] leading-relaxed text-white/85">
            {groups.map((g, gi) => (
              // Short facts never break inside; the dot rides on the end of
              // the fact before it (no-break space) so a wrapped line never
              // starts with "·".
              <Fragment key={g.key}>
                {gi > 0 && (
                  <span className="text-white/25" aria-hidden>
                    {' ·'}
                  </span>
                )}
                {gi > 0 && ' '}
                <span className={g.key === 'lead' ? '' : 'whitespace-nowrap'}>
                {g.pieces.map((p, pi) => {
                  if (typeof p === 'string') return <span key={pi} className="text-white/55">{p}</span>;
                  const canEdit = !!onEdit && (editable ? editable(p.field) : true);
                  // Keyed by its text so a changed answer re-mounts and fades in.
                  const fade = {
                    initial: { color: '#7fb0ff' },
                    animate: { color: 'rgba(255,255,255,0.88)' },
                    transition: { duration: 1.4, ease: 'easeOut' as const },
                  };
                  return canEdit ? (
                    <motion.button
                      key={`${p.field}:${p.text}`}
                      type="button"
                      data-field={p.field}
                      {...fade}
                      onClick={() => onEdit!(p.field)}
                      title="Click to change"
                      className="inline font-medium underline decoration-dotted decoration-white/20 underline-offset-4 hover:decoration-[#4f8ef7] hover:!text-[#9db9f0] transition-[text-decoration-color] cursor-pointer"
                    >
                      {p.text}
                    </motion.button>
                  ) : (
                    <motion.span key={`${p.field}:${p.text}`} data-field={p.field} {...fade} className="font-medium">
                      {p.text}
                    </motion.span>
                  );
                })}
                </span>
              </Fragment>
            ))}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
