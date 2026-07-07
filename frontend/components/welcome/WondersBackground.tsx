'use client';

import { motion } from 'framer-motion';

// 7 Wonders as a subtle background grid
const wonders = [
  {
    name: 'Christ the Redeemer',
    src: 'https://images.unsplash.com/photo-1483729558449-99ef09a8c325?w=600&q=75&auto=format&fit=crop',
  },
  {
    name: 'Chichen Itza',
    src: 'https://images.unsplash.com/photo-1518638150340-f706e86654de?w=600&q=75&auto=format&fit=crop',
  },
  {
    name: 'Machu Picchu',
    src: 'https://images.unsplash.com/photo-1587595431973-160d0d94add1?w=600&q=75&auto=format&fit=crop',
  },
  {
    name: 'Taj Mahal',
    src: 'https://images.unsplash.com/photo-1564507592333-c60657eea523?w=600&q=75&auto=format&fit=crop',
  },
  {
    name: 'Great Wall of China',
    src: 'https://images.unsplash.com/photo-1508804185872-d7badad00f7d?w=600&q=75&auto=format&fit=crop',
  },
  {
    name: 'Colosseum',
    src: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=600&q=75&auto=format&fit=crop',
  },
  {
    name: 'Petra',
    src: 'https://images.unsplash.com/photo-1548786811-dd6e453ccca7?w=600&q=75&auto=format&fit=crop',
  },
];

/**
 * Deterministic star field — positions derive from the index (golden-angle
 * spread), NOT Math.random(), so server and client render identically (no
 * hydration mismatch). Stars sit in the upper ~65% of the sky and twinkle
 * on staggered clocks.
 */
const STARS = Array.from({ length: 44 }, (_, i) => ({
  left: (i * 137.508) % 100,
  top: (i * 61.8 + 7) % 65,
  size: 1 + (i % 3) * 0.7,
  duration: 2.6 + (i % 5) * 0.8,
  delay: (i % 7) * 0.55,
  bright: i % 4 === 0,
}));

export default function WondersBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
      <style jsx>{`
        @keyframes wonderZoom {
          from { transform: scale(1) translate3d(0, 0, 0); }
          to   { transform: scale(1.14) translate3d(1.5%, -1.5%, 0); }
        }
        @keyframes starTwinkle {
          0%, 100% { opacity: 0.12; }
          50%      { opacity: 0.9; }
        }
        @media (prefers-reduced-motion: reduce) {
          .wonder-img, .voyza-star { animation: none !important; }
        }
      `}</style>

      {/* Photo grid — 4 columns, 2 rows, each cell slowly drifting (Ken Burns) */}
      <motion.div
        className="absolute inset-0 grid grid-cols-4 grid-rows-2 gap-1"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.12 }}
        transition={{ duration: 2, delay: 0.5, ease: 'easeOut' }}
      >
        {wonders.map((wonder, i) => (
          <div key={wonder.name} className="relative overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={wonder.src}
              alt={wonder.name}
              className="wonder-img w-full h-full object-cover"
              loading={i < 4 ? 'eager' : 'lazy'}
              style={{
                animation: `wonderZoom ${16 + (i % 4) * 4}s ease-in-out infinite alternate`,
                animationDelay: `${-(i * 3)}s`,
              }}
            />
          </div>
        ))}
        {/* 8th cell — repeat first image to fill the grid */}
        <div className="relative overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={wonders[0].src}
            alt="Travel"
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      </motion.div>

      {/* Aurora glows — three blurred color fields drifting slowly. Voyza
          blue, violet, and a whisper of the train-green from the palette. */}
      <motion.div
        className="absolute w-[700px] h-[700px] rounded-full"
        style={{
          top: '-15%',
          left: '-10%',
          background: 'radial-gradient(circle, rgba(79,142,247,0.32) 0%, transparent 65%)',
          filter: 'blur(60px)',
        }}
        animate={{ x: [0, 120, 30, 0], y: [0, 60, 140, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute w-[600px] h-[600px] rounded-full"
        style={{
          top: '30%',
          right: '-12%',
          background: 'radial-gradient(circle, rgba(124,92,255,0.26) 0%, transparent 65%)',
          filter: 'blur(70px)',
        }}
        animate={{ x: [0, -140, -40, 0], y: [0, -70, 50, 0] }}
        transition={{ duration: 32, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute w-[520px] h-[520px] rounded-full"
        style={{
          bottom: '-20%',
          left: '30%',
          background: 'radial-gradient(circle, rgba(34,192,136,0.16) 0%, transparent 65%)',
          filter: 'blur(70px)',
        }}
        animate={{ x: [0, 90, -60, 0], y: [0, -50, -10, 0] }}
        transition={{ duration: 38, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Star field — deterministic positions, staggered twinkle */}
      <div className="absolute inset-0">
        {STARS.map((s, i) => (
          <span
            key={i}
            className="voyza-star absolute rounded-full"
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              background: s.bright ? 'rgba(210,228,255,0.95)' : 'rgba(255,255,255,0.75)',
              boxShadow: s.bright ? '0 0 6px rgba(160,200,255,0.9)' : 'none',
              opacity: 0.12,
              animation: `starTwinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
            }}
          />
        ))}
      </div>

      {/* Dark vignette overlay — fades grid toward center for readability */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 50% 50% at 50% 40%, rgba(15, 15, 26, 0.95) 0%, rgba(15, 15, 26, 0.6) 60%, rgba(15, 15, 26, 0.3) 100%)',
        }}
      />
    </div>
  );
}
