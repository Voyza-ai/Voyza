'use client';

import { motion } from 'framer-motion';

/**
 * Landing hero text — editorial headline on the dusk sky: oversized tight
 * sans in white with ONE accent word in Instrument Serif italic (the
 * "designed, not templated" cue), followed by specific subcopy that says
 * what Voyza actually does. Matches the planning chat's dark surface
 * (#0f0f1a family + #4f8ef7 blue), not a generic dark theme.
 */
export default function LogoReveal() {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <motion.h1
        className="text-[46px] sm:text-[60px] font-bold tracking-[-0.03em] leading-[1.04] text-white max-w-3xl"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
        style={{ textShadow: '0 2px 30px rgba(10,14,30,0.45)' }}
      >
        The{' '}
        <em
          className="not-italic"
          style={{
            fontFamily: 'var(--font-serif), Georgia, serif',
            fontStyle: 'italic',
            fontWeight: 400,
            color: '#7BB8FF',
          }}
        >
          smartest
        </em>{' '}
        way
        <br className="hidden sm:block" /> to travel.
      </motion.h1>

      <motion.p
        className="text-[16.5px] leading-relaxed max-w-xl"
        style={{ color: 'rgba(237,241,250,0.62)' }}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.35, ease: 'easeOut' }}
      >
        Voyza compares{' '}
        <span className="font-medium" style={{ color: 'rgba(237,241,250,0.92)' }}>
          flights, trains and ferries
        </span>{' '}
        across your whole route in one search — then plans every day of the trip.
        Less money, less searching, more vibes.
      </motion.p>
    </div>
  );
}
