'use client';

import { motion } from 'framer-motion';

type LogoRevealProps = {
  show: boolean;
};

export default function LogoReveal({ show }: LogoRevealProps) {
  if (!show) return null;

  return (
    <div className="flex flex-col items-center gap-3">
      {/* VOYZA logo */}
      <motion.h1
        className="text-[60px] font-bold tracking-tight"
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
        className="text-lg text-white/50 text-center max-w-md font-medium"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3, ease: 'easeOut' }}
      >
        The smartest way to travel. Less money, less searching, more vibes.
      </motion.p>
    </div>
  );
}
