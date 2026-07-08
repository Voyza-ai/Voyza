'use client';

import { motion } from 'framer-motion';
import { Plane, TrainFront, Ship } from 'lucide-react';

type LogoRevealProps = {
  show: boolean;
};

export default function LogoReveal({ show }: LogoRevealProps) {
  if (!show) return null;

  return (
    <div className="flex flex-col items-center gap-3">
      {/* VOYZA logo */}
      <motion.h1
        className="text-[60px] font-bold tracking-tight leading-none"
        style={{
          color: '#4f8ef7',
          textShadow: '0 0 40px rgba(79,142,247,0.3)',
        }}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        VOYZA
      </motion.h1>

      {/* Tagline */}
      <motion.p
        className="text-lg text-white/55 text-center max-w-lg font-medium"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3, ease: 'easeOut' }}
      >
        The smartest way to travel. Less money, less searching, more vibes.
      </motion.p>

      {/* Capability chip — the actual differentiator, stated plainly: Voyza
          optimizes across every way to get there, not just flights. Modes
          are color-coded to match the destination pins + pillar accents. */}
      <motion.div
        className="flex items-center gap-2.5 px-4 py-1.5 rounded-full text-[12.5px] mt-0.5"
        style={{
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(255,255,255,0.04)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
        }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.5, ease: 'easeOut' }}
      >
        <span className="flex items-center gap-1 text-white/75">
          <Plane size={13} style={{ color: '#7BB8FF' }} /> Flights
        </span>
        <span className="text-white/25">·</span>
        <span className="flex items-center gap-1 text-white/75">
          <TrainFront size={13} style={{ color: '#2FB57C' }} /> Trains
        </span>
        <span className="text-white/25">·</span>
        <span className="flex items-center gap-1 text-white/75">
          <Ship size={13} style={{ color: '#E2725B' }} /> Ferries
        </span>
        <span className="text-white/25">·</span>
        <span className="text-white/45">compared in one search</span>
      </motion.div>
    </div>
  );
}
