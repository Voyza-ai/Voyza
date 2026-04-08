'use client';

import { motion } from 'framer-motion';
import { SkipForward } from 'lucide-react';

type DatePickerProps = {
  onSelect: (start: string, end: string, flexible: boolean) => void;
  onSkip: () => void;
};

export default function DatePicker({ onSelect, onSkip }: DatePickerProps) {
  const suggestions = [
    'This summer',
    'Next month',
    "I'm flexible",
  ];

  return (
    <motion.div
      className="flex flex-col gap-4 w-full"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex flex-wrap gap-3 items-center">
        {suggestions.map((s, i) => (
          <motion.button
            key={s}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, delay: i * 0.06 }}
            onClick={() => onSelect(s, '', true)}
            className="px-5 py-3 rounded-full border border-white/10 text-white/70 hover:text-white hover:border-[#4f8ef7]/40 text-[16px] transition-all hover:scale-[1.04] active:scale-[0.97]"
            style={{ background: 'rgba(255,255,255,0.04)' }}
          >
            {s}
          </motion.button>
        ))}
        <button
          onClick={onSkip}
          className="flex items-center gap-1.5 text-white/25 hover:text-white/40 text-[15px] transition-colors whitespace-nowrap ml-1"
        >
          Skip <SkipForward size={16} />
        </button>
      </div>
    </motion.div>
  );
}
