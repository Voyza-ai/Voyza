'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Umbrella, Mountain, Compass, Landmark, Drama, ArrowRight } from 'lucide-react';
import { MAX_VIBES } from '@/lib/vibes';

const vibes = [
  { label: 'Beachy', icon: Umbrella, color: '#d97706' },
  { label: 'Skiing', icon: Mountain, color: '#0284c7' },
  { label: 'Adventure', icon: Compass, color: '#059669' },
  { label: 'Architecture', icon: Landmark, color: '#7c3aed' },
  { label: 'Culture', icon: Drama, color: '#db2777' },
];

type VibePillsProps = {
  /** The pills picked so far, in the order they were picked. */
  selected: string[];
  /** A pill was toggled: the new selection (never more than MAX_VIBES). */
  onChange: (next: string[]) => void;
  /** "Continue" or Enter: confirm the selection. */
  onContinue: () => void;
  /**
   * Whether Continue can run. Defaults to "a pill is picked"; the planner
   * also allows it when vibe text has been typed alongside.
   */
  canContinue?: boolean;
  /** Hide the Continue button (the editor brings its own Save/Cancel). */
  hideContinue?: boolean;
};

/**
 * The vibe step: pick one to three vibes, then Continue — all on ONE row.
 *
 * A click toggles a pill (brand blue when on, as the city picker's pills).
 * Continue is the compact arrow at the end of the row. At three picks the
 * other pills dim and stop responding, so a fourth click does nothing rather
 * than silently swapping one out; there is no hint text (owner's call).
 * A picked pill keeps its width — no check mark — and nothing wraps: the
 * row is sized to fit the planner's 768px column (measured at 1280 and
 * 1440 wide).
 * Enter confirms whenever focus is on a pill or nowhere in particular.
 */
export default function VibePills({
  selected,
  onChange,
  onContinue,
  canContinue,
  hideContinue = false,
}: VibePillsProps) {
  const ready = canContinue ?? selected.length > 0;
  const atMax = selected.length >= MAX_VIBES;
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the row on screen as picks change: the chat scrolls to the newest
  // message, not to a widget under it.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    rootRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [selected.length]);

  const toggle = (label: string) => {
    if (selected.includes(label)) {
      onChange(selected.filter((v) => v !== label));
    } else if (!atMax) {
      onChange([...selected, label]);
    }
  };

  // Enter confirms. A pill keeps focus after a click, and Enter on a button
  // would otherwise toggle it again; with focus on the page itself (Safari
  // doesn't focus clicked buttons) there is nothing else Enter could mean.
  // Typed inputs are left alone: the chat bar handles its own Enter.
  const continueRef = useRef(onContinue);
  continueRef.current = onContinue;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    if (hideContinue) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement as HTMLElement | null;
      const onPill = !!active?.closest?.('[data-vibe-pill]') && !!rootRef.current?.contains(active);
      const onPage = !active || active === document.body;
      if (!onPill && !onPage) return;
      e.preventDefault();
      if (readyRef.current) continueRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hideContinue]);

  return (
    <div
      ref={rootRef}
      className="flex flex-nowrap items-stretch gap-2 w-full"
      role="group"
      aria-label={`Pick up to ${MAX_VIBES} vibes`}
      data-testid="vibe-pills"
    >
      {vibes.map((vibe, i) => {
        const Icon = vibe.icon;
        const on = selected.includes(vibe.label);
        const blocked = !on && atMax;
        return (
          <motion.button
            key={vibe.label}
            type="button"
            data-vibe-pill={vibe.label}
            aria-pressed={on}
            aria-disabled={blocked || undefined}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25, delay: i * 0.06 }}
            onClick={() => toggle(vibe.label)}
            className={`flex flex-shrink-0 items-center gap-2 px-4 py-3.5 rounded-full border text-[16px] whitespace-nowrap transition-colors ${
              on
                ? 'bg-[#2563eb] border-[#2563eb] text-white'
                : blocked
                  ? 'bg-white border-gray-200 text-gray-400 opacity-50 cursor-not-allowed'
                  : 'bg-white border-gray-200 text-gray-700 hover:text-gray-900 hover:border-gray-400'
            }`}
          >
            <Icon size={20} style={{ color: on ? '#ffffff' : vibe.color }} />
            {vibe.label}
          </motion.button>
        );
      })}

      {!hideContinue && (
        <button
          type="button"
          onClick={() => ready && onContinue()}
          disabled={!ready}
          aria-label="Continue"
          title="Continue"
          className="flex flex-shrink-0 items-center justify-center w-[52px] rounded-full bg-[#2563eb] hover:bg-[#1d4ed8] text-white transition-colors disabled:opacity-40 disabled:hover:bg-[#2563eb] disabled:cursor-not-allowed"
        >
          <ArrowRight size={20} />
        </button>
      )}
    </div>
  );
}
