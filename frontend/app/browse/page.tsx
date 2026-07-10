'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  MapPin,
  Moon,
  Users,
  Hotel,
  Plane,
  TrainFront,
  Utensils,
  Save,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react';
import Navbar from '@/components/shared/Navbar';
import LoginModal from '@/components/shared/LoginModal';
import { useAuthStore } from '@/store/authStore';
import { getCityColor } from '@/lib/cityColors';
import { searchPresets } from '@/lib/marketplaceSearch';
import {
  PRESET_ITINERARIES,
  PresetItinerary,
  presetNights,
  presetCost,
  buildPresetTrip,
} from '@/data/presetItineraries';
import {
  stashCanvasIntent,
  clearCanvasIntent,
  resolveCanvasTripId,
  type CanvasIntent,
} from '@/lib/canvasHandoff';

export default function BrowsePage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [selected, setSelected] = useState<PresetItinerary | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  // Instant natural-language filter — re-scores on every keystroke, no
  // network round-trip. Empty query shows the whole marketplace.
  const results = useMemo(() => searchPresets(query, PRESET_ITINERARIES), [query]);
  const isFiltering = query.trim().length > 0;

  // A preset is an unsaved trip — reuse the same intent machinery the
  // results page uses, so login (password AND Google OAuth) resumes
  // straight into the save.
  const buildIntent = (preset: PresetItinerary): CanvasIntent => {
    const trip = buildPresetTrip(preset);
    return {
      savedId: null,
      payload: trip,
      origin: trip.origin
        ? { origin: trip.origin, returnToHome: trip.returnToHome ?? true }
        : null,
      syncCities: trip.cities,
      destination: 'results',
    };
  };

  // Save the preset to the user's trips (same saveTrip flow as a planned
  // trip, so it lands in their history), then open the results page for it
  // where they can edit freely.
  const saveAndOpen = async (preset: PresetItinerary) => {
    if (!user) {
      stashCanvasIntent(buildIntent(preset));
      setShowLogin(true);
      return;
    }
    setSaving(true);
    try {
      const tripId = await resolveCanvasTripId(buildIntent(preset));
      if (tripId) router.push(`/results?tripId=${tripId}`);
    } catch {
      // save failed — stay on browse
    } finally {
      setSaving(false);
    }
  };

  // Email/password sign-in completes in-place; resume the pending preset.
  const handleLoginSuccess = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const tripId = await resolveCanvasTripId(buildIntent(selected));
      clearCanvasIntent();
      if (tripId) router.push(`/results?tripId=${tripId}`);
    } catch {
      // save failed — stay on browse
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
      <Navbar />

      <div className="pt-20 px-6 pb-12 max-w-5xl mx-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-[26px] font-bold text-gray-900">Browse itineraries</h1>
          <p className="text-sm text-gray-500 mt-1">
            Hand-crafted trips you can make your own — open one in the canvas and start editing.
          </p>
        </div>

        {/* Search */}
        <div className="max-w-xl mx-auto mb-8">
          <div
            className="flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-white border shadow-sm focus-within:border-[#2563eb] transition-colors"
            style={{ borderColor: 'rgba(0,0,0,0.08)' }}
          >
            <Search size={16} className="text-gray-400 flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Describe your trip — "Italy with lots of architecture", "beach and food"…'
              className="flex-1 bg-transparent text-[13px] text-gray-900 placeholder-gray-400 outline-none"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="text-gray-300 hover:text-gray-500 transition-colors flex-shrink-0"
              >
                <X size={14} />
              </button>
            )}
          </div>
          {isFiltering && results.length > 0 && (
            <div className="text-[11px] text-gray-400 text-center mt-2">
              {results.length} of {PRESET_ITINERARIES.length} itineraries match — best match first
            </div>
          )}
        </div>

        {/* No matches — hand off to the AI planner */}
        {isFiltering && results.length === 0 && (
          <div className="flex flex-col items-center py-14 text-center">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
              style={{ background: 'rgba(37,99,235,0.08)' }}
            >
              <Sparkles size={24} style={{ color: '#2563eb' }} />
            </div>
            <h2 className="text-[15px] font-medium text-gray-900 mb-1">
              No ready-made trip matches that
            </h2>
            <p className="text-[13px] text-gray-500 mb-5 max-w-sm">
              Our AI planner can build exactly what you described from scratch instead.
            </p>
            <button
              onClick={() => router.push('/plan')}
              className="px-5 py-2.5 rounded-xl text-[13px] font-medium text-white transition-all hover:brightness-110"
              style={{ background: '#2563eb' }}
            >
              Describe it to the AI planner
            </button>
          </div>
        )}

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {results.map(({ preset }, idx) => (
            <motion.button
              key={preset.slug}
              onClick={() => setSelected(preset)}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: idx * 0.07, ease: 'easeOut' }}
              whileHover={{ y: -4 }}
              className="text-left bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm hover:shadow-md transition-shadow group"
            >
              {/* Gradient banner */}
              <div
                className="h-28 px-5 flex flex-col justify-end pb-3 relative"
                style={{ background: preset.coverGradient }}
              >
                <span
                  className="absolute top-3 right-3 text-[10px] font-medium px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(255,255,255,0.25)', color: 'white' }}
                >
                  {preset.scope.toUpperCase()}
                </span>
                <div className="text-white text-[19px] font-bold leading-tight drop-shadow-sm">
                  {preset.title}
                </div>
                <div className="text-white/85 text-[12px] mt-0.5">{preset.flags}</div>
              </div>

              {/* Body */}
              <div className="p-5">
                <p className="text-[13px] text-gray-600 leading-relaxed mb-3">
                  {preset.tagline}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <MapPin size={12} />
                    {preset.cities.map((c) => c.name).join(' → ')}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                  <div className="flex gap-4 text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <Moon size={12} />
                      {presetNights(preset)} nights
                    </span>
                    <span className="flex items-center gap-1">
                      <Users size={12} />
                      {preset.travelers}
                    </span>
                  </div>
                  <span className="text-[13px] font-semibold" style={{ color: '#2563eb' }}>
                    ~${presetCost(preset).toLocaleString()}
                  </span>
                </div>
              </div>
            </motion.button>
          ))}
        </div>
      </div>

      {/* ─── Itinerary detail modal ─── */}
      <AnimatePresence>
        {selected && (
          <>
            <motion.div
              className="fixed inset-0 z-40"
              style={{ background: 'rgba(0,0,0,0.35)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelected(null)}
            />
            <motion.div
              className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
              initial={{ opacity: 0, scale: 0.97, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 12 }}
              transition={{ duration: 0.2 }}
            >
              <div className="pointer-events-auto w-full max-w-2xl max-h-[85vh] bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden flex flex-col">
                {/* Banner */}
                <div
                  className="px-6 pt-5 pb-4 relative flex-shrink-0"
                  style={{ background: selected.coverGradient }}
                >
                  <button
                    onClick={() => setSelected(null)}
                    className="absolute top-3 right-3 w-7 h-7 rounded-full flex items-center justify-center text-white transition-colors"
                    style={{ background: 'rgba(0,0,0,0.2)' }}
                  >
                    <X size={14} />
                  </button>
                  <div className="text-white/85 text-[11px] uppercase tracking-wider font-medium">
                    {selected.scope} · {selected.flags}
                  </div>
                  <h2 className="text-white text-[22px] font-bold leading-tight mt-0.5">
                    {selected.title}
                  </h2>
                  <div className="flex gap-4 mt-2 text-white/90 text-[12px]">
                    <span className="flex items-center gap-1">
                      <MapPin size={12} /> {selected.cities.length} cities
                    </span>
                    <span className="flex items-center gap-1">
                      <Moon size={12} /> {presetNights(selected)} nights
                    </span>
                    <span className="flex items-center gap-1">
                      <Users size={12} /> {selected.travelers} travelers
                    </span>
                    <span className="font-semibold">~${presetCost(selected).toLocaleString()}</span>
                  </div>
                </div>

                {/* Scrollable itinerary */}
                <div className="flex-1 overflow-y-auto px-6 py-5">
                  <p className="text-[13px] text-gray-600 leading-relaxed mb-5">
                    {selected.description}
                  </p>

                  <div className="flex flex-col gap-4">
                    {selected.cities.map((city, i) => {
                      const color = getCityColor(i);
                      const TransportIcon = city.transportOut?.mode === 'train' ? TrainFront : Plane;
                      return (
                        <div key={city.name}>
                          <div
                            className="rounded-xl border p-4"
                            style={{ background: color.bg, borderColor: color.border }}
                          >
                            <div className="flex items-baseline justify-between">
                              <div className="text-[15px] font-semibold" style={{ color: color.text }}>
                                {String(i + 1).padStart(2, '0')} · {city.name}
                                <span className="font-normal text-[12px] opacity-70"> — {city.country}</span>
                              </div>
                              <span className="text-[11px]" style={{ color: `${color.text}aa` }}>
                                {city.nights} {city.nights === 1 ? 'night' : 'nights'}
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5 mt-2 text-[12px]" style={{ color: `${color.text}cc` }}>
                              <Hotel size={11} />
                              {city.hotel.name}
                              <span style={{ color: `${color.text}88` }}>
                                · ★ {city.hotel.rating} · ${city.hotel.pricePerNight}/n
                              </span>
                            </div>

                            <ul className="mt-2 flex flex-col gap-0.5">
                              {city.activities.slice(0, 4).map((a) => (
                                <li key={a} className="text-[12px] flex gap-1.5" style={{ color: `${color.text}cc` }}>
                                  <span style={{ color: `${color.text}66` }}>•</span> {a}
                                </li>
                              ))}
                            </ul>

                            {city.restaurants.length > 0 && (
                              <div className="flex items-center gap-1.5 mt-2 text-[11px]" style={{ color: `${color.text}99` }}>
                                <Utensils size={10} />
                                {city.restaurants.map((r) => r.name).join(' · ')}
                              </div>
                            )}
                          </div>

                          {/* Transport to next city */}
                          {city.transportOut && i < selected.cities.length - 1 && (
                            <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-gray-500">
                              <TransportIcon size={12} style={{ color: '#2563eb' }} />
                              {city.transportOut.operator} · {city.transportOut.duration} · $
                              {city.transportOut.price}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Footer */}
                <div className="flex-shrink-0 px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
                  <span className="text-[11px] text-gray-400">
                    Saves to your trips — edit it however you like after
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelected(null)}
                      className="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                    >
                      Close
                    </button>
                    <button
                      onClick={() => saveAndOpen(selected)}
                      disabled={saving}
                      className="flex items-center gap-2 px-5 py-2 rounded-lg text-[13px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                      style={{ background: '#2563eb' }}
                    >
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                      {saving ? 'Finding flights…' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <LoginModal
        isOpen={showLogin}
        onClose={() => setShowLogin(false)}
        onSuccess={handleLoginSuccess}
      />
    </main>
  );
}
