'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Sparkles, Compass, Map, ArrowRight, LucideIcon } from 'lucide-react';

type StartPillsProps = {
  show: boolean;
};

type Pill = {
  icon: LucideIcon;
  title: string;
  blurb: string;
  href: string;
  accent: string;
};

// The three ways in — same destinations as the old /main hub, surfaced
// directly on the landing as long horizontal pills. Accent colors echo the
// destination pins the plane just dropped, tying the intro to the choices.
const PILLS: Pill[] = [
  {
    icon: Sparkles,
    title: 'Describe your trip',
    blurb: 'Tell Voyza AI in plain words — it plans the rest',
    href: '/plan',
    accent: '#3D8BFF',
  },
  {
    icon: Compass,
    title: 'Browse itineraries',
    blurb: 'Hand-crafted trips you can make your own',
    href: '/browse',
    accent: '#E2725B',
  },
  {
    icon: Map,
    title: 'My Trips',
    blurb: 'Jump back into a trip you already started',
    href: '/history',
    accent: '#2FB57C',
  },
];

/**
 * Three long pills on the landing page — the primary entry points, stacked
 * vertically, each a full-width rounded pill with a colored icon badge,
 * title + one-line blurb, and an arrow that slides on hover.
 */
export default function StartPills({ show }: StartPillsProps) {
  if (!show) return null;

  return (
    <motion.div
      className="flex flex-col items-stretch gap-3 w-full max-w-md"
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.1, delayChildren: 0.15 } },
      }}
    >
      {PILLS.map((pill) => {
        const Icon = pill.icon;
        return (
          <motion.div
            key={pill.href}
            variants={{
              hidden: { opacity: 0, y: 14 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
            }}
          >
            <Link
              href={pill.href}
              className="group relative flex items-center gap-4 w-full rounded-full pl-3 pr-5 py-3 transition-all duration-200 hover:-translate-y-0.5"
              style={{
                background: 'rgba(255,255,255,0.055)',
                border: '1px solid rgba(255,255,255,0.12)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = `${pill.accent}66`;
                e.currentTarget.style.background = 'rgba(255,255,255,0.09)';
                e.currentTarget.style.boxShadow = `0 8px 30px ${pill.accent}22`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
                e.currentTarget.style.background = 'rgba(255,255,255,0.055)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {/* Icon badge */}
              <span
                className="flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center"
                style={{
                  background: `${pill.accent}22`,
                  border: `1px solid ${pill.accent}55`,
                }}
              >
                <Icon size={19} style={{ color: pill.accent }} />
              </span>

              {/* Text */}
              <span className="flex flex-col min-w-0 flex-1 text-left">
                <span className="text-[15px] font-semibold text-white leading-tight">
                  {pill.title}
                </span>
                <span className="text-[12px] text-white/45 leading-tight mt-0.5 truncate">
                  {pill.blurb}
                </span>
              </span>

              {/* Arrow */}
              <ArrowRight
                size={17}
                className="flex-shrink-0 text-white/30 transition-all duration-200 group-hover:translate-x-1"
                style={{ color: undefined }}
              />
            </Link>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
