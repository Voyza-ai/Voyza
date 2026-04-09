'use client';

import { motion } from 'framer-motion';
import { GitBranch, Calendar } from 'lucide-react';

export type ResultsView = 'flowchart' | 'calendar';

type ViewTabsProps = {
  value: ResultsView;
  onChange: (v: ResultsView) => void;
};

const TABS: { id: ResultsView; label: string; icon: typeof GitBranch }[] = [
  { id: 'flowchart', label: 'Flowchart', icon: GitBranch },
  { id: 'calendar', label: 'Calendar', icon: Calendar },
];

export default function ViewTabs({ value, onChange }: ViewTabsProps) {
  return (
    <div className="px-8 -mt-4">
      <div
        className="inline-flex items-center gap-1 p-1 rounded-full border backdrop-blur-md"
        style={{
          background: 'rgba(255,255,255,0.025)',
          borderColor: 'rgba(255,255,255,0.08)',
        }}
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = value === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={`relative flex items-center gap-1.5 px-4 py-2 text-[13px] rounded-full transition-colors ${
                active ? 'text-white' : 'text-white/45 hover:text-white/70'
              }`}
            >
              {active && (
                <motion.div
                  layoutId="active-view-tab"
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: 'rgba(79,142,247,0.18)',
                    border: '1px solid rgba(79,142,247,0.4)',
                  }}
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              )}
              <Icon size={13} className="relative z-10" />
              <span className="relative z-10 font-medium">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
