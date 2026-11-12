'use client';

import { motion } from 'framer-motion';
import { Umbrella, Mountain, Compass, Landmark, Drama } from 'lucide-react';

const vibes = [
  { label: 'Beachy', icon: Umbrella, color: '#d97706' },
  { label: 'Skiing', icon: Mountain, color: '#0284c7' },
  { label: 'Adventure', icon: Compass, color: '#059669' },
  { label: 'Architecture', icon: Landmark, color: '#7c3aed' },
  { label: 'Culture', icon: Drama, color: '#db2777' },
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
            className="flex items-center gap-2.5 px-5 py-3.5 rounded-full border border-gray-200 text-gray-700 hover:text-gray-900 text-[16px] transition-all hover:scale-[1.04] active:scale-[0.97]"
            style={{
              background: '#ffffff',
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
