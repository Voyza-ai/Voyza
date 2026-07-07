'use client';

import { motion } from 'framer-motion';

type LogoRevealProps = {
  show: boolean;
};

const LETTERS = ['V', 'O', 'Y', 'Z', 'A'];
const TAGLINE_WORDS = 'The smartest way to travel. Less money, less searching, more vibes.'.split(' ');

/**
 * Logo reveal v2 — letters land one by one (blur → sharp, spring pop),
 * then a light shimmer sweeps across the wordmark and repeats gently.
 * Tagline follows word by word.
 */
export default function LogoReveal({ show }: LogoRevealProps) {
  if (!show) return null;

  return (
    <div className="flex flex-col items-center gap-3">
      <style jsx>{`
        @keyframes logoShimmer {
          0%   { background-position: 130% 0; }
          18%  { background-position: -30% 0; }
          100% { background-position: -30% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .voyza-shimmer { animation: none !important; opacity: 0 !important; }
        }
      `}</style>

      {/* Wordmark — staggered letters with a shimmer overlay */}
      <div className="relative">
        <h1
          className="text-[60px] font-bold tracking-tight flex"
          style={{ color: '#4f8ef7', textShadow: '0 0 40px rgba(79,142,247,0.3)' }}
          aria-label="VOYZA"
        >
          {LETTERS.map((letter, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0, y: 22, filter: 'blur(10px)', scale: 0.9 }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)', scale: 1 }}
              transition={{
                delay: 0.08 * i,
                type: 'spring',
                stiffness: 320,
                damping: 20,
              }}
            >
              {letter}
            </motion.span>
          ))}
        </h1>

        {/* Shimmer sweep — a moving light band clipped to the text. Runs
            once shortly after the letters land, then repeats every ~7s. */}
        <span
          className="voyza-shimmer absolute inset-0 text-[60px] font-bold tracking-tight flex select-none"
          aria-hidden
          style={{
            color: 'transparent',
            background:
              'linear-gradient(110deg, transparent 38%, rgba(235,245,255,0.9) 50%, transparent 62%)',
            backgroundSize: '220% 100%',
            backgroundPosition: '130% 0',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            animation: 'logoShimmer 7s ease-in-out 0.9s infinite',
          }}
        >
          VOYZA
        </span>
      </div>

      {/* Tagline — word-by-word rise */}
      <p className="text-lg text-white/50 text-center max-w-md font-medium flex flex-wrap justify-center gap-x-[0.35em]">
        {TAGLINE_WORDS.map((word, i) => (
          <motion.span
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 + i * 0.045, duration: 0.4, ease: 'easeOut' }}
          >
            {word}
          </motion.span>
        ))}
      </p>
    </div>
  );
}
