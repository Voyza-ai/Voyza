'use client';

import { useTripStore, restoreTripSession } from '@/store/tripStore';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, UserX, WifiOff } from 'lucide-react';
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
import NoRailDataNotice from '@/components/results/NoRailDataNotice';
import VibeTierUpBanner from '@/components/results/VibeTierUpBanner';
import { searchHotels, fetchHomeLegs, updateTrip, compareLeg, type LegComparison } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';
import { hotelFromResult, rerankSavedCityHotels } from '@/lib/hotelShape';
import { originAirportsForCity } from '@/lib/locationResolver';
import { Hotel, City, Transport, HomeLeg, Trip } from '@/lib/types';
import { tripStartDate, addDaysIso, daysFrom } from '@/lib/tripSpan';
import { formatMinutes } from '@/lib/dateHelpers';
import { useAuthStore } from '@/store/authStore';
import { useSavedTripAutosave } from '@/lib/useSavedTripAutosave';
import { requestPicksForAddedCity } from '@/store/tripStore';
import { useTripCollaboration } from '@/hooks/useTripCollaboration';
import { isApplyingRemote, remoteAppliedWithin, rechainDates, staleLegIndices } from '@/lib/tripCollab';
import { nextColorIndex } from '@/lib/cityColors';
import ShareModal from '@/components/canvas/ShareModal';
import AddCityModal from '@/components/canvas/AddCityModal';
import HomeEditModal from '@/components/canvas/HomeEditModal';
import SuggestedCitiesPanel from '@/components/canvas/SuggestedCitiesPanel';
import SuggestionsPanel from '@/components/canvas/SuggestionsPanel';
import LoginModal from '@/components/shared/LoginModal';
import { useNotificationsStore } from '@/store/notificationsStore';

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

/** Longest stay the nights stepper allows (the backend's MAX_STAY_NIGHTS). */
const MAX_CITY_NIGHTS = 60;

function ResultsPageInner() {
  const { currentTrip, setTrip } = useTripStore();
  // A saved trip's changes made here (legs, schedule, AI city edits) are
  // written back to the database.
  useSavedTripAutosave();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tripId = searchParams.get('tripId');
  const [view, setView] = useState<ResultsView>('flowchart');
  const [openCityIndex, setOpenCityIndex] = useState<number | null>(null);
  const [openActivitiesIndex, setOpenActivitiesIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const user = useAuthStore((s) => s.user);
  const fetchedRef = useRef(false);

  // The trip as a shared, live document (what the canvas page used to be):
  // roles, share-link joins, presence, live edits, suggestions.
  const collab = useTripCollaboration(tripId, searchParams.get('share'));

  // BlueMurr AI shown or hidden by the person; remembered on this browser
  // (read after mount, so the server's first render matches).
  const [chatOpen, setChatOpenState] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem('bluemurr.chatHidden') === '1') setChatOpenState(false);
    } catch {}
  }, []);
  const setChatOpen = (open: boolean) => {
    setChatOpenState(open);
    try {
      window.localStorage.setItem('bluemurr.chatHidden', open ? '0' : '1');
    } catch {}
  };

  // ── Shut out, then invited (again) ──
  // The removed / no-access screen watches the notifications for an invite to
  // THIS trip that arrived after the screen came up, and offers to open it.
  // Opening is a full load: the page's trip, role and live channel were all
  // set up for the old membership.
  const gateAtRef = useRef<number | null>(null);
  if (collab.accessGate && gateAtRef.current == null) gateAtRef.current = Date.now();
  if (!collab.accessGate) gateAtRef.current = null;
  const notifItems = useNotificationsStore((st) => st.items);
  const reinvite = (() => {
    if (!collab.accessGate || !tripId) return null;
    const since = (gateAtRef.current ?? Date.now()) - 5000;
    const n = notifItems.find(
      (i) =>
        i.type === 'canvas_invite' &&
        i.data?.tripId === tripId &&
        typeof i.data?.link === 'string' &&
        (collab.accessGate === 'no_access' || new Date(i.created_at).getTime() >= since),
    );
    return n ? { link: n.data!.link as string, role: String(n.data?.role || 'viewer') } : null;
  })();
  const openReinvite = (r: { link: string }) => window.location.assign(r.link);
  // The bell's own invite row navigates within the page (?share= changes);
  // reload so the new invite is claimed from a clean start.
  // Only a NEW token: the one this page loaded with was already tried.
  const shareInUrl = searchParams.get('share');
  const loadedShare = useRef(shareInUrl);
  useEffect(() => {
    if (collab.accessGate && shareInUrl && shareInUrl !== loadedShare.current) window.location.reload();
  }, [collab.accessGate, shareInUrl]);
  /**
   * Only the owner writes the trip row (PATCH is owner-only): a shared
   * trip's other members got a 403 for every total or home-flight backfill.
   * Their changes reach the database through the owner's page instead.
   */
  const writesTripRef = useRef(true);
  writesTripRef.current = !collab.active || collab.role === 'owner';
  const [shareOpen, setShareOpen] = useState(false);
  const [membersKey, setMembersKey] = useState(0);
  const [addingAfter, setAddingAfter] = useState<number | null>(null);
  const [homeEdit, setHomeEdit] = useState<'outbound' | 'inbound' | null>(null);
  const [refreshingLegs, setRefreshingLegs] = useState<string[]>([]);

  useEffect(() => {
    // A reload of a trip that was never saved: this tab's own copy is the
    // only one there is (see restoreTripSession). Restored before the auth
    // wait because it needs no auth, and it lands before the backfills below
    // see a trip, so their data guards (hotels already listed, home legs
    // already found) hold and the reload buys nothing a second time.
    if (!tripId && !useTripStore.getState().currentTrip && restoreTripSession()) return;

    // Wait for auth to be ready before fetching protected routes
    if (isAuthLoading) return;
    // A saved trip needs an account (the sign-in modal shows below), and a
    // share link is claimed before the trip loads so the load sees the new
    // membership.
    if (tripId && (!user || collab.joinPending)) return;

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
              duration: mins ? formatMinutes(mins) : '',
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
  }, [tripId, isAuthLoading, currentTrip?.id, user?.id, collab.joinPending]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // When the last job lands, the stored total follows the live one (and is
  // persisted for a saved trip, so My Trips shows what opening the trip
  // shows). Its baseline moves with it: the header's saving is
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
    if (cur.id && !cur.id.startsWith('mock') && writesTripRef.current) {
      updateTrip(cur.id, { totalCost: live }).catch(() => {});
    }
  };

  /**
   * A hold with no job behind it — the re-price found nothing it could
   * search (a home city with no known airport) — would hold the header
   * forever, and every later edit with it. Nothing was re-priced, so the
   * hold is simply dropped.
   */
  const releaseIfIdle = () => {
    if (pendingRef.current !== 0 || !frozenRef.current) return;
    frozenRef.current = null;
    setFrozenTrip(null);
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
        // A re-search keeps the traveller's pick when the new list still has it.
        const city = cities[idx];
        const picked = city.hotels.length > 1 ? city.hotels[city.selectedHotelIndex]?.name : undefined;
        const keep = picked ? hotels.findIndex((h) => h.name === picked) : -1;
        const sel = keep >= 0 ? keep : 0;
        updateCity(idx, { hotels, hotel: hotels[sel], selectedHotelIndex: sel });
      }),
    );

  /** Re-price the inter-city leg that leaves `from` on `date` for `to`. */
  const repriceLeg = (from: string, to: string, date: string, travelers: number) => {
    const key = `${from}→${to}`;
    setRefreshingLegs((prev) => (prev.includes(key) ? prev : [...prev, key]));
    return track(
      compareLeg({ origin: from, destination: to, date, travelers }).then((result) => {
        const cur = useTripStore.getState().currentTrip;
        if (!cur) return;
        const idx = cur.cities.findIndex(
          (c, i) => c.name === from && cur.cities[i + 1]?.name === to && c.dates.departure === date,
        );
        if (idx < 0) return; // the leg moved again; its own re-price is coming
        const transport = comparisonToTransport(result, from, to, date);
        const { alternatives: _alts, ...flat } = transport;
        const cities = [...cur.cities];
        cities[idx] = { ...cities[idx], transportOut: transport };
        cities[idx + 1] = { ...cities[idx + 1], transportIn: flat };
        setTrip({ ...cur, cities });
      }),
    ).finally(() => setRefreshingLegs((prev) => prev.filter((k) => k !== key)));
  };

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
  /**
   * The day the next outbound search must leave on, when the trip on screen
   * no longer says it. Clearing an overnight outbound (to re-search it) loses
   * the trip's start: without the leg, `tripStartDate` falls back to the first
   * stay's arrival, which is the LANDING day — and the search went out a day
   * late (Jan 11 for a trip leaving Jan 10).
   */
  const outboundStartRef = useRef<string | null>(null);

  /**
   * Search the home legs a trip is missing and merge what comes back.
   *
   * The outbound is searched on the trip's start and sends the first stay's
   * departure, so the answer carries `firstCityArrival` — the backend's
   * landing rule — and the first stay is re-dated to the day the chosen
   * flight lands (a same-day flight gives the night back; an overnight one
   * takes it). A search that answered with no flight dates the stay from the
   * start, as the optimizer does without one. The dates change through the
   * store, so the re-pricing subscription below re-searches that city's
   * hotels for them.
   */
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
      const firstCityDeparture = first.dates?.departure || undefined;
      jobs.push(
        track(
          fetchHomeLegs({
            originAirports: outAirports,
            originCity: origin.city,
            firstCity: first.name,
            lastCity: last.name,
            startDate,
            endDate: last.dates?.departure,
            firstCityDeparture,
            travelers: trip.travelers ?? 1,
            outbound: true,
            returnToHome: false,
          })
            .then((r) => {
              const cur = useTripStore.getState().currentTrip;
              if (!cur?.origin) return;
              // The trip moved on (its first stop changed while this was out
              // — e.g. a suggester's edit was sent and the view reset): this
              // flight is for a stop the trip no longer starts at.
              if (cur.cities[0]?.name !== first.name) return;
              const leg = r.outboundLeg ?? null;
              const stay = cur.cities[0];
              // Re-date only the stay the search was for, at the dates it
              // was asked about.
              const arrival =
                stay && stay.name === first.name && stay.dates.departure === firstCityDeparture
                  ? leg
                    ? r.firstCityArrival
                    : startDate
                  : undefined;
              const cities =
                arrival && arrival !== stay.dates.arrival
                  ? [{ ...stay, dates: { ...stay.dates, arrival } }, ...cur.cities.slice(1)]
                  : cur.cities;
              setTrip({ ...cur, cities, origin: { ...cur.origin, outboundLeg: leg } });
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
              // Same for the flight home: measured live, a suggester's
              // proposal reset the trip to end in Venice, then this answer
              // (searched from Florence, the edit's last stop) landed on it —
              // the page read that as an unsent change and stopped following
              // the owner.
              const end = cur.cities[cur.cities.length - 1];
              if (end?.name !== last.name || end.dates?.departure !== last.dates?.departure) return;
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
        if (!writesTripRef.current) return;
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
    // The new outbound leaves the day the old one did — the trip's start —
    // whichever day it then lands.
    outboundStartRef.current = tripStartDate(trip) ?? null;
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
      // The date-shift check priced the other reading's home flights.
      dateShiftSuggestion: undefined,
      dateShiftChecked: false,
    });
  };

  useEffect(() => {
    const trip = currentTrip;
    if (!trip?.origin?.city || trip.cities.length === 0) return;
    const key = trip.id ?? 'store-trip';
    if (homeLegsFetchedRef.current === key) return;
    // A collaborator's change: their screen searches what it needs.
    if (remoteAppliedWithin(1500)) return;

    const needOutbound = !trip.origin.outboundLeg;
    const needReturn = (trip.returnToHome ?? true) && !trip.origin.returnLeg;
    if (!needOutbound && !needReturn) return;
    homeLegsFetchedRef.current = key;

    const startDate = outboundStartRef.current ?? tripStartDate(trip);
    outboundStartRef.current = null;
    if (!startDate) {
      releaseIfIdle(); // a hold from chooseOrigin with nothing to search
      return;
    }

    freeze(trip);
    searchHomeLegs(trip, { outbound: needOutbound, return: needReturn }, startDate);
    releaseIfIdle();
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

  /**
   * Dates moved on the trip on screen → re-price what was priced for the old
   * ones. One rule for every source of a date change: an accepted AI date pin
   * or shift, an outbound swap that lands on another day, a re-searched
   * outbound's landing day.
   *
   *  - a stay whose dates changed: its hotels are searched for the new dates;
   *  - an inter-city leg whose day changed: re-priced on the new day;
   *  - the outbound, when the first stay moved and the flight did NOT (the
   *    traveller moved the dates): re-searched from the trip's start moved by
   *    the same number of days, landing rule applied;
   *  - the return, when the last stay's departure moved: re-searched on it.
   *
   * A home leg being re-searched is cleared, which is the flowchart's existing
   * "Finding flights…" state; the header holds the last settled total until
   * every search has landed.
   */
  useEffect(
    () =>
      useTripStore.subscribe((state, prevState) => {
        const next = state.currentTrip;
        const prev = prevState.currentTrip;
        if (!next || !prev || next === prev) return;
        // A collaborator's change was re-priced on their screen already.
        if (isApplyingRemote()) return;
        const work = datedWork(prev, next);
        if (!work) return;
        freeze(prev);
        // Run after this store update has finished notifying (the jobs write
        // to the store themselves).
        queueMicrotask(() => {
          let cur = useTripStore.getState().currentTrip;
          if (!cur) return;
          // The date-shift check priced the OLD dates: its suggestion ("start
          // a day earlier and save $X") and its "Best price" no longer apply.
          if (cur.dateShiftSuggestion || cur.dateShiftChecked) {
            cur = { ...cur, dateShiftSuggestion: undefined, dateShiftChecked: false };
            setTrip(cur);
          }
          for (const i of work.legs) {
            const from = cur.cities[i];
            const to = cur.cities[i + 1];
            if (from && to) repriceLeg(from.name, to.name, from.dates.departure, cur.travelers);
          }
          for (const i of work.hotels) {
            const c = cur.cities[i];
            if (c) searchVisitHotels({ name: c.name, arrival: c.dates.arrival, departure: c.dates.departure }, cur.travelers);
          }
          if ((work.outboundFrom || work.ret) && cur.origin) {
            const cleared = {
              ...cur,
              origin: {
                ...cur.origin,
                ...(work.outboundFrom ? { outboundLeg: null } : {}),
                ...(work.ret ? { returnLeg: null } : {}),
              },
            };
            setTrip(cleared);
            searchHomeLegs(
              cleared,
              { outbound: !!work.outboundFrom, return: work.ret },
              work.outboundFrom ?? tripStartDate(cur) ?? cur.cities[0].dates.arrival,
            );
          }
          releaseIfIdle();
        });
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ─── Rearranging the trip (what the canvas did) ────────────────────────
  //
  // Reorder, add and remove stays, and change the home airports. The stays'
  // dates re-chain from the trip's start (each keeps its nights); then what
  // the change left wrong is searched again, each with its own loading state:
  //   - every inter-city leg that now joins different stops or leaves on
  //     another day (its connector shows "Finding transport…");
  //   - the outbound when the first stop changed, the return when the last
  //     stop or its last night changed ("Finding flights…");
  //   - a new stop's hotels and AI picks.
  // A stay that only moved keeps its hotel (same nights, as the canvas did).
  const EMPTY_LEG: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

  const restructure = (raw: City[], added?: string) => {
    const prev = useTripStore.getState().currentTrip;
    if (!prev || raw.length === 0) return;
    const names = new Set(raw.map((c) => c.name.toLowerCase()));
    const isTripCity = (n?: string) => !!n && names.has(n.toLowerCase());
    const chained = rechainDates(raw).map((c, i, all) => ({
      ...c,
      // The ends of the row have no inter-city leg in/out; a leg left over
      // from the city's old neighbour would draw a train that isn't taken.
      ...(i === 0 && isTripCity(c.transportIn?.from) ? { transportIn: EMPTY_LEG } : {}),
      ...(i === all.length - 1 && isTripCity(c.transportOut?.to) ? { transportOut: EMPTY_LEG } : {}),
    }));
    // An auto-titled trip ("Rome → Venice") follows its stops, as an AI city
    // edit does (lib/cityEdit); a name the owner chose stays.
    const oldRoute = prev.cities.map((c) => c.name).join(' → ');
    const next: Trip = {
      ...prev,
      cities: chained,
      title: !prev.title || prev.title === oldRoute ? chained.map((c) => c.name).join(' → ') : prev.title,
      // Priced for the old itinerary: the date-shift tip, and the saving
      // "vs your original city order" — a hand-arranged order is not the
      // optimizer's, so the green box no longer claims it.
      dateShiftSuggestion: undefined,
      dateShiftChecked: false,
      savings: 0,
    };
    // The total the saving box measures against, for the new stops. This
    // screen shows the frozen total until the searches settle; everyone else
    // receives this, and with the old stops' total kept they showed the
    // removed city's price as "You can save $X".
    next.totalCost = liveTripTotal(next);
    freeze(prev);
    homeLegsFetchedRef.current = next.id ?? 'store-trip';
    setTrip(next);

    const prevByName = new Map(prev.cities.map((c) => [c.name, c]));
    for (let i = 0; i < chained.length - 1; i++) {
      const c = chained[i];
      const to = chained[i + 1];
      const t = c.transportOut;
      const was = prevByName.get(c.name);
      const stale =
        !t ||
        t.unavailable ||
        !t.operator ||
        (t.price ?? 0) <= 0 ||
        (!!t.to && t.to.toLowerCase() !== to.name.toLowerCase()) ||
        (!!t.from && t.from.toLowerCase() !== c.name.toLowerCase()) ||
        // Leaves on another day than it was priced for.
        (!!was && was.dates.departure !== c.dates.departure);
      if (stale) repriceLeg(c.name, to.name, c.dates.departure, next.travelers);
    }

    if (next.origin?.city) {
      const first = prev.cities[0];
      const last = prev.cities[prev.cities.length - 1];
      const nFirst = chained[0];
      const nLast = chained[chained.length - 1];
      const outbound = first?.name !== nFirst.name;
      const ret =
        (next.returnToHome ?? true) &&
        (last?.name !== nLast.name || last?.dates.departure !== nLast.dates.departure);
      if (outbound || ret) {
        const cleared: Trip = {
          ...next,
          origin: {
            ...next.origin,
            ...(outbound ? { outboundLeg: null } : {}),
            ...(ret ? { returnLeg: null } : {}),
          },
        };
        setTrip(cleared);
        searchHomeLegs(
          cleared,
          { outbound, return: ret },
          tripStartDate(prev) ?? nFirst.dates.arrival,
        );
      }
    }

    if (added) {
      const c = chained.find((x) => x.name === added);
      if (c) {
        searchVisitHotels({ name: c.name, arrival: c.dates.arrival, departure: c.dates.departure }, next.travelers);
        requestPicksForAddedCity({
          city: c.name,
          country: c.country || undefined,
          vibe: useTripStore.getState().answers.vibe ?? undefined,
          travelers: next.travelers,
          nights: Math.max(1, daysFrom(c.dates.arrival, c.dates.departure)),
          budget: next.budget,
          otherCities: chained.filter((x) => x.name !== c.name).map((x) => x.name),
        });
      }
    }
    releaseIfIdle();
  };

  const reorderCities = (order: City[]) => restructure(order);

  // Two people's changes merged (lib/tripCollab applyCollabDelta): a leg
  // can now join stops neither of them had next to each other. Whoever can
  // edit prices it again; the result goes out like any other change.
  collab.onMergedRef.current = () => {
    if (collab.role !== 'owner' && collab.role !== 'editor') return;
    queueMicrotask(() => {
      const cur = useTripStore.getState().currentTrip;
      if (!cur) return;
      for (const i of staleLegIndices(cur)) {
        const from = cur.cities[i];
        const to = cur.cities[i + 1];
        repriceLeg(from.name, to.name, from.dates.departure, cur.travelers);
      }
    });
  };

  const removeCity = (index: number) => {
    const cur = useTripStore.getState().currentTrip;
    if (!cur || cur.cities.length <= 1) return;
    const removed = cur.cities[index];
    restructure(cur.cities.filter((_, i) => i !== index));
    if (removed) collab.showToast(`${removed.name} removed`, 'info');
  };

  const addCity = (afterIndex: number, data: { name: string; country?: string; nights: number }) => {
    const cur = useTripStore.getState().currentTrip;
    if (!cur) return;
    if (cur.cities.some((c) => c.name.toLowerCase() === data.name.toLowerCase())) {
      collab.showToast(`${data.name} is already on this trip`, 'info');
      return;
    }
    const nights = Math.max(1, data.nights || 2);
    const city: City = {
      name: data.name,
      country: data.country || countryForCity(data.name) || '',
      // A placeholder start that only carries the nights; rechainDates dates it.
      dates: { arrival: '2000-01-01', departure: addDaysIso('2000-01-01', nights) },
      hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
      hotels: [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      vibes: [],
      colorIndex: nextColorIndex(cur.cities),
      transportIn: EMPTY_LEG,
      transportOut: EMPTY_LEG,
    } as City;
    const list = [...cur.cities];
    list.splice(Math.max(0, afterIndex + 1), 0, city);
    restructure(list, city.name);
    collab.showToast(`${data.name} added`, 'success');
  };

  // A stay made longer or shorter from its card. Every later stay moves by
  // the difference (rechainDates keeps the trip's start); the date-change
  // subscription above then re-searches what moved: hotels for the new
  // dates, legs leaving on another day, the flight home.
  const setCityNights = (index: number, nights: number) => {
    const cur = useTripStore.getState().currentTrip;
    const c = cur?.cities[index];
    if (!cur || !c?.dates.arrival || !c.dates.departure) return;
    const n = Math.max(1, Math.min(MAX_CITY_NIGHTS, Math.round(nights)));
    if (n === daysFrom(c.dates.arrival, c.dates.departure)) return;
    const cities = cur.cities.map((x, i) =>
      i === index ? { ...x, dates: { ...x.dates, departure: addDaysIso(x.dates.arrival, n) } } : x,
    );
    setTrip({ ...cur, cities: rechainDates(cities) });
  };

  const applyHomeEdit = (direction: 'outbound' | 'inbound', updates: { city: string; airports: string[] }) => {
    setHomeEdit(null);
    const cur = useTripStore.getState().currentTrip;
    if (!cur?.origin || cur.cities.length === 0) return;
    const start = tripStartDate(cur) ?? cur.cities[0].dates.arrival;
    const origin =
      direction === 'outbound'
        ? { ...cur.origin, city: updates.city, airports: updates.airports, outboundLeg: null }
        : { ...cur.origin, returnCity: updates.city, returnAirports: updates.airports, returnLeg: null };
    const next: Trip = { ...cur, origin, dateShiftSuggestion: undefined, dateShiftChecked: false };
    freeze(cur);
    homeLegsFetchedRef.current = next.id ?? 'store-trip';
    setTrip(next);
    searchHomeLegs(next, { outbound: direction === 'outbound', return: direction === 'inbound' }, start);
    releaseIfIdle();
  };

  // The share dialog after a sign-in that the Share button asked for.
  const openShareParam = searchParams.get('openShare');
  useEffect(() => {
    if (!openShareParam || !tripId || currentTrip?.id !== tripId) return;
    setShareOpen(true);
    router.replace(`/results?tripId=${tripId}`);
  }, [openShareParam, tripId, currentTrip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Live cursors (everyone on a shared trip sees everyone's pointer) ───
  const cardsAreaRef = useRef<HTMLDivElement | null>(null);
  const [cursors, setCursors] = useState<Record<string, { x: number; y: number; name: string | null; ts: number }>>({});
  const lastCursorSent = useRef(0);
  const onCardsMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!collab.active || collab.presence.length < 2) return;
      const now = Date.now();
      if (now - lastCursorSent.current < 50) return;
      lastCursorSent.current = now;
      const rect = cardsAreaRef.current?.getBoundingClientRect();
      if (!rect) return;
      collab.broadcastCursor(e.clientX - rect.left, e.clientY - rect.top);
    },
    [collab.active, collab.presence.length, collab.broadcastCursor], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    const ev = collab.cursorEvent;
    if (!ev || !user || ev.actor === user.id) return;
    setCursors((prev) => ({ ...prev, [ev.actor]: { x: ev.x, y: ev.y, name: ev.name, ts: ev.ts } }));
  }, [collab.cursorEvent, user]);
  useEffect(() => {
    const iv = setInterval(() => {
      setCursors((prev) => {
        const cutoff = Date.now() - 4000;
        const next: typeof prev = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (v.ts >= cutoff) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1500);
    return () => clearInterval(iv);
  }, []);

  // A saved trip needs an account. Dismissing sign-in leaves for the hub.
  const signedInRef = useRef(false);
  const signInModal = (
    <LoginModal
      isOpen={!!tripId && !isAuthLoading && !user}
      subtitle="Sign in or create an account to open this trip"
      onSuccess={() => {
        signedInRef.current = true;
      }}
      onClose={(reason) => {
        // Going on to sign up: that page brings them back here afterwards
        // (?next=). Redirecting to /main here overrode it — measured, the
        // popup's "Create account" landed on /main.
        if (reason === 'signup') return;
        collab.dropShareToken();
        setTimeout(() => {
          if (!signedInRef.current) router.push('/main');
        }, 0);
      }}
    />
  );

  const accessGate = collab.accessGate && (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
        <div className="mx-auto mb-3 w-11 h-11 rounded-full flex items-center justify-center bg-red-50">
          <UserX size={20} className="text-red-500" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1.5">
          {collab.accessGate === 'removed'
            ? "You've been removed from this trip"
            : "You don't have access to this trip"}
        </h2>
        <p className="text-[13px] text-gray-500 mb-5">
          {collab.accessGate === 'removed'
            ? 'The trip owner removed you from this trip, so you no longer have access to it.'
            : collab.linkInvalid
              ? 'The link you opened is no longer valid. The owner may have reset it. Ask them for a new link or an invite.'
              : 'This trip isn’t shared with your account. Ask the trip owner for an invite if you think this is a mistake.'}
        </p>
        {reinvite ? (
          <>
            <p className="text-[13px] text-gray-700 mb-3" data-testid="reinvite-note">
              You’ve been invited {collab.accessGate === 'removed' ? 'back ' : ''}as {reinvite.role === 'editor' ? 'an editor' : `a ${reinvite.role}`}.
            </p>
            <button
              onClick={() => openReinvite(reinvite)}
              className="w-full px-4 py-2.5 rounded-xl text-[13px] font-medium text-white bg-[#2563eb] hover:brightness-110 transition-all mb-2"
            >
              Open the trip
            </button>
            <button
              onClick={() => router.push('/history')}
              className="w-full px-4 py-2.5 rounded-xl text-[13px] font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 transition-all"
            >
              Take me back to My Trips
            </button>
          </>
        ) : (
          <button
            onClick={() => router.push('/history')}
            className="w-full px-4 py-2.5 rounded-xl text-[13px] font-medium text-white bg-[#2563eb] hover:brightness-110 transition-all"
          >
            Take me back to My Trips
          </button>
        )}
      </div>
    </div>
  );

  if (tripId && !isAuthLoading && !user) {
    return (
      <main className="h-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
        <p className="text-gray-500 text-sm">Sign in to open this trip</p>
        {signInModal}
      </main>
    );
  }

  if (collab.accessGate) {
    // The navbar stays (with its notification bell): a removed person who is
    // invited again sees it arrive here instead of having to go elsewhere.
    return (
      <main className="h-screen flex flex-col" style={{ background: '#f0f4f8' }}>
        <Navbar />
        {accessGate}
      </main>
    );
  }

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

  // What this person may change. An unsaved trip — or a saved one whose role
  // is still loading for its signed-in owner — is their own to edit.
  const editable = !collab.active || collab.canManipulate;
  const chatAllowed = !collab.active || collab.role !== 'viewer';

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
      {/* When the trip is editable the left edge holds the "Suggested Cities"
          pull-out tab, so the content starts just clear of it. */}
      <div className={`flex-1 min-h-0 flex flex-col md:flex-row gap-3 pb-2 pt-[3rem] w-full ${editable ? 'pl-9' : 'pl-2'} ${chatAllowed && !chatOpen ? 'pr-9' : 'pr-2'}`}>
        {/* Main column — header pinned, cards fill the rest */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <ResultsHeader
            trip={currentTrip}
            pricedTrip={frozenTrip ?? undefined}
            collab={collab}
            onOpenShare={() => setShareOpen(true)}
            membersKey={membersKey}
            canEdit={editable}
          />
          <AnimatePresence>
            {collab.connectionLost && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="mx-4 mt-2 flex items-center justify-center gap-2 py-1.5 rounded-lg text-[12px] text-amber-700" style={{ background: '#fffbeb' }}>
                  <WifiOff size={12} />
                  Connection lost — reconnecting automatically…
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {typeof currentTrip.budget === 'number' && (
            // The total the header shows, not the stored totalCost: that is
            // set once (at creation, or a preset's quote on save) and does
            // not follow a hotel or transport swap.
            <BudgetOverBanner budget={currentTrip.budget} totalCost={liveTripTotal(pricedTrip)} />
          )}
          <NoRailDataNotice trip={currentTrip} />
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
          <div
            ref={cardsAreaRef}
            onMouseMove={onCardsMouseMove}
            className="relative flex-1 min-h-0 overflow-hidden"
          >
            {/* Collaborators' pointers */}
            {Object.keys(cursors).length > 0 && (
              <div className="pointer-events-none absolute inset-0 z-30" aria-hidden>
                {Object.entries(cursors).map(([actor, c]) => {
                  let hash = 0;
                  for (let i = 0; i < actor.length; i++) hash = (hash * 31 + actor.charCodeAt(i)) | 0;
                  const hue = Math.abs(hash) % 360;
                  return (
                    <div key={actor} className="absolute transition-all duration-75 ease-linear" style={{ left: c.x, top: c.y }}>
                      <svg width="16" height="18" viewBox="0 0 16 18" fill="none">
                        <path d="M1 1 L15 8.5 L8.5 10 L5.5 17 Z" fill={`hsl(${hue}, 65%, 50%)`} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
                      </svg>
                      <span
                        className="ml-3 -mt-0.5 inline-block px-1.5 py-0.5 rounded-md text-[10px] font-medium text-white whitespace-nowrap"
                        style={{ background: `hsl(${hue}, 65%, 45%)` }}
                      >
                        {c.name ?? 'Someone'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
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
                editable={editable}
                onReorder={reorderCities}
                onRemoveCity={removeCity}
                onNightsChange={setCityNights}
                onAddCityAfter={(i) => setAddingAfter(i)}
                onEditHome={(d) => setHomeEdit(d)}
                refreshingLegs={refreshingLegs}
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
        {/* Hidden, it stays mounted (the conversation is kept) and the cards
            take the width; a tab on the right edge brings it back. */}
        {chatAllowed && (
          <aside
            className={`max-h-[45vh] md:max-h-none md:w-[340px] lg:w-[380px] md:flex-shrink-0 min-h-0 md:mt-3 ${chatOpen ? 'flex' : 'hidden'}`}
          >
            <AIChatPanel trip={currentTrip} onHide={() => setChatOpen(false)} />
          </aside>
        )}
      </div>

      {/* BlueMurr AI pull-out tab — the right-edge twin of "Suggested Cities". */}
      <AnimatePresence>
        {chatAllowed && !chatOpen && (
          <motion.button
            initial={{ x: 48 }}
            animate={{ x: 0 }}
            exit={{ x: 48 }}
            transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            onClick={() => setChatOpen(true)}
            aria-label="Show BlueMurr AI"
            className="fixed right-0 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-1.5 rounded-l-xl py-3.5 px-1.5 shadow-md hover:shadow-lg transition-shadow"
            style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.08)', borderRight: 'none' }}
          >
            <Sparkles size={13} style={{ color: '#2563eb' }} />
            <span className="text-[10px] font-medium text-gray-600 tracking-wide" style={{ writingMode: 'vertical-rl' }}>
              BlueMurr AI
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* ─── From the canvas: suggested cities, pending suggestions,
          add-city / home-airport editors, the share dialog ─── */}
      {editable && (
        <SuggestedCitiesPanel
          tripId={currentTrip.id ?? ''}
          currentCities={currentTrip.cities.map((c) => c.name)}
          budget={currentTrip.budget}
          role={collab.active ? (collab.role ?? 'viewer') : 'owner'}
          onAddCity={(dest) => addCity(currentTrip.cities.length - 1, { name: dest.name, nights: 2 })}
          onSuggestCity={collab.suggestCity}
        />
      )}
      {collab.active && collab.role && (
        <SuggestionsPanel
          suggestions={collab.suggestions}
          role={collab.role}
          onApprove={(id) =>
            collab.approve(id, (name) =>
              addCity((useTripStore.getState().currentTrip?.cities.length ?? 1) - 1, { name, nights: 2 }),
            )
          }
          onReject={collab.reject}
        />
      )}
      <AddCityModal
        isOpen={addingAfter !== null}
        onClose={() => setAddingAfter(null)}
        onAdd={(data) => {
          const after = addingAfter ?? currentTrip.cities.length - 1;
          setAddingAfter(null);
          addCity(after, data);
        }}
        currentCities={currentTrip.cities.map((c) => c.name)}
      />
      <HomeEditModal
        isOpen={homeEdit !== null}
        direction={homeEdit ?? 'outbound'}
        city={
          homeEdit === 'inbound'
            ? currentTrip.origin?.returnCity ?? currentTrip.origin?.city ?? ''
            : currentTrip.origin?.city ?? ''
        }
        airports={
          homeEdit === 'inbound'
            ? currentTrip.origin?.returnAirports ?? currentTrip.origin?.airports ?? []
            : currentTrip.origin?.airports ?? []
        }
        onClose={() => setHomeEdit(null)}
        onApply={(updates) => homeEdit && applyHomeEdit(homeEdit, updates)}
      />
      {currentTrip.id && !currentTrip.id.startsWith('mock') && (
        <ShareModal
          tripId={currentTrip.id}
          role={collab.role ?? 'owner'}
          isOpen={shareOpen}
          onClose={() => {
            setShareOpen(false);
            setMembersKey((k) => k + 1);
          }}
          onToast={collab.showToast}
          onRoleChanged={(target, role) => {
            collab.broadcastRoleChange(target, role);
            setMembersKey((k) => k + 1);
          }}
          onTransferred={collab.onTransferred}
        />
      )}

      {/* ─── Toast ─── */}
      <AnimatePresence>
        {collab.toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-full text-[13px] font-medium shadow-lg"
            style={{
              background:
                collab.toast.type === 'success'
                  ? 'rgba(34,192,136,0.95)'
                  : collab.toast.type === 'error'
                    ? 'rgba(220,38,38,0.95)'
                    : 'rgba(37,99,235,0.95)',
              color: '#ffffff',
            }}
            role="status"
          >
            {collab.toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

/** What a date change on the trip on screen leaves to re-price (see the subscription above). */
type DatedWork = {
  /** Stays whose dates moved — their hotels are searched for the new ones. */
  hotels: number[];
  /** Inter-city legs (i → i + 1) whose travel day moved. */
  legs: number[];
  /** Re-search the outbound leaving this day (the first stay moved, the flight did not). */
  outboundFrom: string | null;
  /** Re-search the return (the last stay's departure moved, the flight did not). */
  ret: boolean;
};

/**
 * The same flight, whatever object it arrives in: an accepted AI proposal
 * comes back from the server as a copy of the whole trip, so identity says
 * nothing.
 */
function sameLeg(a: HomeLeg | null | undefined, b: HomeLeg | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.originAirport === b.originAirport &&
    a.destAirport === b.destAirport &&
    a.departDate === b.departDate &&
    a.departTime === b.departTime &&
    a.arriveDate === b.arriveDate &&
    a.operator === b.operator &&
    a.price === b.price
  );
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function datedWork(prev: Trip, next: Trip): DatedWork | null {
  // Only the same itinerary moving in time. Another trip, or stops added,
  // removed or reordered, is a different trip, priced where it was built.
  if ((prev.id ?? null) !== (next.id ?? null)) return null;
  if (prev.cities.length !== next.cities.length || next.cities.length === 0) return null;
  if (prev.cities.some((c, i) => c.name !== next.cities[i].name)) return null;

  const hotels: number[] = [];
  const legs: number[] = [];
  next.cities.forEach((c, i) => {
    const p = prev.cities[i];
    if (!p.dates || !c.dates) return;
    // A stay or leg the same update already re-priced (an accepted AI date
    // edit carries hotels and legs searched for the new dates, so its card
    // states the exact total) is not searched again: a second search would
    // move the header by an amount the card never showed.
    // Compared by content: a copy of the same leg or hotels is not a re-price.
    if ((p.dates.arrival !== c.dates.arrival || p.dates.departure !== c.dates.departure) && sameJson(c.hotels, p.hotels)) hotels.push(i);
    if (i < next.cities.length - 1 && p.dates.departure !== c.dates.departure && sameJson(c.transportOut, p.transportOut)) legs.push(i);
  });
  const moved = next.cities.some(
    (c, i) => !!prev.cities[i].dates && !!c.dates && (prev.cities[i].dates.arrival !== c.dates.arrival || prev.cities[i].dates.departure !== c.dates.departure),
  );
  if (!moved) return null;

  const origin = next.origin;
  const last = next.cities.length - 1;
  const firstMoved = prev.cities[0].dates.arrival !== next.cities[0].dates.arrival;
  const prevStart = tripStartDate(prev);
  const outboundFrom =
    origin?.city &&
    origin.outboundLeg &&
    sameLeg(origin.outboundLeg, prev.origin?.outboundLeg) &&
    firstMoved &&
    prevStart
      ? addDaysIso(prevStart, daysFrom(prev.cities[0].dates.arrival, next.cities[0].dates.arrival))
      : null;
  // A flight home that is missing is searched too: measured, two quick
  // clicks on a stay's "+" cleared it for the first new date, the second
  // click then saw no flight and searched nothing, and the first answer was
  // dropped as stale — the trip was left with no flight home.
  const ret = !!(
    origin?.city &&
    (next.returnToHome ?? true) &&
    sameLeg(origin.returnLeg, prev.origin?.returnLeg) &&
    prev.cities[last].dates.departure !== next.cities[last].dates.departure
  );
  return { hotels, legs, outboundFrom, ret };
}

/**
 * A compare-leg answer as the leg card shows it: the recommended mode as the
 * transport, the other (when there is one) as its alternative. A search that
 * found neither is the existing "no direct option" card, never a $0 flight
 * still carrying the old day's price.
 */
function comparisonToTransport(
  result: LegComparison | null | undefined,
  from: string,
  to: string,
  date: string,
): Transport {
  const hhmm = (iso?: string | null) => (iso ? iso.split('T')[1]?.slice(0, 5) : undefined);
  const duration = formatMinutes;
  const flight = result?.flightOption ?? null;
  const train = result?.trainOption ?? null;
  const asTransport = (mode: 'flight' | 'train'): Transport | null => {
    if (mode === 'flight' && flight) {
      return {
        mode,
        operator: flight.carrier ?? '',
        duration: duration(flight.durationMinutes ?? 0),
        price: flight.price ?? 0,
        from,
        to,
        departTime: hhmm(flight.departure),
        arriveTime: hhmm(flight.arrival),
        departDate: date,
        layovers: flight.stops ?? 0,
        bookingUrl: flight.bookingUrl || undefined,
      };
    }
    if (mode === 'train' && train && train.price != null) {
      return {
        mode,
        operator: train.operator ?? '',
        duration: duration(train.durationMinutes ?? 0),
        price: train.price,
        from,
        to,
        departTime: hhmm(train.departure),
        arriveTime: hhmm(train.arrival),
        departDate: date,
        layovers: 0,
        bookingUrl: train.bookingUrl || undefined,
      };
    }
    return null;
  };
  const preferTrain = result?.recommendation === 'train';
  const main =
    asTransport(preferTrain ? 'train' : 'flight') ?? asTransport(preferTrain ? 'flight' : 'train');
  if (!main) {
    return { mode: 'flight', operator: '', duration: '', price: 0, from, to, departDate: date, unavailable: true };
  }
  const other = asTransport(main.mode === 'flight' ? 'train' : 'flight');
  return { ...main, alternatives: other ? [other] : [] };
}
