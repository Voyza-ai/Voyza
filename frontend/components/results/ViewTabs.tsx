'use client';

import { motion } from 'framer-motion';
import { GitBranch, Calendar, CalendarRange, Map as MapIcon } from 'lucide-react';

export type ResultsView = 'flowchart' | 'calendar' | 'schedule' | 'map';

type ViewTabsProps = {
  value: ResultsView;
  onChange: (v: ResultsView) => void;
};

const TABS: { id: ResultsView; label: string; icon: typeof GitBranch }[] = [
  { id: 'flowchart', label: 'Flowchart', icon: GitBranch },
  { id: 'calendar', label: 'Calendar', icon: Calendar },
  { id: 'schedule', label: 'Schedule', icon: CalendarRange },
  { id: 'map', label: 'Map', icon: MapIcon },
];

/**
 * View switcher for the results page. Lives INSIDE the blue Navbar (passed
 * via its `tabs` prop) rather than as a page row — that frees a full row of
 * vertical space so the cards get the whole viewport height. Styled
 * white-on-blue to sit on the navbar; the active pill inverts to white.
 */
export default function ViewTabs({ value, onChange }: ViewTabsProps) {
  return (
    <div
      className="inline-flex items-center gap-0.5 p-0.5 rounded-full border"
      style={{ background: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.25)' }}
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`relative flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] rounded-full transition-colors ${
              active ? '' : 'text-white/70 hover:text-white'
            }`}
            style={active ? { color: '#2563eb' } : undefined}
          >
            {active && (
              <motion.div
                layoutId="active-view-tab"
                className="absolute inset-0 rounded-full"
                style={{ background: '#ffffff' }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
            <Icon size={13} className="relative z-10" />
            <span className="relative z-10 font-medium">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
