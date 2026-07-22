'use client';

/**
 * Hover previews for the three hub cards on /main.
 *
 * Each visual is inert until its card is hovered — `active` gates every
 * timer, and going inactive resets the visual to its first frame so the
 * next hover always replays from the start rather than resuming mid-loop.
 * Nothing animates on page load, which keeps the hub calm until the user
 * actually points at something.
 *
 * Users who ask for reduced motion get the first frame, held still.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PRESET_ITINERARIES, presetNights, presetCost } from '@/data/presetItineraries';

/** True when the OS asks for reduced motion. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Steps an index 0..length-1 on an interval, but only while `active`.
 * Returns to 0 the moment it goes inactive.
 */
function useRotator(active: boolean, length: number, intervalMs: number): number {
  const reduced = usePrefersReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active || reduced || length <= 1) {
      setI(0);
      return;
    }
    const id = setInterval(() => setI((n) => (n + 1) % length), intervalMs);
    return () => clearInterval(id);
  }, [active, reduced, length, intervalMs]);
  return i;
}

/**
 * The preview surface. Fills whatever space the card gives it (the card
 * lets it flex, so the animation owns most of the card's height) and
 * positions its children absolutely, so swapping resting-icon → animation
 * never shifts the layout.
 */
export function Stage({ children }: { children: React.ReactNode }) {
  return <div className="relative w-full h-full overflow-hidden rounded-xl">{children}</div>;
}

const slide = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -14 },
  transition: { duration: 0.32, ease: 'easeOut' as const },
};

/* ─────────────── Browse: rotate through the marketplace ─────────────── */

export function BrowseRotator({ active, accent }: { active: boolean; accent: string }) {
  const idx = useRotator(active, PRESET_ITINERARIES.length, 1700);
  const preset = PRESET_ITINERARIES[idx];
  const chain = preset.cities.map((c) => c.name);

  return (
    <div className="absolute inset-0 flex flex-col justify-center px-4 pb-5">
      <AnimatePresence mode="wait">
        <motion.div key={preset.slug} {...slide}>
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 mb-2">
            <span className="text-[20px] leading-none">{preset.flags}</span>
            <span
              className="text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-white whitespace-nowrap"
              style={{ color: accent }}
            >
              {preset.scope}
            </span>
          </div>

          <div className="text-[16px] font-bold text-gray-900 leading-snug mb-2">
            {preset.title}
          </div>

          {/* City chain — the route, wrapped over as many lines as it needs. */}
          <div className="flex flex-wrap items-center justify-center gap-y-1 mb-3">
            {chain.slice(0, 4).map((name, i) => (
              <span key={name} className="flex items-center">
                {i > 0 && <span className="w-3 border-t border-dashed border-gray-300 mx-1.5" />}
                <span className="text-[11px] font-medium text-gray-700">{name}</span>
              </span>
            ))}
            {chain.length > 4 && (
              <span className="text-[11px] text-gray-400 ml-1.5">+{chain.length - 4}</span>
            )}
          </div>

          <div className="text-[12px] text-gray-500">
            {preset.cities.length} cities · {presetNights(preset)} nights ·{' '}
            <span className="font-semibold" style={{ color: accent }}>
              ~${presetCost(preset).toLocaleString()}
            </span>
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Progress ticks — how far through the catalog the preview is. */}
      <div className="absolute bottom-2 left-4 right-4 flex gap-1">
        {PRESET_ITINERARIES.map((p, i) => (
          <div
            key={p.slug}
            className="h-[2px] flex-1 rounded-full transition-colors duration-300"
            style={{ background: i === idx ? accent : 'rgba(0,0,0,0.08)' }}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────── Describe: a conversation playing out ─────────────── */

/** Scripted two-turn exchange: ask for a trip, then change your mind. */
const SCRIPT: Array<{ from: 'user' | 'ai'; text: string }> = [
  { from: 'user', text: '10 days in Japan — temples and food' },
  { from: 'ai', text: 'Tokyo → Hakone → Kyoto → Osaka' },
  { from: 'user', text: 'Can it be cheaper?' },
  { from: 'ai', text: 'Swapped 2 flights for rail — saves $240' },
];

// Springs, not linear eases — the thread should settle rather than snap.
const BUBBLE_SPRING = { type: 'spring' as const, stiffness: 420, damping: 34, mass: 0.8 };
const SHIFT_SPRING = { type: 'spring' as const, stiffness: 320, damping: 32, mass: 0.9 };

export function ConversationDemo({ active, accent }: { active: boolean; accent: string }) {
  const reduced = usePrefersReducedMotion();
  // How many scripted messages are on screen, whether the assistant is
  // "typing" the next one, and whether the thread is fading out to replay.
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(0);
      setTyping(false);
      setFading(false);
      return;
    }
    if (reduced) {
      setShown(SCRIPT.length);
      setTyping(false);
      setFading(false);
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      setFading(false);
      setShown(0);
      setTyping(false);

      let t = 320;
      SCRIPT.forEach((msg, i) => {
        if (msg.from === 'ai') {
          // Assistant thinks before answering. The dots occupy the slot the
          // reply will land in, so the swap reads as one continuous motion
          // instead of two separate pop-ins.
          timers.push(setTimeout(() => setTyping(true), t));
          t += 820;
          timers.push(
            setTimeout(() => {
              setTyping(false);
              setShown(i + 1);
            }, t),
          );
          t += 980;
        } else {
          timers.push(setTimeout(() => setShown(i + 1), t));
          t += 900;
        }
      });

      // Hold the finished conversation, then fade the whole thread out before
      // replaying — far calmer than every bubble vanishing at once.
      const holdEnd = t + 2600;
      timers.push(setTimeout(() => setFading(true), holdEnd));
      timers.push(setTimeout(run, holdEnd + 620));
    };
    run();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [active, reduced]);

  return (
    <motion.div
      className="absolute inset-0 flex flex-col justify-end gap-2 px-4 pb-4"
      animate={{ opacity: fading ? 0 : 1 }}
      transition={{ duration: 0.5, ease: 'easeInOut' }}
    >
      {/* popLayout keeps exiting bubbles out of the flow, so the remaining
          ones glide to their new positions instead of jumping. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {SCRIPT.slice(0, shown).map((msg, i) => (
          <motion.div
            key={i}
            layout
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ layout: SHIFT_SPRING, default: BUBBLE_SPRING }}
            className={
              msg.from === 'user'
                ? 'self-end max-w-[88%] text-left text-[11.5px] leading-snug px-3 py-2 rounded-2xl rounded-br-sm text-white'
                : 'self-start max-w-[92%] text-left text-[11.5px] font-medium leading-snug px-3 py-2 rounded-2xl rounded-bl-sm bg-white border border-black/5 text-gray-800'
            }
            style={msg.from === 'user' ? { background: accent } : undefined}
          >
            {msg.text}
          </motion.div>
        ))}

        {/* Typing indicator — same layout group as the bubbles, so the thread
            shifts up for it and then hands its place to the reply. */}
        {typing && (
          <motion.div
            key="typing"
            layout
            initial={{ opacity: 0, y: 10, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ layout: SHIFT_SPRING, default: BUBBLE_SPRING }}
            className="self-start flex gap-1 px-3 py-2.5 rounded-2xl rounded-bl-sm bg-white border border-black/5"
          >
            {[0, 1, 2].map((d) => (
              <motion.span
                key={d}
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: '#9ca3af' }}
                animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  ease: 'easeInOut',
                  delay: d * 0.16,
                }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ─────────────── View or edit: rotate the user's own trips ─────────────── */

export type HubTrip = {
  id: string;
  title: string;
  cities: string[];
  total_cost: number;
  city_count: number;
};

export function TripsRotator({
  active,
  accent,
  trips,
  loading,
}: {
  active: boolean;
  accent: string;
  trips: HubTrip[];
  loading: boolean;
}) {
  const idx = useRotator(active, trips.length, 1600);

  if (loading) {
    return (
      <div className="absolute inset-0 flex flex-col justify-center px-4 gap-2.5">
        <div className="h-4 w-2/3 rounded bg-gray-100 animate-pulse" />
        <div className="h-3 w-1/2 rounded bg-gray-100 animate-pulse" />
        <div className="h-3 w-1/4 rounded bg-gray-100 animate-pulse" />
      </div>
    );
  }

  // Signed out, or signed in with nothing saved yet.
  if (trips.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center px-4">
        <p className="text-[12px] text-gray-400 leading-snug text-center">
          Trips you save will show up here.
        </p>
      </div>
    );
  }

  const trip = trips[Math.min(idx, trips.length - 1)];
  const chain = trip.cities ?? [];

  return (
    <div className="absolute inset-0 flex flex-col justify-center px-4 pb-5">
      <AnimatePresence mode="wait">
        <motion.div key={trip.id} {...slide}>
          <div className="text-[16px] font-bold text-gray-900 leading-snug mb-2.5">
            {trip.title || chain.join(' · ') || 'Untitled trip'}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-y-1 mb-3">
            {chain.slice(0, 4).map((name, i) => (
              <span key={`${name}-${i}`} className="flex items-center">
                {i > 0 && <span className="w-3 border-t border-dashed border-gray-300 mx-1.5" />}
                <span className="text-[11px] font-medium text-gray-700">{name}</span>
              </span>
            ))}
            {chain.length > 4 && (
              <span className="text-[11px] text-gray-400 ml-1.5">+{chain.length - 4}</span>
            )}
          </div>

          <div className="text-[12px] text-gray-500">
            {trip.city_count ?? chain.length} cities ·{' '}
            <span className="font-semibold" style={{ color: accent }}>
              ${(trip.total_cost ?? 0).toLocaleString()}
            </span>
          </div>
        </motion.div>
      </AnimatePresence>

      <div className="absolute bottom-2 left-4 right-4 flex gap-1">
        {trips.map((t, i) => (
          <div
            key={t.id}
            className="h-[2px] flex-1 rounded-full transition-colors duration-300"
            style={{ background: i === idx ? accent : 'rgba(0,0,0,0.08)' }}
          />
        ))}
      </div>
    </div>
  );
}
