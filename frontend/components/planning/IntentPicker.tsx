'use client';

import { motion } from 'framer-motion';
import { MapPin, Sparkles, Wallet, MessageCircle } from 'lucide-react';

type Intent = 'place' | 'vibe' | 'budget' | 'chat';

type IntentPickerProps = {
  onSelect: (intent: Intent) => void;
};

const paths: { intent: Intent; icon: typeof MapPin; label: string; desc: string; color: string; hoverBorder: string }[] = [
  {
    intent: 'place',
    icon: MapPin,
    label: 'I know where I want to go',
    desc: 'Name your cities and I\'ll find the cheapest way to connect them — flights, trains, or both.',
    color: '#4f8ef7',
    hoverBorder: 'hover:border-[#4f8ef7]/40',
  },
  {
    intent: 'vibe',
    icon: Sparkles,
    label: 'I\'m chasing a vibe',
    desc: 'Tell me the feeling — beachy, adventure, culture — and I\'ll suggest destinations that match.',
    color: '#f59e0b',
    hoverBorder: 'hover:border-[#f59e0b]/40',
  },
  {
    intent: 'budget',
    icon: Wallet,
    label: 'I know my budget',
    desc: 'Tell me what you can spend and I\'ll show you the best trips your money can buy.',
    color: '#34d399',
    hoverBorder: 'hover:border-[#34d399]/40',
  },
];

export default function IntentPicker({ onSelect }: IntentPickerProps) {
  return (
    <div className="flex flex-col gap-5 w-full">
      {/* Three equal-size horizontal squares */}
      <div className="grid grid-cols-3 gap-5 items-stretch">
        {paths.map((opt, i) => {
          const Icon = opt.icon;
          return (
            <motion.button
              key={opt.intent}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.08 }}
              onClick={() => onSelect(opt.intent)}
              className={`aspect-square w-full h-full flex flex-col items-center justify-center text-center gap-4 p-6 rounded-3xl border border-white/10 transition-all hover:scale-[1.02] active:scale-[0.97] ${opt.hoverBorder} group`}
              style={{ background: 'rgba(255,255,255,0.03)' }}
            >
              <div
                className="p-4 rounded-2xl flex-shrink-0"
                style={{ background: `${opt.color}18` }}
              >
                <Icon size={34} style={{ color: opt.color }} />
              </div>
              <span className="text-white/90 text-[17px] font-semibold group-hover:text-white transition-colors leading-snug">
                {opt.label}
              </span>
              <span className="text-white/40 text-[14px] leading-relaxed">
                {opt.desc}
              </span>
            </motion.button>
          );
        })}
      </div>

      {/* Subtle open chat option */}
      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.35 }}
        onClick={() => onSelect('chat')}
        className="flex items-center justify-center gap-2 pt-1 text-white/25 hover:text-white/45 text-[14px] transition-colors"
      >
        <MessageCircle size={15} />
        <span>Or just tell me everything at once</span>
      </motion.button>
    </div>
  );
}
