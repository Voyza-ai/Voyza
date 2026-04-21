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
import { searchHotels, getTrip } from '@/lib/api';
import { Hotel, City, Transport } from '@/lib/types';
import { useAuthStore } from '@/store/authStore';

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

  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const fetchedRef = useRef(false);

  useEffect(() => {
    // Wait for auth to be ready before fetching protected routes
    if (isAuthLoading) return;

    // If a tripId is provided, fetch fresh data from the backend (once)
    if (tripId) {
      if (fetchedRef.current) return;
      fetchedRef.current = true;
      setLoading(true);

      const fetchTrip = async () => {
        const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
        const { getAuthHeader } = await import('@/lib/supabase');
        const headers = await getAuthHeader();
        const res = await fetch(`${BASE_URL}/api/trips/${tripId}`, {
          headers: { 'Content-Type': 'application/json', ...headers },
        });
        if (!res.ok) throw new Error(`Failed to load trip (${res.status})`);
        return res.json();
      };

      fetchTrip()
        .then((data) => {
          const tripData = data.trip ?? data;
          const dbCities = data.cities ?? [];
          const dbTransports = data.transports ?? [];

          // Transform DB city rows into frontend City shape
          const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };
          const cities: City[] = dbCities.map((c: any, idx: number) => {
            const hotel = c.hotel ?? { name: '', rating: 0, pricePerNight: 0, area: '' };
            return {
              name: c.name,
              country: c.country ?? '',
              dates: { arrival: c.arrival_date ?? '', departure: c.departure_date ?? '' },
              hotel,
              hotels: [hotel],
              selectedHotelIndex: 0,
              activities: c.activities ?? [],
              restaurants: c.restaurants ?? [],
              vibes: [],
              colorIndex: c.color_index ?? idx,
              schedule: c.schedule ?? {},
              transportIn: emptyTransport,
              transportOut: emptyTransport,
            };
          });

          // Attach transport data
          for (const t of dbTransports) {
            const fromIdx = dbCities.findIndex((c: any) => c.id === t.from_city_id);
            const toIdx = dbCities.findIndex((c: any) => c.id === t.to_city_id);
            const transport: Transport = {
              mode: (t.mode ?? 'flight') as 'flight' | 'train',
              operator: t.operator ?? '',
              duration: t.duration_minutes ? `${Math.floor(t.duration_minutes / 60)}h ${t.duration_minutes % 60}m` : '',
              price: t.price ?? 0,
              from: fromIdx >= 0 ? cities[fromIdx].name : '',
              to: toIdx >= 0 ? cities[toIdx].name : '',
              departTime: t.depart_time ?? '',
              arriveTime: t.arrive_time ?? '',
              bookingUrl: t.booking_url ?? '',
            };
            if (fromIdx >= 0) cities[fromIdx].transportOut = transport;
            if (toIdx >= 0) cities[toIdx].transportIn = transport;
          }

          setTrip({
            id: tripData.id,
            title: tripData.title,
            status: tripData.status ?? 'planning',
            totalCost: tripData.total_cost ?? 0,
            savings: tripData.savings_vs_alternative ?? 0,
            travelers: tripData.travelers ?? 1,
            cities,
            savingsTips: [],
          });
          setLoading(false);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
      return;
    }

    // No tripId — use the trip from the store (e.g. from PlanningChat)
    if (currentTrip) return;

    // No trip anywhere — redirect to planning
    router.push('/plan');
  }, [tripId, isAuthLoading]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 px-6 pb-4 pt-[3rem] max-w-[1600px] w-full mx-auto">
        {/* Main column — header pinned, cards window scrolls inside */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <ResultsHeader trip={currentTrip} />
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
    </main>
  );
}
