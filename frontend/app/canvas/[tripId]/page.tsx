'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { Save, Share2, Users } from 'lucide-react';
import CanvasCityCard from '@/components/canvas/CanvasCityCard';
import SuggestedCitiesPanel from '@/components/canvas/SuggestedCitiesPanel';
import SuggestionsPanel from '@/components/canvas/SuggestionsPanel';
import InviteModal from '@/components/canvas/InviteModal';
import { useCanvasRealtime } from '@/hooks/useCanvasRealtime';
import {
  getCanvasSession,
  saveCanvas,
  getCanvasSuggestions,
  postCanvasSuggestion,
  updateSuggestionStatus,
  Destination,
} from '@/lib/api';
import ProtectedRoute from '@/components/shared/ProtectedRoute';

export default function CanvasPage() {
  return (
    <ProtectedRoute>
      <CanvasPageInner />
    </ProtectedRoute>
  );
}

function CanvasPageInner() {
  const params = useParams();
  const tripId = params.tripId as string;

  const [role, setRole] = useState<string>('viewer');
  const [localState, setLocalState] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [addingAfterIndex, setAddingAfterIndex] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState('');

  const { canvasState, suggestions, isConnected } = useCanvasRealtime(tripId);

  // Load initial session
  useEffect(() => {
    if (!tripId) return;

    (async () => {
      try {
        const { session, role: userRole } = await getCanvasSession(tripId);
        setRole(userRole);
        setLocalState(session.state);

        const { suggestions: initialSuggestions } = await getCanvasSuggestions(tripId);
        void initialSuggestions;
      } catch {
        // handle error
      }
    })();
  }, [tripId]);

  // Sync realtime state (from other users)
  useEffect(() => {
    if (canvasState && role !== 'owner') {
      setLocalState(canvasState);
    }
  }, [canvasState, role]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleSave = async () => {
    if (role !== 'owner' || !localState) return;
    setSaving(true);
    try {
      await saveCanvas(tripId, localState);
      showToast('Changes saved to your trip');
    } catch {
      showToast('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveCity = (index: number) => {
    if (!localState?.cities) return;
    const cities = [...localState.cities];
    cities.splice(index, 1);
    setLocalState({ ...localState, cities });
  };

  const handleAddAfter = (index: number) => {
    setAddingAfterIndex(index);
    setSearchInput('');
  };

  const handleAddCityConfirm = () => {
    if (!searchInput.trim() || addingAfterIndex === null || !localState?.cities) return;
    const cities = [...localState.cities];
    const newCity = {
      name: searchInput.trim(),
      country: '',
      dates: { arrival: '', departure: '' },
      hotel: { name: 'Select hotel', rating: 0, pricePerNight: 0, area: '' },
      hotels: [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      transportIn: { mode: 'flight', operator: '', duration: '', price: 0 },
      transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
    };
    cities.splice(addingAfterIndex + 1, 0, newCity);
    setLocalState({ ...localState, cities });
    setAddingAfterIndex(null);
    setSearchInput('');
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
  };

  const handleSuggestCity = async (dest: Destination) => {
    try {
      await postCanvasSuggestion(tripId, 'add_city', {
        name: dest.name,
        estimatedCost: dest.estimatedCost,
        reason: dest.reason,
      });
      showToast('Suggestion submitted');
    } catch {
      showToast('Failed to submit suggestion');
    }
  };

  const handleApprove = async (suggestionId: string) => {
    try {
      await updateSuggestionStatus(tripId, suggestionId, 'approved');
      showToast('Suggestion approved');
    } catch {
      showToast('Failed to approve');
    }
  };

  const handleReject = async (suggestionId: string) => {
    try {
      await updateSuggestionStatus(tripId, suggestionId, 'rejected');
    } catch {
      showToast('Failed to reject');
    }
  };

  const cities = localState?.cities ?? [];
  const tripTitle = localState?.trip?.title ?? 'Canvas';

  return (
    <div className="h-screen w-screen flex flex-col" style={{ background: '#f0f4f8' }}>
      {/* Top bar — solid blue like navbar */}
      <div
        className="flex-shrink-0 h-14 px-5 flex items-center justify-between"
        style={{ background: '#2563eb' }}
      >
        {/* Left: trip title */}
        <div className="flex items-center gap-3">
          <span className="text-white text-[15px] font-semibold">{tripTitle}</span>
          <div
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]"
            style={{
              background: isConnected ? 'rgba(255,255,255,0.15)' : 'rgba(255,60,60,0.25)',
              color: isConnected ? '#ffffff' : '#ffc9c9',
            }}
          >
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: isConnected ? '#4ade80' : '#ff3c3c' }}
            />
            {isConnected ? 'Live' : 'Connecting...'}
          </div>
        </div>

        {/* Center: collaborator avatars */}
        <div className="flex items-center gap-1">
          {members.slice(0, 5).map((m, i) => (
            <div
              key={m.id ?? i}
              className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-medium text-white border-2"
              style={{
                background: `hsl(${i * 60}, 60%, 55%)`,
                borderColor: m.accepted_at ? '#4ade80' : 'rgba(255,255,255,0.4)',
              }}
              title={m.invited_email}
            >
              {m.invited_email?.[0]?.toUpperCase() ?? '?'}
            </div>
          ))}
        </div>

        {/* Right: Save + Share */}
        <div className="flex items-center gap-2">
          {role === 'owner' && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
              style={{ background: '#22c088' }}
            >
              <Save size={12} />
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          {role === 'owner' && (
            <button
              onClick={() => setShowInvite(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-medium text-white/90 transition-all hover:text-white hover:bg-white/20"
              style={{ background: 'rgba(255,255,255,0.15)' }}
            >
              <Share2 size={12} />
              Share
            </button>
          )}
        </div>
      </div>

      {/* Main canvas area */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden flex items-center px-12">
        <div className="flex items-center min-w-max gap-0">
          {cities.map((city: any, idx: number) => (
            <div key={`${city.name}-${idx}`} className="flex items-center">
              <CanvasCityCard
                city={city}
                index={idx}
                role={role}
                isLast={idx === cities.length - 1}
                onRemove={handleRemoveCity}
                onAddAfter={handleAddAfter}
              />
            </div>
          ))}

          {/* Trailing add button */}
          {(role === 'owner' || role === 'editor') && (
            <button
              onClick={() => setAddingAfterIndex(cities.length - 1)}
              className="ml-4 w-12 h-12 rounded-full flex items-center justify-center border-2 border-dashed transition-all hover:scale-105 hover:border-[#2563eb]"
              style={{ borderColor: 'rgba(0,0,0,0.15)' }}
            >
              <span className="text-gray-400 text-[20px]">+</span>
            </button>
          )}
        </div>

        {/* Inline city search input */}
        {addingAfterIndex !== null && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40 p-4 rounded-2xl shadow-xl"
            style={{
              background: '#ffffff',
              border: '1px solid rgba(0,0,0,0.1)',
            }}
          >
            <div className="text-gray-500 text-[12px] mb-2">Add a city</div>
            <div className="flex gap-2">
              <input
                autoFocus
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddCityConfirm();
                  if (e.key === 'Escape') setAddingAfterIndex(null);
                }}
                placeholder="City name..."
                className="px-3 py-2 rounded-lg text-[13px] text-gray-900 placeholder-gray-400 outline-none w-[200px]"
                style={{ background: '#f0f4f8', border: '1px solid rgba(0,0,0,0.1)' }}
              />
              <button
                onClick={handleAddCityConfirm}
                disabled={!searchInput.trim()}
                className="px-4 py-2 rounded-lg text-[12px] font-medium text-white transition-all disabled:opacity-30"
                style={{ background: '#2563eb' }}
              >
                Add
              </button>
            </div>
          </motion.div>
        )}
      </div>

      {/* Suggested cities panel */}
      <SuggestedCitiesPanel
        tripId={tripId}
        currentCities={cities.map((c: any) => c.name)}
        role={role}
        onAddCity={handleAddSuggestedCity}
        onSuggestCity={handleSuggestCity}
      />

      {/* Pending suggestions panel */}
      <SuggestionsPanel
        suggestions={suggestions}
        role={role}
        onApprove={handleApprove}
        onReject={handleReject}
      />

      {/* Invite modal */}
      <InviteModal
        tripId={tripId}
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        members={members}
      />

      {/* Toast */}
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-full text-[13px] text-white font-medium shadow-lg"
          style={{ background: 'rgba(34,192,136,0.9)' }}
        >
          {toast}
        </motion.div>
      )}
    </div>
  );
}
