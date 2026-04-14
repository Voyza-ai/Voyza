'use client';

import { motion } from 'framer-motion';
import { Umbrella, Mountain, Compass, Landmark, Drama } from 'lucide-react';

const vibes = [
  { label: 'Beachy', icon: Umbrella, color: '#f59e0b' },
  { label: 'Skiing', icon: Mountain, color: '#60a5fa' },
  { label: 'Adventure', icon: Compass, color: '#34d399' },
  { label: 'Architecture', icon: Landmark, color: '#a78bfa' },
  { label: 'Culture', icon: Drama, color: '#f472b6' },
];

type VibePillsProps = {
  onSelect: (vibe: string) => void;
};

export default function VibePills({ onSelect }: VibePillsProps) {
  return (
    <div className="flex flex-wrap gap-3 w-full">
      {vibes.map((vibe, i) => {
        const Icon = vibe.icon;
        return (
          <motion.button
            key={vibe.label}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25, delay: i * 0.06 }}
            onClick={() => onSelect(vibe.label)}
            className="flex items-center gap-2.5 px-5 py-3.5 rounded-full border border-white/10 text-white/70 hover:text-white text-[16px] transition-all hover:scale-[1.04] active:scale-[0.97]"
            style={{
              background: 'rgba(255,255,255,0.04)',
            }}
            whileHover={{
              borderColor: vibe.color,
              boxShadow: `0 0 16px ${vibe.color}20`,
            }}
          >
            <Icon size={20} style={{ color: vibe.color }} />
            {vibe.label}
          </motion.button>
        );
      })}
    </div>
  );
}
