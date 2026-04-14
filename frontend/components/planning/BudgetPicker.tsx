'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { DollarSign, SkipForward } from 'lucide-react';

const presets = [
  { label: 'Budget', amount: 500, emoji: '$' },
  { label: 'Mid-range', amount: 1500, emoji: '$$' },
  { label: 'Comfortable', amount: 3000, emoji: '$$$' },
  { label: 'Luxury', amount: 5000, emoji: '$$$$' },
];

type BudgetPickerProps = {
  onSelect: (budget: number, perPerson: boolean) => void;
  onSkip?: () => void;
};

export default function BudgetPicker({ onSelect, onSkip }: BudgetPickerProps) {
  const [perPerson, setPerPerson] = useState(true);

  return (
    <motion.div
      className="flex flex-col gap-4 w-full"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="grid grid-cols-4 gap-3 items-stretch">
        {presets.map((preset, i) => (
          <motion.button
            key={preset.label}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25, delay: i * 0.06 }}
            onClick={() => onSelect(preset.amount, perPerson)}
            className="h-full flex flex-col items-center justify-center gap-1.5 px-5 py-5 rounded-2xl border border-white/10 text-white/70 hover:text-white hover:border-[#4f8ef7]/40 text-[16px] transition-all hover:scale-[1.04] active:scale-[0.97]"
            style={{ background: 'rgba(255,255,255,0.04)' }}
          >
            <span className="text-[#4f8ef7] font-semibold text-[17px]">{preset.emoji}</span>
            <span>{preset.label}</span>
            <span className="text-white/30 text-[13px]">~${preset.amount.toLocaleString()}</span>
          </motion.button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={perPerson}
            onChange={(e) => setPerPerson(e.target.checked)}
            className="w-4 h-4 rounded border-white/20 bg-transparent accent-[#4f8ef7]"
          />
          <span className="text-white/40 text-[15px]">Per person</span>
        </label>
        {onSkip && (
          <button
            onClick={onSkip}
            className="flex items-center gap-1.5 text-white/25 hover:text-white/40 text-[15px] transition-colors"
          >
            Skip <SkipForward size={16} />
          </button>
        )}
      </div>
    </motion.div>
  );
}
