'use client';

import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Compass, Sparkles, Map, ArrowRight, LucideIcon } from 'lucide-react';
import Navbar from '@/components/shared/Navbar';

type HubCard = {
  key: string;
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
  href: string | null;
};

const CARDS: HubCard[] = [
  {
    key: 'browse',
    icon: Compass,
    title: 'Browse',
    description:
      'Explore popular itineraries, like a marketplace. Pick any one and make it your own.',
    cta: 'Browse trips',
    // Blank placeholder for now — marketplace UI lands in a later pass.
    href: '/browse',
  },
  {
    key: 'describe',
    icon: Sparkles,
    title: 'Describe your trip',
    description:
      'Tell us what you want in plain words and we’ll turn it into a full itinerary.',
    cta: 'Start describing',
    href: '/plan',
  },
  {
    key: 'current',
    icon: Map,
    title: 'View or edit trips',
    description:
      'Jump back into a trip you’ve already started and keep refining it.',
    cta: 'Open my trips',
    href: '/history',
  },
];

export default function MainPage() {
  const router = useRouter();

  const handleSelect = (card: HubCard) => {
    if (card.href) router.push(card.href);
    // Cards without a route (Browse) are wired up in a later pass.
  };

  return (
    <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
      <Navbar />

      <div className="pt-20 px-6 pb-10 max-w-5xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-[26px] font-bold text-gray-900">Where to next?</h1>
          <p className="text-sm text-gray-500 mt-1">
            Choose how you’d like to start planning your trip.
          </p>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {CARDS.map((card, idx) => {
            const Icon = card.icon;
            return (
              <motion.button
                key={card.key}
                onClick={() => handleSelect(card)}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: idx * 0.08, ease: 'easeOut' }}
                whileHover={{ y: -4 }}
                className="group flex flex-col items-start text-left bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow p-6 min-h-[260px]"
              >
                {/* Icon badge */}
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-5"
                  style={{ background: 'rgba(37,99,235,0.08)' }}
                >
                  <Icon size={22} style={{ color: '#2563eb' }} />
                </div>

                {/* Title + description */}
                <h2 className="text-[17px] font-semibold text-gray-900 mb-2">
                  {card.title}
                </h2>
                <p className="text-[13px] leading-relaxed text-gray-500">
                  {card.description}
                </p>

                {/* CTA pinned to the bottom */}
                <div className="mt-auto pt-5 flex items-center gap-1.5 text-[13px] font-medium" style={{ color: '#2563eb' }}>
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
