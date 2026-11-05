'use client';

import { TrainFront, X } from 'lucide-react';
import { useState } from 'react';
import type { Trip } from '@/lib/types';
import { joinRegions, tripNoRailRegions } from '@/lib/railCoverage';

/**
 * One quiet line under the results header when the trip has legs in a region
 * we have no train data for (US, Canada, Australia, Africa, South America).
 * Without it those legs read as "flights are the only option" when in fact we
 * never had trains to show. The affected legs carry their own note too (see
 * Connector's `noRailRegion`). Informational, so neutral grey rather than the
 * amber warning style, and dismissible.
 */
export default function NoRailDataNotice({ trip }: { trip: Pick<Trip, 'cities'> }) {
  const [dismissed, setDismissed] = useState(false);
  const regions = tripNoRailRegions(trip);
  if (dismissed || regions.length === 0) return null;

  return (
    <div className="mx-8 mt-3 mb-1" role="note" data-testid="no-rail-notice">
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-xl border bg-white"
        style={{ borderColor: 'rgba(0,0,0,0.08)' }}
      >
        <TrainFront size={13} style={{ color: '#888', opacity: 0.7 }} className="flex-shrink-0" />
        <span className="flex-1 min-w-0 text-gray-600 text-[12px]">
          We don&apos;t have train data for {joinRegions(regions)} yet, so legs there show flights only.
        </span>
        <button
          onClick={() => setDismissed(true)}
          className="flex-shrink-0 text-gray-400 hover:text-gray-700 transition-colors p-0.5"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
