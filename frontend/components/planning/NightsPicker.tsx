'use client';

import { motion } from 'framer-motion';
import { Moon, SkipForward } from 'lucide-react';

/**
 * Quick presets for trip duration. The middle of each range is what
 * we send to the optimizer (matches how budget presets work — show a
 * range to the user, send a representative value to the backend).
 *
 * "Custom" is intentionally last and feeds the chat-bar input — typing
 * "10 nights" or just "10" submits via handleBarSubmit's `nights` case.
 */
const PRESETS: { label: string; nights: number }[] = [
  { label: '3-4 nights', nights: 4 },
  { label: '5-7 nights', nights: 6 },
  { label: '8-10 nights', nights: 9 },
  { label: '11-14 nights', nights: 12 },
  { label: '2+ weeks', nights: 18 },
];

type NightsPickerProps = {
  onSelect: (nights: number) => void;
  onSkip?: () => void;
};

export default function NightsPicker({ onSelect, onSkip }: NightsPickerProps) {
  return (
    <motion.div
      className="flex flex-col gap-4 w-full"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex flex-wrap gap-3 items-center">
        {PRESETS.map((p, i) => (
          <motion.button
            key={p.label}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25, delay: i * 0.06 }}
            onClick={() => onSelect(p.nights)}
            className="flex items-center gap-2.5 px-5 py-3.5 rounded-full border border-gray-200 text-gray-700 hover:text-gray-900 hover:border-[#2563eb]/40 text-[16px] transition-all hover:scale-[1.04] active:scale-[0.97]"
            style={{ background: '#ffffff' }}
          >
            <Moon size={17} className="text-[#2563eb]" />
            {p.label}
          </motion.button>
        ))}
        {onSkip && (
          <button
            onClick={onSkip}
            className="flex items-center gap-1.5 text-gray-500 hover:text-gray-700 text-[15px] transition-colors whitespace-nowrap ml-1"
          >
            Skip <SkipForward size={16} />
          </button>
        )}
      </div>
    </motion.div>
  );
}
