'use client';

import { useTripStore } from '@/store/tripStore';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import Navbar from '@/components/shared/Navbar';
import ResultsHeader from '@/components/results/ResultsHeader';
import Flowchart from '@/components/results/Flowchart';
import CalendarView from '@/components/results/CalendarView';
import ViewTabs, { ResultsView } from '@/components/results/ViewTabs';
import AIChatPanel from '@/components/results/AIChatPanel';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import { mockTrip } from '@/lib/mockData';

// Next.js 14 requires useSearchParams() to be wrapped in a <Suspense> boundary
// during the static build pass. We split the page into an outer wrapper that
// provides the boundary and an inner component that actually uses the hook.
export default function ResultsPage() {
  return (
    <Suspense fallback={null}>
      <ResultsPageInner />
    </Suspense>
  );
}

function ResultsPageInner() {
  const { currentTrip, setTrip } = useTripStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isDemo = searchParams.get('demo') === '1';
  const [view, setView] = useState<ResultsView>('flowchart');
  const [openCityIndex, setOpenCityIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!currentTrip && isDemo) {
      setTrip(mockTrip);
      return;
    }
    if (!currentTrip && !isDemo) {
      router.push('/plan');
    }
  }, [currentTrip, router, isDemo, setTrip]);

  if (!currentTrip) return null;

  const handleCityClick = (cityIndex: number) => {
    setOpenCityIndex(cityIndex);
  };

  return (
    <main className="min-h-screen bg-voyza-bg text-white">
      <Navbar />

      <div className="flex flex-col lg:flex-row gap-6 px-6 pb-10 pt-16 max-w-[1600px] mx-auto">
        {/* Main column */}
        <div className="flex-1 min-w-0">
          <ResultsHeader trip={currentTrip} />
          <ViewTabs value={view} onChange={setView} />

          {openCityIndex !== null ? (
            <CityDetailPanel
              trip={currentTrip}
              cityIndex={openCityIndex}
              onClose={() => setOpenCityIndex(null)}
              onPrev={() => setOpenCityIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
              onNext={() =>
                setOpenCityIndex((i) =>
                  i !== null && i < currentTrip.cities.length - 1 ? i + 1 : i
                )
              }
            />
          ) : view === 'flowchart' ? (
            <Flowchart trip={currentTrip} onCityClick={handleCityClick} />
          ) : (
            <CalendarView trip={currentTrip} onCityClick={handleCityClick} />
          )}

          {/* "Why this trip is cheaper" moved into the AI chat — ask it there */}
        </div>

        {/* AI chat sidebar */}
        <aside className="lg:w-[380px] lg:flex-shrink-0 lg:sticky lg:top-20 lg:h-[calc(100vh-6rem)] mt-8">
          <AIChatPanel trip={currentTrip} />
        </aside>
      </div>
    </main>
  );
}
