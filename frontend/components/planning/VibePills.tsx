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
  /** Button text — "Save" when editing an earlier answer. */
  continueLabel?: string;
  /** Hide the Continue row (the editor brings its own Save/Cancel). */
  hideContinue?: boolean;
};

/**
 * The vibe step: pick one to three vibes, then Continue.
 *
 * A click toggles a pill (brand blue when on, as the city picker's pills).
 * A picked pill keeps its width — no check mark — so picking never re-wraps
 * the row and pushes Continue out of view.
 * At three, the other pills dim and stop responding, and the hint says why —
 * a fourth click does nothing rather than silently swapping one out.
 * Enter confirms whenever focus is on a pill or nowhere in particular.
 */
export default function VibePills({
  selected,
  onChange,
  onContinue,
  canContinue,
  continueLabel = 'Continue',
  hideContinue = false,
}: VibePillsProps) {
  const ready = canContinue ?? selected.length > 0;
  const atMax = selected.length >= MAX_VIBES;
  const rootRef = useRef<HTMLDivElement>(null);
  const continueRowRef = useRef<HTMLDivElement>(null);

  // Keep Continue on screen as picks change: the chat scrolls to the newest
  // message, not to a widget that grew under it (a narrower window wraps
  // the pills).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    continueRowRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
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
    <div ref={rootRef} className="flex flex-col gap-4 w-full" data-testid="vibe-pills">
      <div className="flex flex-wrap gap-3 w-full" role="group" aria-label={`Pick up to ${MAX_VIBES} vibes`}>
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
              className={`flex items-center gap-2.5 px-5 py-3.5 rounded-full border text-[16px] transition-colors ${
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
      </div>

      {!hideContinue && (
        <div ref={continueRowRef} className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => ready && onContinue()}
            disabled={!ready}
            className="flex items-center gap-2 bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-semibold px-6 py-3 rounded-full text-[15px] transition-colors disabled:opacity-40 disabled:hover:bg-[#2563eb] disabled:cursor-not-allowed"
          >
            {continueLabel}
            <ArrowRight size={18} />
          </button>
          <VibeHint count={selected.length} />
        </div>
      )}
      {hideContinue && <VibeHint count={selected.length} />}
    </div>
  );
}

/** "Pick up to 3", or at the cap why the other pills went quiet. */
export function VibeHint({ count }: { count: number }) {
  return (
    <span className="text-[13px] text-gray-500" aria-live="polite" data-testid="vibe-hint">
      {count >= MAX_VIBES ? `That's ${MAX_VIBES} — unpick one to swap` : `Pick up to ${MAX_VIBES}`}
    </span>
  );
}
