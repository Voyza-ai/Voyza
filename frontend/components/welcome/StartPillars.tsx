'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Sparkles, Compass, Luggage, ArrowRight, LucideIcon } from 'lucide-react';

type StartPillarsProps = {
  show: boolean;
};

type Pillar = {
  icon: LucideIcon;
  title: string;
  body: string;
  cta: string;
  href: string;
  accent: string;
};

// Three tall pillars — the ways into Voyza, each written to actually SELL
// what that path does. Accent colors echo the destination pins + the
// capability chip (Flights / Trains / Ferries).
const PILLARS: Pillar[] = [
  {
    icon: Sparkles,
    title: 'Describe your trip',
    body:
      'Tell Voyza AI where you want to go in plain words. It compares flights, trains & ferries across your whole route and builds a complete day-by-day plan — stays, food, and everything between.',
    cta: 'Start planning',
    href: '/plan',
    accent: '#3D8BFF',
  },
  {
    icon: Compass,
    title: 'Browse itineraries',
    body:
      'Not sure where to start? Open a hand-crafted route across Europe and beyond, see the full breakdown, and make any of them your own in a single tap.',
    cta: 'Explore trips',
    href: '/browse',
    accent: '#E2725B',
  },
  {
    icon: Luggage,
    title: 'My Trips',
    body:
      'Every trip you plan is saved and fully editable. Jump back in, refine the route, swap hotels or dates, and keep it ready for when you book.',
    cta: 'Open my trips',
    href: '/history',
    accent: '#2FB57C',
  },
];

/**
 * Three tall pillars on the landing — vertical columns side by side (not
 * wide stacked pills). Each is a full-height card with an accent glow, icon,
 * headline, a real description of the offering, and a CTA that slides on
 * hover. Replaces the old /main hub; carries the "what Voyza does" message.
 */
export default function StartPillars({ show }: StartPillarsProps) {
  if (!show) return null;

  return (
    <motion.div
      className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl"
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.12, delayChildren: 0.1 } },
      }}
    >
      {PILLARS.map((pillar) => {
        const Icon = pillar.icon;
        return (
          <motion.div
            key={pillar.href}
            className="h-full"
            variants={{
              hidden: { opacity: 0, y: 22 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: 'easeOut' } },
            }}
          >
            <Link
              href={pillar.href}
              className="group relative flex flex-col h-full min-h-[300px] rounded-2xl p-5 overflow-hidden transition-transform duration-200 hover:-translate-y-1"
              style={{
                background: 'rgba(10,14,30,0.55)',
                border: '1px solid rgba(255,255,255,0.10)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = `${pillar.accent}66`;
                e.currentTarget.style.boxShadow = `0 16px 40px ${pillar.accent}22`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {/* Accent glow bleeding down from the top */}
              <div
                className="absolute -top-16 left-1/2 -translate-x-1/2 w-44 h-44 rounded-full pointer-events-none"
                style={{ background: `radial-gradient(circle, ${pillar.accent}26 0%, transparent 70%)` }}
              />

              {/* Icon badge */}
              <span
                className="relative w-12 h-12 rounded-xl flex items-center justify-center mb-4 flex-shrink-0"
                style={{ background: `${pillar.accent}1f`, border: `1px solid ${pillar.accent}55` }}
              >
                <Icon size={22} style={{ color: pillar.accent }} />
              </span>

              {/* Headline + body */}
              <h3 className="relative text-[17px] font-semibold text-white mb-2 leading-snug">
                {pillar.title}
              </h3>
              <p className="relative text-[12.5px] leading-relaxed text-white/55">
                {pillar.body}
              </p>

              {/* CTA pinned to the bottom */}
              <div
                className="relative mt-auto pt-5 flex items-center gap-1.5 text-[13px] font-semibold"
                style={{ color: pillar.accent }}
              >
                {pillar.cta}
                <ArrowRight size={15} className="transition-transform group-hover:translate-x-1" />
              </div>
            </Link>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
