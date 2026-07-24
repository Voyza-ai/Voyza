'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Compass, Sparkles, Map, ArrowRight, LucideIcon } from 'lucide-react';
import Navbar from '@/components/shared/Navbar';
import { useAuthStore } from '@/store/authStore';
import { getTrips } from '@/lib/api';
import {
  Stage,
  BrowseRotator,
  ConversationDemo,
  TripsRotator,
  type HubTrip,
} from '@/components/main/HubVisuals';

type HubCard = {
  key: string;
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
  href: string | null;
  /**
   * Each card gets its own accent, and wears it as ONE flat tint — no
   * gradient, and the preview area shares the card's colour rather than
   * sitting on a surface of its own. All three hues stay in the same cool
   * family as the blue navbar and the #f0f4f8 page wash.
   */
  accent: string;
};

const CARDS: HubCard[] = [
  {
    key: 'browse',
    icon: Compass,
    title: 'Browse',
    description:
      'Explore popular itineraries, like a marketplace. Pick any one and make it your own.',
    cta: 'Browse trips',
    href: '/browse',
    accent: '#2563eb',
  },
  {
    key: 'describe',
    icon: Sparkles,
    title: 'Describe your trip',
    description:
      'Tell us what you want in plain words and we’ll turn it into a full itinerary.',
    cta: 'Start describing',
    href: '/plan',
    accent: '#7c5cf5',
  },
  {
    key: 'current',
    icon: Map,
    title: 'View or edit trips',
    description:
      'Jump back into a trip you’ve already started and keep refining it.',
    cta: 'Open my trips',
    href: '/history',
    accent: '#0d9488',
  },
];

export default function MainPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [hovered, setHovered] = useState<string | null>(null);
  const [trips, setTrips] = useState<HubTrip[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);

  // The "View or edit trips" preview shows the user's real trips, so fetch
  // them once the session is known. Signed-out visitors skip the call and
  // get the empty-state copy instead.
  useEffect(() => {
    if (!user) {
      setTrips([]);
      return;
    }
    let cancelled = false;
    setTripsLoading(true);
    getTrips()
      .then((data) => {
        if (cancelled) return;
        setTrips(((data?.trips ?? []) as HubTrip[]).slice(0, 6));
      })
      .catch(() => {
        // Preview is decorative — a failed fetch just falls back to the
        // empty state rather than surfacing an error on the hub.
        if (!cancelled) setTrips([]);
      })
      .finally(() => {
        if (!cancelled) setTripsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSelect = (card: HubCard) => {
    if (card.href) router.push(card.href);
  };

  const renderVisual = (card: HubCard, active: boolean) => {
    if (card.key === 'browse') return <BrowseRotator active={active} accent={card.accent} />;
    if (card.key === 'describe') return <ConversationDemo active={active} accent={card.accent} />;
    return (
      <TripsRotator active={active} accent={card.accent} trips={trips} loading={tripsLoading} />
    );
  };

  return (
    <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
      <Navbar />

      <div className="pt-20 px-6 pb-10 max-w-6xl mx-auto">
        {/* Header */}
        <div className="text-center mb-7">
          <h1 className="text-[28px] font-bold text-gray-900">Where to next?</h1>
          <p className="text-sm text-gray-500 mt-1">
            Choose how you’d like to start planning your trip.
          </p>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {CARDS.map((card, idx) => {
            const Icon = card.icon;
            const active = hovered === card.key;
            return (
              <motion.button
                key={card.key}
                onClick={() => handleSelect(card)}
                onMouseEnter={() => setHovered(card.key)}
                onMouseLeave={() => setHovered((h) => (h === card.key ? null : h))}
                onFocus={() => setHovered(card.key)}
                onBlur={() => setHovered((h) => (h === card.key ? null : h))}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: idx * 0.08, ease: 'easeOut' }}
                whileHover={{ y: -4 }}
                className="group relative flex flex-col items-stretch text-center rounded-2xl border shadow-sm hover:shadow-md transition-shadow p-6 min-h-[540px] outline-none"
                style={{
                  // One flat accent tint across the whole card — no gradient,
                  // and the preview area shares the same surface rather than
                  // sitting on a panel of its own.
                  background: `${card.accent}14`,
                  borderColor: active ? `${card.accent}66` : `${card.accent}24`,
                }}
              >
                {/* Heading, centred at the top of the card. */}
                <div className="flex flex-col items-center">
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 mb-3"
                    style={{ background: card.accent, boxShadow: `0 6px 16px ${card.accent}40` }}
                  >
                    <Icon size={26} color="#ffffff" />
                  </div>
                  <h2 className="text-[19px] font-bold text-gray-900">{card.title}</h2>
                </div>
                <p className="text-[13px] leading-relaxed text-gray-500 mt-2 px-1">
                  {card.description}
                </p>

                {/* Stage takes the whole rest of the card — the preview is
                    the main event, not a thumbnail. Sits on white so the
                    preview content stays readable against the card wash. */}
                <div className="w-full flex-1 mt-5 mb-5 min-h-0">
                  <Stage>
                    <AnimatePresence mode="wait">
                      {active ? (
                        <motion.div
                          key="preview"
                          className="absolute inset-0"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          {renderVisual(card, active)}
                        </motion.div>
                      ) : (
                        /* At rest: a big, calm version of the card's mark,
                           so the empty stage still reads as deliberate. */
                        <motion.div
                          key="idle"
                          className="absolute inset-0 flex items-center justify-center"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          <div
                            className="w-20 h-20 rounded-2xl flex items-center justify-center"
                            style={{ background: `${card.accent}0a` }}
                          >
                            <Icon size={30} style={{ color: `${card.accent}66` }} />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </Stage>
                </div>

                {/* CTA pinned to the bottom, centred under the preview */}
                <div
                  className="mx-auto inline-flex items-center gap-1.5 text-[13px] font-semibold px-4 py-2 rounded-full transition-colors"
                  style={{
                    color: card.accent,
                    background: active ? `${card.accent}1a` : `${card.accent}0f`,
                  }}
                >
                  {card.cta}
                  <ArrowRight
                    size={15}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>
    </main>
  );
}
