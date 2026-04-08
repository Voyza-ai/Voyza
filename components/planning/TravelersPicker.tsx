'use client';

import { motion } from 'framer-motion';
import { User, Users } from 'lucide-react';

const options = [
  { count: 1, label: 'Just me', icon: User },
  { count: 2, label: '2', icon: Users },
  { count: 3, label: '3', icon: Users },
  { count: 4, label: '4', icon: Users },
  { count: 5, label: '5+', icon: Users },
];

type TravelersPickerProps = {
  onSelect: (count: number) => void;
};

export default function TravelersPicker({ onSelect }: TravelersPickerProps) {
  return (
    <div className="flex flex-wrap gap-3">
      {options.map((opt, i) => {
        const Icon = opt.icon;
        return (
          <motion.button
            key={opt.count}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25, delay: i * 0.06 }}
            onClick={() => onSelect(opt.count)}
            className="flex items-center gap-2.5 px-5 py-3.5 rounded-full border border-white/10 text-white/70 hover:text-white hover:border-[#4f8ef7]/40 text-[16px] transition-all hover:scale-[1.04] active:scale-[0.97]"
            style={{ background: 'rgba(255,255,255,0.04)' }}
          >
            <Icon size={19} className="text-[#4f8ef7]" />
            {opt.label}
          </motion.button>
        );
      })}
    </div>
  );
}
