'use client';

import { useEffect, useState } from 'react';
import { TrainFront } from 'lucide-react';
import { fetchRailDemand, type RailDemand } from '@/lib/api';

/**
 * One line under the hub's cards: how many trips planned on BlueMurr include
 * a train (backend services/railDemand.ts). Shows nothing while loading, on
 * an error, or when there are too few trips to quote a share.
 */
export default function RailDemandStat() {
  const [stat, setStat] = useState<RailDemand | null>(null);
  useEffect(() => {
    let live = true;
    fetchRailDemand()
      .then((s) => live && setStat(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!stat || stat.percent === null) return null;
  return (
    <p
      data-testid="rail-demand-stat"
      className="mt-6 flex items-center justify-center gap-2 text-[13px] text-gray-500"
    >
      <TrainFront size={14} style={{ color: '#2563eb' }} />
      <span>
        <span className="font-semibold" style={{ color: '#2563eb' }}>
          {stat.percent}%
        </span>{' '}
        of multi-city trips planned on BlueMurr include a train leg
        <span className="text-gray-400">
          {' '}
          ({stat.tripsWithTrain.toLocaleString()} of {stat.tripsWithLegs.toLocaleString()})
        </span>
      </span>
    </p>
  );
}
