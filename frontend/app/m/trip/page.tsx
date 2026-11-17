'use client';

import { Suspense } from 'react';
import MobileTrip from '@/components/mobile/MobileTrip';

// useSearchParams (?tripId=, ?share=) needs a Suspense boundary at build time.
export default function MobileTripPage() {
  return (
    <Suspense fallback={null}>
      <MobileTrip />
    </Suspense>
  );
}
