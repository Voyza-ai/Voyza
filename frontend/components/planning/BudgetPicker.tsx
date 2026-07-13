'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { SkipForward } from 'lucide-react';

type BudgetPickerProps = {
  onSelect: (budget: number, perPerson: boolean) => void;
  onSkip?: () => void;
};

const MIN = 100;
const MAX = 10000;
const STEP = 100;
const DEFAULT = 1500;

/**
 * Budget picker v2 — a slider between visible min/max instead of four
 * hardcoded tier pills (user feedback). Drag to the number, live readout,
 * per-person/total toggle, confirm. Same props as the pill version so
 * both the guided flow and the conversational planner use it unchanged.
 */
export default function BudgetPicker({ onSelect, onSkip }: BudgetPickerProps) {
  const [perPerson, setPerPerson] = useState(true);
  const [amount, setAmount] = useState(DEFAULT);

  const pct = ((amount - MIN) / (MAX - MIN)) * 100;

  return (
    <motion.div
      className="flex flex-col gap-5 w-full"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Live readout */}
      <div className="flex items-baseline justify-center gap-2">
        <span className="text-[34px] font-bold text-white tabular-nums">
          ${amount.toLocaleString()}
        </span>
        <span className="text-white/35 text-[14px]">
          {perPerson ? 'per person' : 'total'}
          {amount >= MAX ? '+' : ''}
        </span>
      </div>

      {/* Slider with min/max labels */}
      <div className="flex flex-col gap-1.5">
        <input
          type="range"
          min={MIN}
          max={MAX}
          step={STEP}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          aria-label="Budget amount"
          className="voyza-budget-slider w-full cursor-pointer"
          style={{
            // filled track up to the thumb
            background: `linear-gradient(90deg, #4f8ef7 0%, #4f8ef7 ${pct}%, rgba(255,255,255,0.12) ${pct}%, rgba(255,255,255,0.12) 100%)`,
          }}
        />
        <style jsx>{`
          .voyza-budget-slider {
            -webkit-appearance: none;
            appearance: none;
            height: 6px;
            border-radius: 999px;
            outline: none;
          }
          .voyza-budget-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            background: #ffffff;
            border: 3px solid #4f8ef7;
            box-shadow: 0 2px 10px rgba(79, 142, 247, 0.45);
            cursor: grab;
          }
          .voyza-budget-slider::-moz-range-thumb {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            background: #ffffff;
            border: 3px solid #4f8ef7;
            box-shadow: 0 2px 10px rgba(79, 142, 247, 0.45);
            cursor: grab;
          }
        `}</style>
        <div className="flex justify-between text-[12px] text-white/30">
          <span>${MIN.toLocaleString()} min</span>
          <span>${MAX.toLocaleString()}+ max</span>
        </div>
      </div>

      {/* Per-person toggle + actions */}
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
        <div className="flex items-center gap-4">
          {onSkip && (
            <button
              onClick={onSkip}
              className="flex items-center gap-1.5 text-white/25 hover:text-white/40 text-[15px] transition-colors"
            >
              Skip <SkipForward size={16} />
            </button>
          )}
          <button
            onClick={() => onSelect(amount, perPerson)}
            className="px-6 py-2.5 rounded-xl text-[15px] font-medium text-white transition-all hover:brightness-110 hover:scale-[1.03] active:scale-[0.97]"
            style={{ background: '#4f8ef7' }}
          >
            Set budget
          </button>
        </div>
      </div>
    </motion.div>
  );
}
