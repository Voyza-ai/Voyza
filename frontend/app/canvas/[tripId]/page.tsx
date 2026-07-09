'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { Save, Share2, WifiOff, ArrowLeft, Sparkles, X } from 'lucide-react';
import CanvasCityCard from '@/components/canvas/CanvasCityCard';
import CanvasConnector from '@/components/canvas/CanvasConnector';
import CanvasHomeCard from '@/components/canvas/CanvasHomeCard';
import SuggestedCitiesPanel from '@/components/canvas/SuggestedCitiesPanel';
import SuggestionsPanel from '@/components/canvas/SuggestionsPanel';
import ShareModal from '@/components/canvas/ShareModal';
import LoginModal from '@/components/shared/LoginModal';
import AddCityModal from '@/components/canvas/AddCityModal';
import HomeEditModal from '@/components/canvas/HomeEditModal';
import AIChatPanel from '@/components/results/AIChatPanel';
import { useCanvasRealtime } from '@/hooks/useCanvasRealtime';
import { useAuthStore } from '@/store/authStore';
import { useTripStore } from '@/store/tripStore';
import {
  getCanvasSession,
  saveCanvas,
  getCanvasSuggestions,
  postCanvasSuggestion,
  updateSuggestionStatus,
  getTrip,
  searchHotels,
  fetchHomeLegs,
  joinCanvasByLink,
  Destination,
} from '@/lib/api';
import { nextColorIndex, withColorIndices } from '@/lib/cityColors';
import { readCanvasSync, clearCanvasSync } from '@/lib/canvasHandoff';
import { liveTripTotal } from '@/lib/tripTotals';
import { Trip } from '@/lib/types';

export default function CanvasPage() {
  const params = useParams();
  const router = useRouter();
  const tripId = params.tripId as string;
  const user = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.isLoading);
  const storeTrip = useTripStore((s) => s.currentTrip);
  const storeCities = storeTrip?.cities;

  const [role, setRole] = useState<string>('viewer');
  const [localState, setLocalState] = useState<any>(null);
  const [savedState, setSavedState] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [addingAfterIndex, setAddingAfterIndex] = useState<number | null>(null);
  const [hotelLoadingCities, setHotelLoadingCities] = useState<string[]>([]);
  const [homeEdit, setHomeEdit] = useState<'outbound' | 'inbound' | null>(null);
  const [homeLegLoading, setHomeLegLoading] = useState<'outbound' | 'inbound' | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  // Share-link join: token from ?share=… (read once; cleared after joining)
  const [shareToken, setShareToken] = useState<string | null>(() =>
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('share')
      : null,
  );
  const [sessionNonce, setSessionNonce] = useState(0);
  // Timestamp of the newest applied live op — lets the session load and
  // the op-apply effect coordinate (never overwrite newer with older).
  const lastAppliedOpRef = useRef<number>(0);
  const [loading, setLoading] = useState(true);

  // Presence identity for the realtime channel (ref-tracked in the hook,
  // so object identity churn here doesn't resubscribe).
  const presenceUser = useMemo(
    () =>
      user
        ? {
            id: user.id,
            email: user.email ?? null,
            name: ((user.user_metadata?.full_name as string) || null),
          }
        : null,
    [user],
  );
  const { canvasState, suggestions, isConnected, presence, remoteOp, broadcastOp } =
    useCanvasRealtime(tripId, presenceUser);

  // Unsaved changes detection — covers city edits AND home-card (origin)
  // edits, so both enable Save and trigger the leave-without-saving warning.
  const hasUnsavedChanges = useMemo(() => {
    if (!localState || !savedState) return false;
    return (
      JSON.stringify(localState.cities) !== JSON.stringify(savedState.cities) ||
      JSON.stringify(localState.trip?.origin ?? null) !==
        JSON.stringify(savedState.trip?.origin ?? null)
    );
  }, [localState, savedState]);

  // Warn before leaving with unsaved changes. Covers in-app navigation
  // (Back / VOYZA) via navigateAway(), and browser refresh/close/tab-switch
  // via the beforeunload prompt below.
  const navigateAway = useCallback(
    (path: string) => {
      if (
        hasUnsavedChanges &&
        !window.confirm('You have unsaved changes. Leave without saving?')
      ) {
        return;
      }
      router.push(path);
    },
    [hasUnsavedChanges, router],
  );

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  // Join via share link BEFORE loading the session, so the session load
  // sees the new membership/role. Requires sign-in (LoginModal below);
  // once the user exists the join runs, the URL param is stripped, and
  // sessionNonce retriggers the load.
  useEffect(() => {
    if (!shareToken || !tripId || !user) return;
    (async () => {
      try {
        const r = await joinCanvasByLink(tripId, shareToken);
        if (r.joined) showToast(`You joined this trip as ${r.role}`, 'success');
      } catch {
        showToast('This share link is invalid or has been reset', 'error');
      } finally {
        setShareToken(null);
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href);
          url.searchParams.delete('share');
          window.history.replaceState({}, '', url.toString());
        }
        setSessionNonce((n) => n + 1);
      }
    })();
  }, [shareToken, tripId, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load initial session
  useEffect(() => {
    if (!tripId) return;
    // A pending share-link join changes our role — wait for it.
    if (shareToken && user) return;

    (async () => {
      try {
        // First try creating/resuming the canvas session.
        // Pass store cities as fallback for trips with no cities in the DB.
        let fallbackCities = storeCities ?? undefined;

        // If the store is empty (e.g. new tab), fetch the trip from the API
        // to get the cities for the fallback.
        if (!fallbackCities) {
          try {
            const tripData = await getTrip(tripId);
            const trip = tripData.trip ?? tripData;
            if (trip?.cities && Array.isArray(trip.cities)) {
              fallbackCities = trip.cities;
            }
          } catch {
            // Trip fetch failed — continue without fallback
          }
        }

        const { session, role: userRole } = await getCanvasSession(tripId, fallbackCities);
        setRole(userRole);

        // Inject origin/returnToHome if the DB doesn't have it
        const sessionState = { ...session.state };
        if (!sessionState.trip?.origin) {
          // Try Zustand store first, then localStorage
          let originData = storeTrip?.origin
            ? { origin: storeTrip.origin, returnToHome: storeTrip.returnToHome ?? true }
            : null;

          if (!originData && typeof window !== 'undefined') {
            try {
              const stored = localStorage.getItem(`voyza-origin-${tripId}`);
              if (stored) {
                originData = JSON.parse(stored);
              }
            } catch {}
          }

          if (originData) {
            sessionState.trip = {
              ...(sessionState.trip ?? {}),
              origin: originData.origin,
              returnToHome: originData.returnToHome ?? true,
            };
          }
        }

        // Results-page handoff: if the trip was just edited on the results
        // page (e.g. via the AI chat), apply those cities/origin over the
        // saved session so the canvas reflects the latest state.
        let syncedFromResults = false;
        if (typeof window !== 'undefined') {
          const sync = readCanvasSync(tripId);
          if (sync?.cities && Array.isArray(sync.cities) && sync.cities.length > 0) {
            clearCanvasSync(tripId);
            sessionState.cities = sync.cities;
            if (sync.origin) {
              sessionState.trip = {
                ...(sessionState.trip ?? {}),
                origin: sync.origin,
                returnToHome: sync.returnToHome ?? true,
              };
            }
            syncedFromResults = true;
          }
        }

        // Lock in each city's color so it stops depending on position —
        // reordering will no longer reshuffle colors from here on.
        if (Array.isArray(sessionState.cities)) {
          sessionState.cities = withColorIndices(sessionState.cities);
        }

        // A live op that arrived while we were loading is newer than any
        // DB read — don't clobber it with stale session state.
        if (lastAppliedOpRef.current === 0) {
          setLocalState(sessionState);
          setSavedState(sessionState);
        }

        // Persist the results edits into the canvas session so they survive
        // reloads and reach collaborators (the save endpoint is owner-gated).
        if (syncedFromResults && userRole === 'owner') {
          saveCanvas(tripId, sessionState).catch(() => {});
        }

        await getCanvasSuggestions(tripId);
      } catch {
        showToast('Failed to load canvas session', 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [tripId, sessionNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync realtime state (from other users). Applies to EVERY role —
  // editors save now, so the owner receives updates too. Two guards:
  // identical states are skipped (echo of our own save), and a client
  // that's mid-edit keeps its local work instead of being clobbered
  // (proper per-op reconciliation lands with live editing, Phase B).
  const hasUnsavedRef = useRef(false);
  useEffect(() => {
    hasUnsavedRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!canvasState) return;
    if (JSON.stringify(canvasState) === JSON.stringify(localStateRef.current)) return;
    if (hasUnsavedRef.current) return;
    setLocalState(canvasState);
    setSavedState(canvasState);
    showToast('Trip updated by a collaborator', 'info');
  }, [canvasState]); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleSave = async () => {
    if (!canEdit || !localState) return;
    setSaving(true);
    try {
      await saveCanvas(tripId, localState);
      setSavedState(localState);
      showToast('Changes saved to your trip', 'success');
    } catch {
      showToast('Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveCity = (index: number) => {
    if (!localState?.cities) return;
    const cities = [...localState.cities];
    cities.splice(index, 1);
    setLocalState({ ...localState, cities: recalcDates(cities) });
  };

  const recalcDates = (cities: any[]) => {
    if (cities.length === 0) return cities;
    // Anchor the chain to the EARLIEST arrival across all cities so the trip's
    // start date stays fixed no matter how cities are reordered. (Taking the
    // first card's arrival instead would shift the whole trip whenever a
    // different city is moved to the front.)
    //
    // Newly-added cities carry a 2000-01-01 placeholder arrival that only
    // encodes their night count — skip those so they don't drag the start
    // back to the year 2000.
    const isPlaceholder = (iso: string) => iso.startsWith('2000-');
    let startDate = '';
    for (const c of cities) {
      const a = c.dates?.arrival;
      if (a && a.includes('-') && !isPlaceholder(a)) {
        if (!startDate || a < startDate) startDate = a;
      }
    }
    // All cities are placeholders (e.g. a brand-new trip with no real dates
    // yet) — fall back to the first valid arrival so the chain still builds.
    if (!startDate) {
      for (const c of cities) {
        if (c.dates?.arrival && c.dates.arrival.includes('-')) {
          startDate = c.dates.arrival;
          break;
        }
      }
    }
    if (!startDate) return cities;

    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const parseDate = (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d);
    };

    let cursor = parseDate(startDate);
    return cities.map((city: any) => {
      // Compute how many nights this city had
      let nights = 2; // default
      if (city.dates?.arrival && city.dates?.departure && city.dates.arrival.includes('-') && city.dates.departure.includes('-')) {
        const arr = parseDate(city.dates.arrival);
        const dep = parseDate(city.dates.departure);
        nights = Math.max(1, Math.round((dep.getTime() - arr.getTime()) / 86400000));
      }
      const arrival = toIso(cursor);
      const dep = new Date(cursor);
      dep.setDate(dep.getDate() + nights);
      const departure = toIso(dep);
      cursor = dep; // next city starts when this one ends
      return { ...city, dates: { arrival, departure } };
    });
  };

  const handleReorder = (newOrder: any[]) => {
    if (!localState) return;
    setLocalState({ ...localState, cities: recalcDates(newOrder) });
  };

  const handleAddAfter = (index: number) => {
    setAddingAfterIndex(index);
  };

  // Fetches real hotels for a freshly added city and merges them into the
  // first matching city that still has no hotels. Matching by name (not
  // index) keeps it correct even if the user reorders while the request is
  // in flight.
  const enrichCityHotels = async (cityName: string, checkin: string, checkout: string) => {
    if (!cityName || !checkin || !checkout) return;
    setHotelLoadingCities((prev) => (prev.includes(cityName) ? prev : [...prev, cityName]));
    try {
      const results = await searchHotels({
        city: cityName,
        checkin,
        checkout,
        adults: localState?.trip?.travelers ?? 1,
      });
      if (results.length === 0) return;
      const hotels = results.map((r) => ({
        name: r.name,
        rating: r.rating,
        pricePerNight: r.pricePerNight,
        area: '',
        bookingUrl: r.bookingUrl,
      }));
      setLocalState((prev: any) => {
        if (!prev?.cities) return prev;
        let merged = false;
        const cities = prev.cities.map((c: any) => {
          if (!merged && c.name === cityName && (!c.hotels || c.hotels.length === 0)) {
            merged = true;
            return { ...c, hotels, hotel: hotels[0], selectedHotelIndex: 0 };
          }
          return c;
        });
        return { ...prev, cities };
      });
    } catch {
      // Hotel fetch failed — city stays with its "Select hotel" placeholder.
    } finally {
      setHotelLoadingCities((prev) => prev.filter((n) => n !== cityName));
    }
  };

  const handleAddCityConfirm = (cityData: { name: string; country?: string; nights: number }) => {
    if (addingAfterIndex === null || !localState?.cities) return;
    const cities = [...localState.cities];

    // Create new city with placeholder dates — recalcDates will fix them
    // We set a temporary departure offset so recalcDates knows the night count
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const tempArr = new Date(2000, 0, 1);
    const tempDep = new Date(2000, 0, 1 + cityData.nights);

    const newCity = {
      name: cityData.name,
      country: cityData.country ?? '',
      // Permanent color slot — distinct from existing cities and stable
      // across reordering.
      colorIndex: nextColorIndex(cities),
      dates: { arrival: toIso(tempArr), departure: toIso(tempDep) },
      hotel: { name: 'Select hotel', rating: 0, pricePerNight: 0, area: '' },
      hotels: [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      transportIn: { mode: 'flight', operator: '', duration: '', price: 0 },
      transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
    };
    cities.splice(addingAfterIndex + 1, 0, newCity);
    const recalced = recalcDates(cities);
    setLocalState({ ...localState, cities: recalced });

    // Auto-fetch the hotel for the new city so it shows up on the card
    // (and gets persisted on save) instead of staying "Select hotel".
    const inserted = recalced[addingAfterIndex + 1];
    enrichCityHotels(inserted?.name, inserted?.dates?.arrival, inserted?.dates?.departure);

    setAddingAfterIndex(null);
  };

  const handleAddSuggestedCity = (dest: Destination) => {
    if (!localState?.cities) return;
    const cities = [...localState.cities];

    // Seed temporary dates (2 nights) so recalcDates can chain the new city
    // onto the trip — which also gives the hotel search valid check-in/out.
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const nights = 2;

    cities.push({
      name: dest.name,
      country: '',
      colorIndex: nextColorIndex(cities),
      dates: { arrival: toIso(new Date(2000, 0, 1)), departure: toIso(new Date(2000, 0, 1 + nights)) },
      hotel: { name: 'Select hotel', rating: 0, pricePerNight: 0, area: '' },
      hotels: [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      transportIn: { mode: 'flight', operator: '', duration: '', price: 0 },
      transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
    });
    const recalced = recalcDates(cities);
    setLocalState({ ...localState, cities: recalced });

    const inserted = recalced[recalced.length - 1];
    enrichCityHotels(inserted?.name, inserted?.dates?.arrival, inserted?.dates?.departure);

    showToast(`${dest.name} added to canvas`, 'success');
  };

  const handleSuggestCity = async (dest: Destination) => {
    try {
      await postCanvasSuggestion(tripId, 'add_city', {
        name: dest.name,
        estimatedCost: dest.estimatedCost,
        reason: dest.reason,
      });
      showToast('Suggestion submitted', 'success');
    } catch {
      showToast('Failed to submit suggestion', 'error');
    }
  };

  const handleApprove = async (suggestionId: string) => {
    try {
      const result = await updateSuggestionStatus(tripId, suggestionId, 'approved');
      // If it's an add_city suggestion, animate it onto the canvas
      const suggestion = suggestions.find((s) => s.id === suggestionId);
      if (suggestion?.type === 'add_city' && suggestion.payload?.name) {
        handleAddSuggestedCity({
          name: suggestion.payload.name,
          estimatedCost: suggestion.payload.estimatedCost ?? 0,
          reason: suggestion.payload.reason ?? '',
        });
      }
      showToast('Suggestion approved', 'success');
    } catch {
      showToast('Failed to approve', 'error');
    }
  };

  const handleReject = async (suggestionId: string) => {
    try {
      await updateSuggestionStatus(tripId, suggestionId, 'rejected');
      showToast('Suggestion rejected', 'info');
    } catch {
      showToast('Failed to reject', 'error');
    }
  };

  // Apply a home-card edit from the popup. The two cards are independent:
  // the outbound card owns city/airports, the back-home card owns
  // returnCity/returnAirports. After updating, the affected direction's
  // flight is re-searched automatically.
  const applyHomeEdit = async (
    direction: 'outbound' | 'inbound',
    updates: { city: string; airports: string[] },
  ) => {
    if (!localState?.trip) return;
    setHomeEdit(null);

    const currentOrigin = localState.trip.origin ?? { city: '', airports: [] };
    const newOrigin =
      direction === 'outbound'
        ? { ...currentOrigin, city: updates.city, airports: updates.airports, outboundLeg: null }
        : { ...currentOrigin, returnCity: updates.city, returnAirports: updates.airports, returnLeg: null };

    setLocalState((prev: any) => ({
      ...prev,
      trip: { ...prev.trip, origin: newOrigin },
    }));

    // Re-search this direction's flight with the new airports.
    const tripCities = localState?.cities ?? [];
    const first = tripCities[0];
    const last = tripCities[tripCities.length - 1];
    if (!first || !last || !first.dates?.arrival) return;

    setHomeLegLoading(direction);
    try {
      const legs = await fetchHomeLegs({
        originAirports: updates.airports,
        firstCity: first.name,
        lastCity: last.name,
        startDate: first.dates.arrival,
        endDate: last.dates?.departure,
        travelers: localState?.trip?.travelers ?? 1,
        outbound: direction === 'outbound',
        returnToHome: direction === 'inbound',
      });
      const leg = direction === 'outbound' ? legs.outboundLeg : legs.returnLeg;
      setLocalState((prev: any) => {
        if (!prev?.trip?.origin) return prev;
        const o = { ...prev.trip.origin };
        if (direction === 'outbound') o.outboundLeg = leg ?? null;
        else o.returnLeg = leg ?? null;
        return { ...prev, trip: { ...prev.trip, origin: o } };
      });
      if (!leg) showToast('No flights found for that airport', 'info');
    } catch {
      showToast('Flight search failed — card updated without a flight', 'error');
    } finally {
      setHomeLegLoading(null);
    }
  };

  const cities = localState?.cities ?? [];
  // Derive the header live from the current cities so it updates as cities
  // are added, removed, or reordered — instead of the stale stored title.
  const tripTitle =
    cities.length > 0
      ? cities.map((c: any) => c.name).join(' → ')
      : localState?.trip?.title ?? 'Canvas';
  const origin = localState?.trip?.origin ?? null;
  const returnToHome = localState?.trip?.returnToHome ?? false;
  const canEdit = role === 'owner' || role === 'editor';

  // ── Canvas state ⇄ Trip adapters ─────────────────────────────────
  // The AI chat and the totals util both speak the results page's Trip
  // shape; the canvas keeps { trip: {origin,…}, cities } in localState.
  // buildCanvasTrip normalizes local state into a Trip (defensive about
  // cities saved before hotels[] / selectedHotelIndex existed).
  const buildCanvasTrip = useCallback(
    (ls: any): Trip | null => {
      if (!ls?.cities || ls.cities.length === 0) return null;
      const normCities = ls.cities.map((c: any) => ({
        ...c,
        hotels: Array.isArray(c.hotels) && c.hotels.length > 0 ? c.hotels : c.hotel ? [c.hotel] : [],
        selectedHotelIndex: typeof c.selectedHotelIndex === 'number' ? c.selectedHotelIndex : 0,
      }));
      return {
        id: tripId,
        title: ls.trip?.title ?? '',
        cities: normCities,
        travelers: ls.trip?.travelers ?? storeTrip?.travelers ?? 1,
        totalCost: 0,
        savings: ls.trip?.savings ?? 0,
        origin: ls.trip?.origin ?? undefined,
        returnToHome: ls.trip?.returnToHome,
        budget: ls.trip?.budget,
        dateShiftSuggestion: undefined,
      } as Trip;
    },
    [tripId, storeTrip?.travelers],
  );

  const canvasTrip = useMemo(() => buildCanvasTrip(localState), [buildCanvasTrip, localState]);
  const liveTotal = canvasTrip ? liveTripTotal(canvasTrip) : 0;
  const travelers = canvasTrip?.travelers ?? 1;

  // The chat needs the FRESHEST state when applying leg refreshes (its
  // callback closures outlive renders) — read through a ref.
  const localStateRef = useRef(localState);
  useEffect(() => {
    localStateRef.current = localState;
  }, [localState]);
  const getLatestCanvasTrip = useCallback(
    () => buildCanvasTrip(localStateRef.current),
    [buildCanvasTrip],
  );

  // Chat edits land in canvas local state: cities replaced wholesale
  // (color indices re-locked), origin/returnToHome merged into trip —
  // marking unsaved changes exactly like a manual edit.
  const applyChatTrip = useCallback((updated: Trip) => {
    setLocalState((prev: any) => ({
      ...prev,
      cities: withColorIndices(updated.cities as any[]),
      trip: {
        ...(prev?.trip ?? {}),
        origin: updated.origin ?? prev?.trip?.origin ?? null,
        returnToHome: updated.returnToHome ?? prev?.trip?.returnToHome,
      },
    }));
  }, []);

  // ── Live sync (Phase B) ──────────────────────────────────────
  // Remote ops apply immediately (last-write-wins); our own edits
  // broadcast after 400ms of quiet and autosave after 2s.
  const applyingRemoteRef = useRef(false);
  const savedStateRef = useRef(savedState);
  useEffect(() => {
    savedStateRef.current = savedState;
  }, [savedState]);

  useEffect(() => {
    if (!remoteOp || !user || remoteOp.actor === user.id) return;
    // Apply each op exactly once — guards against object-identity churn
    // (and replays) turning this effect into a render loop.
    if (remoteOp.ts <= lastAppliedOpRef.current) return;
    lastAppliedOpRef.current = remoteOp.ts;
    applyingRemoteRef.current = true;
    // The actor owns persistence (their autosave lands ~2s later) — treat
    // the broadcast state as canonical so receivers don't show phantom
    // "unsaved changes" for someone else's work.
    setLocalState(remoteOp.state);
    setSavedState(remoteOp.state);
  }, [remoteOp, user]);

  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Skip the render caused by applying someone else's op.
    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false;
      return;
    }
    if (!canEdit || !localState) return;
    if (JSON.stringify(localState) === JSON.stringify(savedStateRef.current)) return;

    if (broadcastTimerRef.current) clearTimeout(broadcastTimerRef.current);
    broadcastTimerRef.current = setTimeout(() => {
      broadcastOp(localState);
    }, 400);

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await saveCanvas(tripId, localState);
        setSavedState(localState);
      } catch {
        showToast('Autosave failed — click Save to retry', 'error');
      } finally {
        setSaving(false);
      }
    }, 2000);
  }, [localState, canEdit, broadcastOp, tripId, showToast]);

  // Clear pending timers on unmount so nothing fires into a dead tree.
  useEffect(
    () => () => {
      if (broadcastTimerRef.current) clearTimeout(broadcastTimerRef.current);
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    },
    [],
  );

  // User initials for avatar
  const userInitials = (() => {
    const name = user?.user_metadata?.full_name as string | undefined;
    if (name) return name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2);
    return (user?.email?.[0] ?? '?').toUpperCase();
  })();

  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[#2563eb] border-t-transparent rounded-full animate-spin" />
          <span className="text-gray-500 text-sm">Loading canvas...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col" style={{ background: '#f0f4f8' }}>
      {/* ─── Top bar — white card with blue bottom border ─── */}
      <div
        className="flex-shrink-0 h-14 px-5 flex items-center justify-between"
        style={{
          background: '#ffffff',
          borderBottom: '2px solid #2563eb',
        }}
      >
        {/* Left: Back button + VOYZA logo + trip title */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigateAway(`/results?tripId=${tripId}`)}
            className="flex items-center gap-1.5 text-gray-500 hover:text-gray-800 transition-colors text-[13px]"
          >
            <ArrowLeft size={14} />
            <span className="hidden sm:inline">Back</span>
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <button
            onClick={() => navigateAway('/main')}
            className="text-[16px] font-bold tracking-tight hover:opacity-80 transition-opacity"
            style={{ color: '#2563eb' }}
          >
            VOYZA
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <span className="text-gray-800 text-[14px] font-medium truncate max-w-[40vw]" title={tripTitle}>
            {tripTitle}
          </span>
          {hasUnsavedChanges && (
            <span className="text-[11px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
              Unsaved changes
            </span>
          )}
        </div>

        {/* Center: live presence — who's in the canvas right now */}
        <div className="flex items-center gap-1.5">
          {(presence.length > 0
            ? presence
            : presenceUser
              ? [presenceUser]
              : []
          )
            .slice(0, 6)
            .map((p) => {
              const label = p.name || p.email || '?';
              const initials = (p.name || p.email || '?')
                .split(/[\s@]+/)
                .map((w: string) => w[0])
                .join('')
                .toUpperCase()
                .slice(0, 2);
              let hash = 0;
              for (let i = 0; i < p.id.length; i++) hash = (hash * 31 + p.id.charCodeAt(i)) | 0;
              const hue = Math.abs(hash) % 360;
              const isSelf = p.id === user?.id;
              return (
                <div
                  key={p.id}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium text-white border-2 border-[#4ade80]"
                  style={{ background: isSelf ? '#2563eb' : `hsl(${hue}, 55%, 48%)` }}
                  title={isSelf ? 'You' : label}
                >
                  {initials}
                </div>
              );
            })}
          {presence.length > 6 && (
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium text-gray-500 bg-gray-100 border-2 border-gray-200">
              +{presence.length - 6}
            </div>
          )}
        </div>

        {/* Right: total + connection status + Invite + Save */}
        <div className="flex items-center gap-2.5">
          {/* Live trip total — same math as the results header (hotels ×
              nights × rooms + all transports incl. home legs) */}
          {canvasTrip && liveTotal > 0 && (
            <div
              className="flex items-baseline gap-1.5 px-3 py-1 rounded-lg"
              style={{ background: '#eef3fb', border: '1px solid #d4e2f7' }}
              title="Live total — updates as you edit"
            >
              <span className="text-[10px] uppercase tracking-wide font-medium" style={{ color: '#2e6bc4' }}>
                Total
              </span>
              <span className="text-[14px] font-bold" style={{ color: '#1a3a5c' }}>
                ${liveTotal.toLocaleString()}
              </span>
              {travelers > 1 && (
                <span className="text-[10.5px] text-gray-400">
                  ${Math.round(liveTotal / travelers).toLocaleString()}/person
                </span>
              )}
            </div>
          )}

          {/* Connection indicator */}
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
            style={{
              background: isConnected ? '#f0fdf4' : '#fef2f2',
              color: isConnected ? '#16a34a' : '#dc2626',
              border: `1px solid ${isConnected ? '#bbf7d0' : '#fecaca'}`,
            }}
          >
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: isConnected ? '#16a34a' : '#dc2626' }}
            />
            {isConnected ? 'Live' : 'Reconnecting...'}
          </div>

          {role === 'owner' && (
            <button
              onClick={() => setShowInvite(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-medium transition-all hover:bg-gray-50"
              style={{
                color: '#2563eb',
                border: '1px solid #2563eb',
              }}
            >
              <Share2 size={12} />
              Share
            </button>
          )}

          {canEdit && (
            <button
              onClick={handleSave}
              disabled={saving || !hasUnsavedChanges}
              title="Changes autosave — click to save immediately"
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-60"
              style={{ background: saving || hasUnsavedChanges ? '#2563eb' : '#16a34a' }}
            >
              <Save size={12} />
              {saving ? 'Saving…' : hasUnsavedChanges ? 'Save' : 'Saved ✓'}
            </button>
          )}
        </div>
      </div>

      {/* ─── Reconnecting banner ─── */}
      <AnimatePresence>
        {!isConnected && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-center gap-2 py-1.5 text-[12px] text-amber-700" style={{ background: '#fffbeb' }}>
              <WifiOff size={12} />
              Connection lost — reconnecting automatically...
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Body row: canvas + docked Voyza AI chat ─── */}
      <div className="flex-1 flex min-h-0">
      {/* ─── Main canvas area ─── */}
      <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden flex items-center px-12">
        <div className="flex items-center min-w-max gap-0">
          {cities.length === 0 && (
            <div className="flex flex-col items-center gap-4 text-center px-8">
              <div className="text-gray-400 text-[14px]">No cities yet</div>
              {canEdit && (
                <button
                  onClick={() => setAddingAfterIndex(-1)}
                  className="px-5 py-2.5 rounded-xl text-[13px] font-medium text-white transition-all hover:brightness-110"
                  style={{ background: '#2563eb' }}
                >
                  Add your first city
                </button>
              )}
            </div>
          )}

          {/* Home card (outbound) */}
          {origin?.city && cities.length > 0 && (
            <div className="flex items-center">
              <CanvasHomeCard
                origin={origin}
                direction="outbound"
                onEdit={canEdit ? () => setHomeEdit('outbound') : undefined}
                legLoading={homeLegLoading === 'outbound'}
              />
              <CanvasConnector
                transport={origin.outboundLeg ? {
                  mode: 'flight',
                  price: origin.outboundLeg.price ?? 0,
                  duration: origin.outboundLeg.durationMinutes
                    ? `${Math.floor(origin.outboundLeg.durationMinutes / 60)}h ${origin.outboundLeg.durationMinutes % 60}m`
                    : '',
                  operator: origin.outboundLeg.operator ?? '',
                } : null}
                canEdit={canEdit}
                onAddCity={() => setAddingAfterIndex(-1)}
              />
            </div>
          )}

          <Reorder.Group
            axis="x"
            values={cities}
            onReorder={canEdit ? handleReorder : () => {}}
            className="flex items-center gap-0"
            as="div"
          >
            {cities.map((city: any, idx: number) => (
              <Reorder.Item
                key={city.name + '-' + idx}
                value={city}
                className="flex items-center"
                dragListener={canEdit}
                whileDrag={{ scale: 1.05, zIndex: 50, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                as="div"
              >
                <CanvasCityCard
                  city={city}
                  index={idx}
                  role={role}
                  isLast={idx === cities.length - 1}
                  hotelLoading={
                    hotelLoadingCities.includes(city.name) &&
                    (!city.hotels || city.hotels.length === 0)
                  }
                  onRemove={handleRemoveCity}
                  onAddAfter={handleAddAfter}
                />

                {/* Connector between cards */}
                {idx < cities.length - 1 && (
                  <CanvasConnector
                    transport={city.transportOut}
                    canEdit={canEdit}
                    onAddCity={() => handleAddAfter(idx)}
                  />
                )}
              </Reorder.Item>
            ))}
          </Reorder.Group>

          {/* Trailing add button — hidden when Back Home card is showing */}
          {canEdit && cities.length > 0 && !(origin?.city && returnToHome) && (
            <button
              onClick={() => setAddingAfterIndex(cities.length - 1)}
              className="ml-6 w-12 h-12 rounded-full flex items-center justify-center border-2 border-dashed transition-all hover:scale-110 hover:border-[#2563eb] hover:text-[#2563eb] group"
              style={{ borderColor: 'rgba(0,0,0,0.15)' }}
            >
              <span className="text-gray-400 text-[22px] group-hover:text-[#2563eb] transition-colors">+</span>
            </button>
          )}

          {/* Back home card (return) */}
          {origin?.city && returnToHome && cities.length > 0 && (
            <div className="flex items-center ml-2">
              <CanvasConnector
                transport={origin.returnLeg ? {
                  mode: 'flight',
                  price: origin.returnLeg.price ?? 0,
                  duration: origin.returnLeg.durationMinutes
                    ? `${Math.floor(origin.returnLeg.durationMinutes / 60)}h ${origin.returnLeg.durationMinutes % 60}m`
                    : '',
                  operator: origin.returnLeg.operator ?? '',
                } : null}
                canEdit={canEdit}
                onAddCity={() => setAddingAfterIndex(cities.length - 1)}
              />
              <CanvasHomeCard
                origin={origin}
                direction="inbound"
                onEdit={canEdit ? () => setHomeEdit('inbound') : undefined}
                legLoading={homeLegLoading === 'inbound'}
              />
            </div>
          )}
        </div>
      </div>

      {/* ─── Voyza AI chat — docked right, editors only ───
          Same panel as the results page; edits apply to canvas local
          state (unsaved-changes + save flow) instead of the trip store. */}
      {canEdit && canvasTrip && chatOpen && (
        <div className="relative w-[340px] flex-shrink-0 p-3 pl-0 min-h-0">
          <button
            onClick={() => setChatOpen(false)}
            aria-label="Close Voyza AI chat"
            className="absolute top-6 right-6 z-10 p-1 rounded-md text-white/70 hover:text-white hover:bg-white/15 transition-colors"
          >
            <X size={14} />
          </button>
          <AIChatPanel
            trip={canvasTrip}
            onTripUpdate={applyChatTrip}
            getLatestTrip={getLatestCanvasTrip}
          />
        </div>
      )}
      </div>

      {/* Chat pull-out tab — right edge, shown when the chat is closed */}
      <AnimatePresence>
        {canEdit && canvasTrip && !chatOpen && (
          <motion.button
            initial={{ x: 48 }}
            animate={{ x: 0 }}
            exit={{ x: 48 }}
            transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            onClick={() => setChatOpen(true)}
            aria-label="Open Voyza AI chat"
            className="fixed right-0 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-1.5 rounded-l-xl py-3.5 px-1.5 shadow-md hover:shadow-lg transition-shadow"
            style={{
              background: '#2563eb',
              border: '1px solid rgba(0,0,0,0.08)',
              borderRight: 'none',
            }}
          >
            <Sparkles size={13} className="text-white" />
            <span
              className="text-[10px] font-medium text-white tracking-wide"
              style={{ writingMode: 'vertical-rl' }}
            >
              Voyza AI
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* ─── Suggested cities panel ─── */}
      <SuggestedCitiesPanel
        tripId={tripId}
        currentCities={cities.map((c: any) => c.name)}
        role={role}
        onAddCity={handleAddSuggestedCity}
        onSuggestCity={handleSuggestCity}
      />

      {/* ─── Pending suggestions panel ─── */}
      <SuggestionsPanel
        suggestions={suggestions}
        role={role}
        onApprove={handleApprove}
        onReject={handleReject}
      />

      {/* ─── Add city modal ─── */}
      <AddCityModal
        isOpen={addingAfterIndex !== null}
        onClose={() => setAddingAfterIndex(null)}
        onAdd={handleAddCityConfirm}
        currentCities={cities.map((c: any) => c.name)}
      />

      {/* ─── Home / back-home card edit modal ─── */}
      <HomeEditModal
        isOpen={homeEdit !== null}
        direction={homeEdit ?? 'outbound'}
        city={
          homeEdit === 'inbound'
            ? origin?.returnCity ?? origin?.city ?? ''
            : origin?.city ?? ''
        }
        airports={
          homeEdit === 'inbound'
            ? origin?.returnAirports ?? origin?.airports ?? []
            : origin?.airports ?? []
        }
        onClose={() => setHomeEdit(null)}
        onApply={(updates) => homeEdit && applyHomeEdit(homeEdit, updates)}
      />

      {/* ─── Share dialog (link modes + invites + member roles) ─── */}
      <ShareModal
        tripId={tripId}
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        onToast={showToast}
      />

      {/* ─── Share-link sign-in gate: joining requires an account ─── */}
      <LoginModal
        isOpen={!!shareToken && !user && !authLoading}
        onClose={() => {
          // Bailing out of sign-in: drop the pending join and load whatever
          // access (if any) this account-less visitor has.
          setShareToken(null);
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            url.searchParams.delete('share');
            window.history.replaceState({}, '', url.toString());
          }
        }}
      />

      {/* ─── Toast ─── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-full text-[13px] font-medium shadow-lg"
            style={{
              background:
                toast.type === 'success'
                  ? 'rgba(34,192,136,0.95)'
                  : toast.type === 'error'
                    ? 'rgba(220,38,38,0.95)'
                    : 'rgba(37,99,235,0.95)',
              color: '#ffffff',
            }}
          >
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
