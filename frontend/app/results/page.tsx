'use client';

import { useTripStore } from '@/store/tripStore';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef, Suspense } from 'react';
import Navbar from '@/components/shared/Navbar';
import ResultsHeader from '@/components/results/ResultsHeader';
import Flowchart from '@/components/results/Flowchart';
import CalendarView from '@/components/results/CalendarView';
import ViewTabs, { ResultsView } from '@/components/results/ViewTabs';
import AIChatPanel from '@/components/results/AIChatPanel';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import ActivitiesDetailPanel from '@/components/results/ActivitiesDetailPanel';
import { searchHotels, saveTrip as saveTripApi } from '@/lib/api';
import { Hotel } from '@/lib/types';
import { getCurrentUser } from '@/lib/supabase';
import { Bookmark } from 'lucide-react';
import LoginModal from '@/components/shared/LoginModal';

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
  const tripId = searchParams.get('tripId');
  const [view, setView] = useState<ResultsView>('flowchart');
  const [openCityIndex, setOpenCityIndex] = useState<number | null>(null);
  const [openActivitiesIndex, setOpenActivitiesIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [saveToast, setSaveToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const doSaveTrip = async () => {
    if (!currentTrip || saving) return;
    setSaving(true);
    try {
      const result = await saveTripApi(currentTrip);
      setSaveToast({ type: 'success', message: 'Trip saved!' });
      window.history.replaceState(null, '', `?tripId=${result.tripId}`);
    } catch {
      setSaveToast({ type: 'error', message: 'Failed to save trip' });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveToast(null), 3000);
    }
  };

  const handleSaveTrip = async () => {
    const user = await getCurrentUser();
    if (!user) {
      setShowLoginModal(true);
      return;
    }
    doSaveTrip();
  };

  useEffect(() => {
    // If we already have a trip in the store (e.g. from PlanningChat), use it
    if (currentTrip) return;

    // If a tripId is provided, fetch the trip from the backend
    if (tripId) {
      setLoading(true);
      const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
      fetch(`${BASE_URL}/api/trips/${tripId}`)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to load trip (${res.status})`);
          return res.json();
        })
        .then((data) => {
          setTrip(data.trip ?? data);
          setLoading(false);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
      return;
    }

    // No trip in store and no tripId — redirect to planning
    router.push('/plan');
  }, [currentTrip, tripId, router, setTrip]);

  // Enrich cities with real hotel data if hotels[] is empty
  const updateCity = useTripStore((s) => s.updateCity);
  const hotelsFetchedRef = useRef(false);

  useEffect(() => {
    if (!currentTrip || hotelsFetchedRef.current) return;
    hotelsFetchedRef.current = true;

    currentTrip.cities.forEach((city, idx) => {
      // Skip if city already has hotels populated (e.g. from backend optimizer)
      if (city.hotels.length > 1) return;

      searchHotels({
        city: city.name,
        checkin: city.dates.arrival,
        checkout: city.dates.departure,
        adults: currentTrip.travelers,
      })
        .then((results) => {
          if (results.length === 0) return;
          const hotels: Hotel[] = results.map((r) => ({
            name: r.name,
            rating: r.rating,
            pricePerNight: r.pricePerNight,
            area: '',
            bookingUrl: r.bookingUrl,
          }));
          updateCity(idx, {
            hotels,
            hotel: hotels[0],
            selectedHotelIndex: 0,
          });
        })
        .catch(() => {});
    });
  }, [currentTrip, updateCity]);

  if (loading) {
    return (
      <main className="h-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[#2563eb] border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-500 text-sm">Loading your trip...</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="h-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
        <div className="text-center">
          <p className="text-red-500 text-sm mb-2">{error}</p>
          <button onClick={() => router.push('/plan')} className="text-[#2563eb] text-sm underline">
            Back to planning
          </button>
        </div>
      </main>
    );
  }

  if (!currentTrip) return null;

  const handleCityClick = (cityIndex: number) => {
    setOpenCityIndex(cityIndex);
    setOpenActivitiesIndex(null);
  };

  const handleActivitiesClick = (cityIndex: number) => {
    setOpenActivitiesIndex(cityIndex);
    setOpenCityIndex(null);
  };

  return (
    <main className="h-screen overflow-hidden dot-grid-bg text-gray-900 flex flex-col">
      <Navbar />

      {/* Page body fills the viewport below the navbar. Nothing here scrolls
          except the Flowchart window and the AI chat panel. */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-6 px-6 pb-6 pt-[3.75rem] max-w-[1600px] w-full mx-auto">
        {/* Main column — header pinned, cards window scrolls inside */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <ResultsHeader trip={currentTrip} />
            </div>
            <div className="flex-shrink-0 pt-5 pr-8">
              <button
                onClick={handleSaveTrip}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-all disabled:opacity-50"
                style={{ background: '#2563eb' }}
              >
                <Bookmark size={14} />
                {saving ? 'Saving...' : 'Save trip'}
              </button>
            </div>
          </div>
          <ViewTabs value={view} onChange={setView} />

          {/* Scrollable cards window */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {openCityIndex !== null ? (
              <CityDetailPanel
                trip={currentTrip}
                cityIndex={openCityIndex}
                onClose={() => setOpenCityIndex(null)}
                onPrev={() =>
                  setOpenCityIndex((i) => (i !== null && i > 0 ? i - 1 : i))
                }
                onNext={() =>
                  setOpenCityIndex((i) =>
                    i !== null && i < currentTrip.cities.length - 1 ? i + 1 : i
                  )
                }
              />
            ) : openActivitiesIndex !== null ? (
              <ActivitiesDetailPanel
                trip={currentTrip}
                cityIndex={openActivitiesIndex}
                onClose={() => setOpenActivitiesIndex(null)}
                onPrev={() =>
                  setOpenActivitiesIndex((i) => (i !== null && i > 0 ? i - 1 : i))
                }
                onNext={() =>
                  setOpenActivitiesIndex((i) =>
                    i !== null && i < currentTrip.cities.length - 1 ? i + 1 : i
                  )
                }
              />
            ) : view === 'flowchart' ? (
              <Flowchart trip={currentTrip} onCityClick={handleCityClick} onActivitiesClick={handleActivitiesClick} />
            ) : (
              <div className="h-full overflow-y-auto">
                <CalendarView trip={currentTrip} onCityClick={handleCityClick} />
              </div>
            )}
          </div>
        </div>

        {/* AI chat sidebar */}
        <aside className="lg:w-[380px] lg:flex-shrink-0 min-h-0 flex lg:mt-3">
          <AIChatPanel trip={currentTrip} />
        </aside>
      </div>

      {/* Save toast */}
      {saveToast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg"
          style={{
            background: saveToast.type === 'success' ? '#f0fdf4' : '#fef2f2',
            color: saveToast.type === 'success' ? '#16a34a' : '#dc2626',
          }}
        >
          {saveToast.message}
        </div>
      )}

      {/* Login modal for save flow */}
      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={doSaveTrip}
      />
    </main>
  );
}
