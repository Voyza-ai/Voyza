'use client';

import { useTripStore, restoreTripSession } from '@/store/tripStore';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef, Suspense } from 'react';
import Navbar from '@/components/shared/Navbar';
import ResultsHeader from '@/components/results/ResultsHeader';
import OriginClarification, { type OriginChoice } from '@/components/results/OriginClarification';
import Flowchart from '@/components/results/Flowchart';
import CalendarView from '@/components/results/CalendarView';
import ScheduleView from '@/components/results/ScheduleView';
import ViewTabs, { ResultsView } from '@/components/results/ViewTabs';
import dynamic from 'next/dynamic';

// Leaflet touches `window` at import time — load the map client-side only.
const MapView = dynamic(() => import('@/components/results/MapView'), { ssr: false });
import AIChatPanel from '@/components/results/AIChatPanel';
import { countryForCity } from '@/data/worldCities';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import ActivitiesDetailPanel from '@/components/results/ActivitiesDetailPanel';
import BudgetOverBanner from '@/components/results/BudgetOverBanner';
import VibeTierUpBanner from '@/components/results/VibeTierUpBanner';
import { searchHotels, fetchHomeLegs, updateTrip } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';
import { hotelFromResult, rerankSavedCityHotels } from '@/lib/hotelShape';
import { originAirportsForCity } from '@/lib/locationResolver';
import { Hotel, City, Transport, Trip } from '@/lib/types';
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
    // A reload of a trip that was never saved: this tab's own copy is the
    // only one there is (see restoreTripSession). Restored before the auth
    // wait because it needs no auth, and it lands before the backfills below
    // see a trip, so their data guards (hotels already listed, home legs
    // already found) hold and the reload buys nothing a second time.
    if (!tripId && !useTripStore.getState().currentTrip && restoreTripSession()) return;

    // Wait for auth to be ready before fetching protected routes
    if (isAuthLoading) return;

    // If a tripId is provided AND the store already has that exact trip
    // (freshly planned, or previously loaded), skip the refetch. Before
    // this guard we unconditionally re-hydrated from the DB, which wiped
    // the rich in-memory flight data whenever a trip was planned but
    // not yet persisted — the "flights gone after visiting canvas" bug.
    if (tripId && currentTrip?.id === tripId) {
      return;
    }

    // If a tripId is provided and we don't have it in the store, fetch
    // fresh data from the backend (once). The backend now returns a
    // complete Trip shape (hotels[], alternatives, all new columns) so
    // we can setTrip() the payload directly with minimal reshaping.
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
          // Backend now returns `data.trip` as the fully-assembled Trip —
          // hotels[], transports merged into each city's transportIn/Out,
          // budget/vibe/dateShiftSuggestion at the top level. No client-side
          // reshaping needed. We still fall back to the old reshape path
          // if the backend is an older deploy without buildTripFromDb.
          const fullTrip = data.trip;
          if (fullTrip && Array.isArray(fullTrip.cities) && fullTrip.cities[0]?.transportIn) {
            // AI-planned trips saved before the country fix have none — fill
            // from the world-cities dataset so their cards match presets.
            fullTrip.cities = fullTrip.cities.map((c: any) =>
              // Re-rank on load. Saved trips were never re-ranked or
              // re-flagged, so one saved before the price guards existed keeps
              // raw provider order and its hotels[0] can still be the glitch
              // row that produced the $17,039 total. The traveller's own pick
              // is preserved by name — see rerankSavedCityHotels.
              rerankSavedCityHotels({
                ...c,
                country: c.country || countryForCity(c.name),
              }),
            );
            setTrip(fullTrip);
            setLoading(false);
            return;
          }

          // Legacy fallback: reshape flat DB rows (pre-migration backends).
          const tripData = fullTrip ?? data;
          const dbCities = data.cities ?? [];
          const dbTransports = data.transports ?? [];
          const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };
          const cities: City[] = dbCities.map((c: any, idx: number) => {
            const hotelsArr = Array.isArray(c.hotels) && c.hotels.length > 0
              ? c.hotels
              : c.hotel ? [c.hotel] : [];
            const selectedIdx = typeof c.selected_hotel_index === 'number'
              ? Math.max(0, Math.min(c.selected_hotel_index, Math.max(0, hotelsArr.length - 1)))
              : 0;
            const hotel = hotelsArr[selectedIdx] ?? c.hotel ?? { name: '', rating: 0, pricePerNight: 0, area: '' };
            // Generate placeholder activities for cities that have none
            const activities = (c.activities && c.activities.length > 0)
              ? c.activities
              : [
                  `Explore ${c.name} old town`,
                  `Local food tour in ${c.name}`,
                  `${c.name} main museum`,
                  `Walking tour of ${c.name}`,
                  `${c.name} scenic viewpoint`,
                ];
            const restaurants = (c.restaurants && c.restaurants.length > 0)
              ? c.restaurants
              : [
                  { name: `${c.name} neighborhood trattoria`, cuisine: 'Local', priceRange: '$$' },
                  { name: `${c.name} casual lunch cafe`, cuisine: 'Cafe', priceRange: '$' },
                  { name: `${c.name} fine dining`, cuisine: 'International', priceRange: '$$$' },
                  { name: `${c.name} street food market`, cuisine: 'Street Food', priceRange: '$' },
                  { name: `${c.name} rooftop bar & grill`, cuisine: 'Bar & Grill', priceRange: '$$' },
                ];
            return {
              name: c.name,
              // Older AI-planned trips were saved without a country — fill
              // it from the world-cities dataset so their cards match presets.
              country: c.country || countryForCity(c.name),
              dates: { arrival: c.arrival_date ?? '', departure: c.departure_date ?? '' },
              hotel,
              hotels: hotelsArr,
              selectedHotelIndex: selectedIdx,
              customHotel: c.custom_hotel ?? undefined,
              activities,
              restaurants,
              vibes: c.vibes ?? [],
              colorIndex: c.color_index ?? idx,
              schedule: c.schedule ?? {},
              transportIn: emptyTransport,
              transportOut: emptyTransport,
            };
          });
          for (const t of dbTransports) {
            const fromIdx = dbCities.findIndex((c: any) => c.id === t.from_city_id);
            const toIdx = dbCities.findIndex((c: any) => c.id === t.to_city_id);
            const mins = t.duration_minutes ?? t.journey_time_minutes ?? 0;
            const transport: Transport = {
              mode: (t.mode ?? 'flight') as 'flight' | 'train',
              operator: t.operator ?? '',
              duration: mins ? `${Math.floor(mins / 60)}h ${mins % 60}m` : '',
              price: t.price ?? 0,
              from: fromIdx >= 0 ? cities[fromIdx].name : '',
              to: toIdx >= 0 ? cities[toIdx].name : '',
              departTime: t.depart_time ?? '',
              arriveTime: t.arrive_time ?? '',
              alternatives: Array.isArray(t.alternatives) ? t.alternatives : undefined,
              bookingUrl: t.booking_url ?? '',
            };
            if (fromIdx >= 0) cities[fromIdx].transportOut = transport;
            if (toIdx >= 0) cities[toIdx].transportIn = transport;
          }
          setTrip({
            id: tripData.id,
            title: tripData.title,
            status: tripData.status ?? 'planning',
            totalCost: Number(tripData.total_cost ?? tripData.totalCost ?? 0),
            savings: Number(tripData.savings_vs_alternative ?? tripData.savings ?? 0),
            travelers: tripData.travelers ?? 1,
            budget: tripData.budget != null ? Number(tripData.budget) : undefined,
            cities,
            savingsTips: [],
            dateShiftSuggestion: tripData.date_shift_suggestion ?? tripData.dateShiftSuggestion ?? undefined,
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
  }, [tripId, isAuthLoading, currentTrip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateCity = useTripStore((s) => s.updateCity);

  // ─── Re-pricing ───────────────────────────────────────────────────────
  //
  // Anything that changes what the trip costs AFTER it is on screen — the
  // other reading of an ambiguous origin, an outbound swap that moves the
  // landing day, a date change accepted from the AI chat, a saved preset's
  // first hotel search — runs as tracked jobs, and while any job is in
  // flight the header prices the trip as it last stood (`frozenTrip`).
  //
  // Audit D-09: choosing the other Portland cleared both home legs and the
  // header priced the half-cleared trip — $1,991 fell to $1,063 with "You can
  // save $320" for the ~4 s the search took. Pricing the last settled trip
  // means the header moves once, from one real total to the next, and never
  // reads a missing price as money saved.
  //
  // When the last job lands, the stored total follows the live one. Its
  // baseline moves with it: the header's saving is
  // totalCost + savings − live total, so a re-price that left the old
  // baseline behind turned "the Maine fares are cheaper" into "You can save
  // $1,950 vs default routing".
  const [frozenTrip, setFrozenTrip] = useState<Trip | null>(null);
  const frozenRef = useRef<Trip | null>(null);
  const pendingRef = useRef(0);

  /** Hold the header on `trip` until the re-price settles. The first hold wins. */
  const freeze = (trip: Trip | null | undefined) => {
    if (!trip || frozenRef.current) return;
    frozenRef.current = trip;
    setFrozenTrip(trip);
  };

  const settle = () => {
    if (!frozenRef.current) return;
    frozenRef.current = null;
    setFrozenTrip(null);
    const cur = useTripStore.getState().currentTrip;
    if (!cur) return;
    const live = liveTripTotal(cur);
    if (!Number.isFinite(live) || live === cur.totalCost) return;
    setTrip({ ...cur, totalCost: live });
  };

  /** Count a re-price job in flight; the last one to finish settles the header. */
  const track = <T,>(job: Promise<T>): Promise<T | void> => {
    pendingRef.current += 1;
    return job
      .catch(() => {})
      .finally(() => {
        pendingRef.current -= 1;
        if (pendingRef.current === 0) settle();
      });
  };

  /**
   * Search one visit's hotels and put them on the trip — the path every
   * hotel search on this page takes (first load, a preset's first search, a
   * re-search after the visit's dates moved). Priced for the party: the
   * backend books ceil(travelers / 2) rooms for `adults`.
   */
  const searchVisitHotels = (
    visit: { name: string; arrival: string; departure: string },
    travelers: number,
  ) =>
    track(
      searchHotels({
        city: visit.name,
        checkin: visit.arrival,
        checkout: visit.departure,
        adults: travelers,
      }).then((results) => {
        if (results.length === 0) return;
        const hotels: Hotel[] = results.map(hotelFromResult);
        // Identify the visit, not its position: the search resolves seconds
        // later, and by then a drag-reorder or another date change may have
        // moved this city. A result for dates the visit no longer has is
        // stale and dropped (a newer search is already on its way).
        const cities = useTripStore.getState().currentTrip?.cities ?? [];
        const idx = cities.findIndex(
          (c) =>
            c.name === visit.name &&
            c.dates.arrival === visit.arrival &&
            c.dates.departure === visit.departure,
        );
        if (idx < 0) return;
        updateCity(idx, { hotels, hotel: hotels[0], selectedHotelIndex: 0 });
      }),
    );

  // Enrich cities with real hotel data if hotels[] is empty
  const hotelsFetchedRef = useRef(false);

  useEffect(() => {
    if (!currentTrip || hotelsFetchedRef.current) return;
    hotelsFetchedRef.current = true;

    // Skip cities that already have hotels populated (e.g. from the planner).
    const needed = currentTrip.cities.filter((city) => city.hotels.length <= 1);
    if (needed.length === 0) return;
    freeze(currentTrip);
    for (const city of needed) {
      searchVisitHotels(
        { name: city.name, arrival: city.dates.arrival, departure: city.dates.departure },
        currentTrip.travelers,
      );
    }
  }, [currentTrip, updateCity]); // eslint-disable-line react-hooks/exhaustive-deps

  // Backfill missing home-leg flights so the flowchart ALWAYS shows the
  // home↔trip flights when a home anchor exists. Covers trips saved before
  // flights were searched, saves where the search failed, and canvas edits
  // that never re-searched. Persists the found legs (owner PATCH) so the
  // backfill only ever runs once per trip.
  const homeLegsFetchedRef = useRef<string | null>(null);
  const [homeLegSearch, setHomeLegSearch] = useState({ outbound: false, return: false });

  /** Search the home legs a trip is missing and merge what comes back. */
  const searchHomeLegs = (
    trip: Trip,
    need: { outbound: boolean; return: boolean },
    startDate: string,
  ) => {
    const origin = trip.origin;
    const first = trip.cities[0];
    const last = trip.cities[trip.cities.length - 1];
    if (!origin || !first || !last) return;

    // Airports may be empty on older trips — fall back to the known-airports
    // lookup for the home city. Synchronous and offline on purpose: this runs
    // inside an effect that must not become a loading state, and a trip saved
    // before the resolver existed has to degrade to today's behaviour, which
    // is a best-effort list or none at all (the `.length > 0` guards below).
    //
    // TODO(location-phase-4): no question is possible here — nobody is looking
    // at a prompt during a backfill. If the owner wants one it belongs on the
    // home card, from the persisted `origin_place_id`, not in this effect.
    const outAirports = origin.airports?.length ? origin.airports : originAirportsForCity(origin.city);
    const retAirports = origin.returnAirports?.length ? origin.returnAirports : outAirports;

    const jobs: Promise<unknown>[] = [];
    setHomeLegSearch({ outbound: need.outbound, return: need.return });

    if (need.outbound && outAirports.length > 0) {
      jobs.push(
        track(
          fetchHomeLegs({
            originAirports: outAirports,
            originCity: origin.city,
            firstCity: first.name,
            lastCity: last.name,
            startDate,
            endDate: last.dates?.departure,
            travelers: trip.travelers ?? 1,
            outbound: true,
            returnToHome: false,
          })
            .then((r) => {
              const cur = useTripStore.getState().currentTrip;
              if (!cur?.origin) return;
              setTrip({ ...cur, origin: { ...cur.origin, outboundLeg: r.outboundLeg ?? null } });
            })
            .finally(() => setHomeLegSearch((s) => ({ ...s, outbound: false }))),
        ),
      );
    } else {
      setHomeLegSearch((s) => ({ ...s, outbound: false }));
    }

    if (need.return && retAirports.length > 0) {
      jobs.push(
        track(
          fetchHomeLegs({
            originAirports: retAirports,
            originCity: origin.returnCity ?? origin.city,
            firstCity: first.name,
            lastCity: last.name,
            startDate,
            endDate: last.dates?.departure,
            travelers: trip.travelers ?? 1,
            outbound: false,
            returnToHome: true,
          })
            .then((r) => {
              const cur = useTripStore.getState().currentTrip;
              if (!cur?.origin) return;
              setTrip({ ...cur, origin: { ...cur.origin, returnLeg: r.returnLeg ?? null } });
            })
            .finally(() => setHomeLegSearch((s) => ({ ...s, return: false }))),
        ),
      );
    } else {
      setHomeLegSearch((s) => ({ ...s, return: false }));
    }

    // Persist whatever was found so the next load doesn't re-search.
    if (jobs.length > 0) {
      Promise.allSettled(jobs).then(() => {
        const cur = useTripStore.getState().currentTrip;
        if (!cur?.id || cur.id.startsWith('mock') || !cur.origin) return;
        if (!cur.origin.outboundLeg && !cur.origin.returnLeg) return;
        updateTrip(cur.id, {
          outboundLeg: cur.origin.outboundLeg ?? null,
          returnLeg: cur.origin.returnLeg ?? null,
        }).catch(() => {});
      });
    }
  };

  /**
   * The traveller picked a different reading of an ambiguous origin.
   *
   * Clears the home legs and the once-per-trip guard so the backfill effect
   * below re-runs and re-prices them from the chosen airports. That is the
   * part the origin actually determines, and the part that was wrong.
   *
   * It does NOT re-run the optimizer, so the CITY ORDER still reflects the
   * reading we guessed. The order is chosen by testing permutations against
   * the home legs, so in principle a different origin could reorder the
   * trip. Left alone deliberately: re-optimising from here needs the
   * planner's own inputs, and the alternative — leaving the flights priced
   * from a city the traveller did not mean — is worse than an order that is
   * merely not re-optimised.
   */
  const chooseOrigin = (choice: OriginChoice) => {
    const trip = useTripStore.getState().currentTrip;
    if (!trip?.origin) return;
    // The label is "Portland, Maine, United States"; the home card wants
    // "Portland". Labels are built name-first, so the leading segment is it.
    const shortName = choice.label.split(',')[0]?.trim() || trip.origin.city;
    homeLegsFetchedRef.current = null;
    freeze(trip);
    setTrip({
      ...trip,
      origin: {
        ...trip.origin,
        city: shortName,
        airports: choice.airports,
        returnAirports: choice.airports,
        outboundLeg: null,
        returnLeg: null,
      },
      // The choice has been made; stop asking.
      originClarification: undefined,
    });
  };

  useEffect(() => {
    const trip = currentTrip;
    if (!trip?.origin?.city || trip.cities.length === 0) return;
    const key = trip.id ?? 'store-trip';
    if (homeLegsFetchedRef.current === key) return;

    const needOutbound = !trip.origin.outboundLeg;
    const needReturn = (trip.returnToHome ?? true) && !trip.origin.returnLeg;
    if (!needOutbound && !needReturn) return;
    homeLegsFetchedRef.current = key;

    const startDate = trip.cities[0].dates?.arrival;
    if (!startDate) return;

    freeze(trip);
    searchHomeLegs(trip, { outbound: needOutbound, return: needReturn }, startDate);
    // The AIRPORTS belong in here, not just the city name. This effect prices
    // legs from `origin.airports`, and the ambiguous-origin case changes the
    // airports while leaving the city string identical — Portland, Oregon and
    // Portland, Maine are both "Portland". Keyed on the name alone, picking
    // the other reading silently kept the Oregon fares. Airports only change
    // on load and on that choice, so this adds no extra searches.
  }, [
    currentTrip?.id,
    currentTrip?.origin?.city,
    currentTrip?.origin?.airports?.join(','),
  ]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // What the header prices: the trip as it last stood while a re-price is in
  // flight (see frozenTrip), else the trip itself.
  const pricedTrip = frozenTrip ?? currentTrip;

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
      {/* View tabs live in the navbar (next to the auth corner) so the cards
          below get the full viewport height. The date-shift savings tip now
          arrives as a BlueMurr AI chat message instead of a page banner. */}
      <Navbar tabs={<ViewTabs value={view} onChange={setView} />} />

      {/* Page body fills the viewport below the navbar. Nothing here scrolls
          except the cards area (left↔right) and the AI chat panel. */}
      {/* Near-zero side gutters: no max-width cap, minimal padding — the
          cards start at the left edge and the chat ends at the right edge. */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-3 px-2 pb-2 pt-[3rem] w-full">
        {/* Main column — header pinned, cards fill the rest */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <ResultsHeader trip={currentTrip} pricedTrip={frozenTrip ?? undefined} />
          {typeof currentTrip.budget === 'number' && (
            // The total the header shows, not the stored totalCost: that is
            // set once (at creation, or a preset's quote on save) and does
            // not follow a hotel or transport swap.
            <BudgetOverBanner budget={currentTrip.budget} totalCost={liveTripTotal(pricedTrip)} />
          )}
          {currentTrip.vibeTierUp && (
            <VibeTierUpBanner tierUp={currentTrip.vibeTierUp} />
          )}
          {currentTrip.originClarification && currentTrip.origin && (
            <OriginClarification
              clarification={currentTrip.originClarification}
              pricedFrom={currentTrip.origin.airports ?? []}
              onChoose={chooseOrigin}
            />
          )}

          {/* Full-height cards area */}
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
              <Flowchart
                trip={currentTrip}
                onCityClick={handleCityClick}
                onActivitiesClick={handleActivitiesClick}
                homeLegSearch={homeLegSearch}
              />
            ) : view === 'schedule' ? (
              <div className="h-full min-h-0">
                <ScheduleView trip={currentTrip} />
              </div>
            ) : view === 'map' ? (
              <MapView trip={currentTrip} />
            ) : (
              <div className="h-full overflow-y-auto">
                <CalendarView trip={currentTrip} onCityClick={handleCityClick} />
              </div>
            )}
          </div>
        </div>

        {/* AI chat sidebar. Docks to the right from `md` up (not `lg`) so it
            matches the canvas on ordinary laptop windows — at the old
            breakpoint anything under 1024px dropped the chat below the
            content, which read as a different layout from the rest of the app. */}
        {/* Stacked on mobile, the chat has no width to be bounded by, so it
            grew to its natural height and left the content above it a sliver —
            the Map tab came out 77px tall, most of that covered by the tile
            attribution. Cap it below `md` so the content above always keeps
            the larger share; from `md` up it docks to the right and the cap
            is irrelevant. */}
        <aside className="max-h-[45vh] md:max-h-none md:w-[340px] lg:w-[380px] md:flex-shrink-0 min-h-0 flex md:mt-3">
          <AIChatPanel trip={currentTrip} />
        </aside>
      </div>
    </main>
  );
}
