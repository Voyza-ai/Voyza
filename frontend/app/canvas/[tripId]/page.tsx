'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { Save, Share2, WifiOff, ArrowLeft } from 'lucide-react';
import CanvasCityCard from '@/components/canvas/CanvasCityCard';
import CanvasConnector from '@/components/canvas/CanvasConnector';
import CanvasHomeCard from '@/components/canvas/CanvasHomeCard';
import SuggestedCitiesPanel from '@/components/canvas/SuggestedCitiesPanel';
import SuggestionsPanel from '@/components/canvas/SuggestionsPanel';
import InviteModal from '@/components/canvas/InviteModal';
import AddCityModal from '@/components/canvas/AddCityModal';
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
  Destination,
} from '@/lib/api';

export default function CanvasPage() {
  const params = useParams();
  const router = useRouter();
  const tripId = params.tripId as string;
  const user = useAuthStore((s) => s.user);
  const storeTrip = useTripStore((s) => s.currentTrip);
  const storeCities = storeTrip?.cities;

  const [role, setRole] = useState<string>('viewer');
  const [localState, setLocalState] = useState<any>(null);
  const [savedState, setSavedState] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [addingAfterIndex, setAddingAfterIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const { canvasState, suggestions, isConnected } = useCanvasRealtime(tripId);

  // Unsaved changes detection
  const hasUnsavedChanges = useMemo(() => {
    if (!localState || !savedState) return false;
    return JSON.stringify(localState.cities) !== JSON.stringify(savedState.cities);
  }, [localState, savedState]);

  // Load initial session
  useEffect(() => {
    if (!tripId) return;

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

        setLocalState(sessionState);
        setSavedState(sessionState);

        // Load members from session
        if (session.state?.members) {
          setMembers(session.state.members);
        }

        await getCanvasSuggestions(tripId);
      } catch {
        showToast('Failed to load canvas session', 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [tripId]);

  // Sync realtime state (from other users)
  useEffect(() => {
    if (canvasState && role !== 'owner') {
      setLocalState(canvasState);
      setSavedState(canvasState);
    }
  }, [canvasState, role]);

  // Show toast when owner saves (realtime update)
  useEffect(() => {
    if (canvasState && role !== 'owner') {
      showToast('Owner saved — trip updated', 'info');
    }
  }, [canvasState]);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleSave = async () => {
    if (role !== 'owner' || !localState) return;
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
    // Find the earliest arrival as the chain start
    let startDate = '';
    for (const c of cities) {
      if (c.dates?.arrival && c.dates.arrival.includes('-')) {
        startDate = c.dates.arrival;
        break;
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
    setLocalState({ ...localState, cities: recalcDates(cities) });
    setAddingAfterIndex(null);
  };

  const handleAddSuggestedCity = (dest: Destination) => {
    if (!localState?.cities) return;
    const cities = [...localState.cities];
    cities.push({
      name: dest.name,
      country: '',
      dates: { arrival: '', departure: '' },
      hotel: { name: 'Select hotel', rating: 0, pricePerNight: 0, area: '' },
      hotels: [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      transportIn: { mode: 'flight', operator: '', duration: '', price: 0 },
      transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
    });
    setLocalState({ ...localState, cities });
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

  const handleUpdateOrigin = (updates: { city?: string; airports?: string[] }) => {
    if (!localState?.trip) return;
    const currentOrigin = localState.trip.origin ?? { city: '', airports: [] };
    const newOrigin = { ...currentOrigin, ...updates };
    setLocalState({
      ...localState,
      trip: { ...localState.trip, origin: newOrigin },
    });
  };

  const cities = localState?.cities ?? [];
  const tripTitle = localState?.trip?.title ?? 'Canvas';
  const origin = localState?.trip?.origin ?? null;
  const returnToHome = localState?.trip?.returnToHome ?? false;
  const canEdit = role === 'owner' || role === 'editor';

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
            onClick={() => router.push(`/results?tripId=${tripId}`)}
            className="flex items-center gap-1.5 text-gray-500 hover:text-gray-800 transition-colors text-[13px]"
          >
            <ArrowLeft size={14} />
            <span className="hidden sm:inline">Back</span>
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <span
            className="text-[16px] font-bold tracking-tight"
            style={{ color: '#2563eb' }}
          >
            VOYZA
          </span>
          <div className="w-px h-5 bg-gray-200" />
          <span className="text-gray-800 text-[14px] font-medium">{tripTitle}</span>
          {hasUnsavedChanges && (
            <span className="text-[11px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
              Unsaved changes
            </span>
          )}
        </div>

        {/* Center: collaborator avatar rings */}
        <div className="flex items-center gap-1.5">
          {/* Current user */}
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium text-white border-2 border-[#4ade80]"
            style={{ background: '#2563eb' }}
            title="You"
          >
            {userInitials}
          </div>
          {/* Other members */}
          {members.slice(0, 5).map((m, i) => (
            <div
              key={m.id ?? i}
              className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium text-white border-2"
              style={{
                background: `hsl(${(i + 1) * 60}, 55%, 50%)`,
                borderColor: m.accepted_at ? '#4ade80' : 'rgba(0,0,0,0.12)',
              }}
              title={m.invited_email}
            >
              {m.invited_email?.[0]?.toUpperCase() ?? '?'}
            </div>
          ))}
          {members.length > 5 && (
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium text-gray-500 bg-gray-100 border-2 border-gray-200">
              +{members.length - 5}
            </div>
          )}
        </div>

        {/* Right: connection status + Invite + Save */}
        <div className="flex items-center gap-2.5">
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
              Invite
            </button>
          )}

          {role === 'owner' && (
            <button
              onClick={handleSave}
              disabled={saving || !hasUnsavedChanges}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
              style={{ background: '#2563eb' }}
            >
              <Save size={12} />
              {saving ? 'Saving...' : 'Save'}
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

      {/* ─── Main canvas area ─── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden flex items-center px-12">
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
              <CanvasHomeCard origin={origin} direction="outbound" onUpdateOrigin={canEdit ? handleUpdateOrigin : undefined} />
              <CanvasConnector
                transport={origin.outboundLeg ? {
                  mode: 'flight',
                  price: origin.outboundLeg.price ?? 0,
                  duration: origin.outboundLeg.durationMinutes
                    ? `${Math.floor(origin.outboundLeg.durationMinutes / 60)}h ${origin.outboundLeg.durationMinutes % 60}m`
                    : '',
                  operator: origin.outboundLeg.operator ?? '',
                } : null}
                canEdit={false}
                onAddCity={() => {}}
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
                canEdit={false}
                onAddCity={() => {}}
              />
              <CanvasHomeCard origin={origin} direction="inbound" onUpdateOrigin={canEdit ? handleUpdateOrigin : undefined} />
            </div>
          )}
        </div>
      </div>

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

      {/* ─── Invite modal ─── */}
      <InviteModal
        tripId={tripId}
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        members={members}
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
