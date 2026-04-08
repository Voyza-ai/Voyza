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

export default function WondersBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
      {/* Photo grid — 4 columns, 2 rows filling the screen */}
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
              className="w-full h-full object-cover"
              loading={i < 4 ? 'eager' : 'lazy'}
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
