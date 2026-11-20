'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { elapsedSeconds, searchSteps, type SearchProgressState } from '@/lib/searchProgress';

const BLUE = '#2563eb';

/**
 * The "Find my trip" search, step by step, with the live counts behind each
 * step (lib/searchProgress.ts). Steps hang off a dashed line — the product's
 * route motif — and fill in as the real requests finish.
 */
export default function SearchProgress({
  progress,
  fallback,
}: {
  progress: SearchProgressState;
  /** Shown once the search has run long: a stored copy of the same trip. */
  fallback?: { afterSeconds: number; label: string; onOpen: () => void } | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const steps = searchSteps(progress);
  const secs = elapsedSeconds(progress, now);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="w-full max-w-md rounded-2xl border border-gray-200 bg-white px-5 py-4 text-left shadow-sm"
      data-testid="search-progress"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-[13px] font-semibold text-gray-900">Searching live prices</span>
        <span className="text-[12px] text-gray-400 tabular-nums">{secs}s</span>
      </div>
      <ol className="relative">
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            <li key={step.key} className="relative flex gap-3 pb-3 last:pb-0" data-status={step.status}>
              {!last && (
                <span
                  aria-hidden
                  className="absolute left-[7px] top-[18px] bottom-[-2px] border-l-2 border-dashed"
                  style={{ borderColor: step.status === 'done' ? `${BLUE}80` : '#d1d5db' }}
                />
              )}
              <span className="relative mt-[2px] flex h-4 w-4 flex-shrink-0 items-center justify-center">
                {step.status === 'done' ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full" style={{ background: BLUE }}>
                    <Check size={10} color="#fff" strokeWidth={3} />
                  </span>
                ) : step.status === 'active' ? (
                  <span
                    className="h-4 w-4 rounded-full border-2 border-t-transparent animate-spin"
                    style={{ borderColor: BLUE, borderTopColor: 'transparent' }}
                  />
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full bg-gray-300" />
                )}
              </span>
              <div className="min-w-0">
                <div
                  className={`text-[14px] leading-5 ${
                    step.status === 'pending' ? 'text-gray-400' : 'text-gray-800'
                  } ${step.status === 'active' ? 'font-medium' : ''}`}
                >
                  {step.label}
                  {step.status === 'active' ? '…' : ''}
                </div>
                {step.detail && step.status !== 'pending' && (
                  <div className="text-[12px] text-gray-500 tabular-nums mt-0.5">{step.detail}</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {fallback && secs >= fallback.afterSeconds && progress.phase !== 'opening' && (
        <button
          type="button"
          onClick={fallback.onOpen}
          className="mt-3 w-full rounded-xl border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-blue-50"
          style={{ borderColor: `${BLUE}40`, color: BLUE }}
        >
          {fallback.label}
        </button>
      )}
    </motion.div>
  );
}
