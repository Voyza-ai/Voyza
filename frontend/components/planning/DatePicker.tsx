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
            className="px-5 py-3 rounded-full border border-gray-200 text-gray-700 hover:text-gray-900 hover:border-[#2563eb]/40 text-[16px] transition-all hover:scale-[1.04] active:scale-[0.97]"
            style={{ background: '#ffffff' }}
          >
            {s}
          </motion.button>
        ))}
        <button
          onClick={onSkip}
          className="flex items-center gap-1.5 text-gray-500 hover:text-gray-700 text-[15px] transition-colors whitespace-nowrap ml-1"
        >
          Skip <SkipForward size={16} />
        </button>
      </div>
    </motion.div>
  );
}
