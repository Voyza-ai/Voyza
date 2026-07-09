'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { MapPin, ArrowRight, Compass, Luggage } from 'lucide-react';
import { useTripStore } from '@/store/tripStore';

/**
 * The landing's primary action — a travel-site search box (form first,
 * white bar floating on the dusk sky), plus two REAL secondary buttons in
 * the app's own button language (planning chat: white/10 fills, white/20
 * borders, blue hover, gentle scale — see PlanningChat's intent picker).
 *
 * Typed trips seed the planning chat via rawInput; /plan preserves the
 * seed across its clean-slate reset. Empty submit just opens the planner.
 */
export default function HeroTripInput() {
  const router = useRouter();
  const setAnswer = useTripStore((s) => s.setAnswer);
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    const v = value.trim();
    if (v) setAnswer('rawInput', v);
    router.push('/plan');
  };

  return (
    <motion.div
      className="flex flex-col items-center w-full max-w-xl gap-5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.55, ease: 'easeOut' }}
    >
      {/* Search bar — white, floating on the sky */}
      <div
        className="w-full flex items-center gap-2 bg-white rounded-full pl-5 pr-2 py-2 transition-shadow focus-within:shadow-[0_0_0_3px_rgba(79,142,247,0.35)]"
        style={{ boxShadow: '0 18px 50px rgba(5,8,20,0.45)' }}
      >
        <MapPin size={17} className="flex-shrink-0 text-gray-400" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
          }}
          placeholder="Where do you want to go? Try “Portugal and Italy, 10 days”"
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-[15px] text-gray-900 placeholder-gray-400 py-2"
        />
        <button
          onClick={handleSubmit}
          className="flex items-center gap-1.5 text-white font-medium pl-5 pr-4 py-2.5 rounded-full text-[14.5px] flex-shrink-0 transition-all hover:brightness-110 hover:scale-[1.02] active:scale-[0.98]"
          style={{ background: '#4f8ef7' }}
        >
          Plan my trip
          <ArrowRight size={15} />
        </button>
      </div>

      {/* Secondary actions — real buttons, app button language */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/browse')}
          className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[14px] font-medium text-gray-900 bg-white transition-all hover:scale-[1.03] active:scale-[0.97]"
          style={{ boxShadow: '0 8px 26px rgba(5,8,20,0.35)' }}
        >
          <Compass size={16} style={{ color: '#4f8ef7' }} />
          Browse itineraries
        </button>
        <button
          onClick={() => router.push('/history')}
          className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[14px] font-medium text-white border border-white/25 transition-all hover:border-[#4f8ef7]/60 hover:scale-[1.03] active:scale-[0.97]"
          style={{ background: 'rgba(255,255,255,0.08)' }}
        >
          <Luggage size={16} style={{ color: '#7BB8FF' }} />
          My Trips
        </button>
      </div>
    </motion.div>
  );
}
