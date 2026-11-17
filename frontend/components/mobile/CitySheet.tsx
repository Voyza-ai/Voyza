'use client';

import { useState, useEffect } from 'react';
import { ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import type { Trip } from '@/lib/types';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import ActivitiesDetailPanel from '@/components/results/ActivitiesDetailPanel';
import BottomSheet from './BottomSheet';
import { M } from './theme';

type Props = {
  trip: Trip;
  index: number | null;
  onClose: () => void;
  onIndexChange: (i: number) => void;
  editable: boolean;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
};

/**
 * A city's full guide in a sheet: the same stay panel (hotels, swaps, your
 * own hotel) and things-to-do panel (activities, restaurants, day planner)
 * the desktop opens, plus the canvas's move / remove for this stop.
 */
export default function CitySheet({ trip, index, onClose, onIndexChange, editable, onMove, onRemove }: Props) {
  const [tab, setTab] = useState<'stay' | 'todo'>('stay');
  useEffect(() => {
    if (index === null) setTab('stay');
  }, [index]);
  const city = index !== null ? trip.cities[index] : null;
  const n = trip.cities.length;

  return (
    <BottomSheet
      open={index !== null && !!city}
      onClose={onClose}
      tall
      title={city?.name ?? ''}
      subtitle={
        <div className="mt-2 inline-flex p-1 rounded-full bg-gray-100" role="tablist">
          {(
            [
              ['stay', 'Stay & hotels'],
              ['todo', 'Things to do'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`min-h-[36px] px-4 rounded-full text-[14px] font-medium ${tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
            >
              {label}
            </button>
          ))}
        </div>
      }
      testId="m-city-sheet"
      footer={
        editable && index !== null && n > 1 ? (
          <div className="flex items-center gap-2 px-4 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] border-t" style={{ borderColor: M.line }}>
            <button
              onClick={() => onMove(index, index - 1)}
              disabled={index === 0}
              className="min-h-[44px] flex-1 flex items-center justify-center gap-1.5 rounded-xl border text-[14px] text-gray-700 disabled:opacity-30"
              style={{ borderColor: M.line }}
            >
              <ArrowUp size={15} /> Earlier
            </button>
            <button
              onClick={() => onMove(index, index + 1)}
              disabled={index === n - 1}
              className="min-h-[44px] flex-1 flex items-center justify-center gap-1.5 rounded-xl border text-[14px] text-gray-700 disabled:opacity-30"
              style={{ borderColor: M.line }}
            >
              <ArrowDown size={15} /> Later
            </button>
            <button
              onClick={() => onRemove(index)}
              className="min-h-[44px] flex-1 flex items-center justify-center gap-1.5 rounded-xl border text-[14px] text-red-600"
              style={{ borderColor: '#fecaca' }}
            >
              <Trash2 size={15} /> Remove
            </button>
          </div>
        ) : undefined
      }
    >
      {index !== null && city && (
        <div className="m-panel h-full px-3 pb-3">
          {tab === 'stay' ? (
            <CityDetailPanel
              trip={trip}
              cityIndex={index}
              onClose={onClose}
              onPrev={() => index > 0 && onIndexChange(index - 1)}
              onNext={() => index < n - 1 && onIndexChange(index + 1)}
            />
          ) : (
            <ActivitiesDetailPanel
              trip={trip}
              cityIndex={index}
              onClose={onClose}
              onPrev={() => index > 0 && onIndexChange(index - 1)}
              onNext={() => index < n - 1 && onIndexChange(index + 1)}
            />
          )}
        </div>
      )}
    </BottomSheet>
  );
}
