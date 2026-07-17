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
  SlidersHorizontal,
  Minus,
  Plus,
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
  presetCostFor,
  buildPresetTrip,
  presetVibes,
} from '@/data/presetItineraries';
import type { Vibe } from '@/lib/types';
import {
  stashCanvasIntent,
  clearCanvasIntent,
  resolveCanvasTripId,
  type CanvasIntent,
} from '@/lib/canvasHandoff';

const VIBES: Array<{ key: Vibe; label: string }> = [
  { key: 'beach', label: 'Beach' },
  { key: 'food', label: 'Food' },
  { key: 'history', label: 'History' },
  { key: 'art', label: 'Art' },
  { key: 'nature', label: 'Nature' },
  { key: 'city', label: 'City' },
  { key: 'nightlife', label: 'Nightlife' },
  { key: 'romance', label: 'Romance' },
];

// Slider bounds derived from the catalog, so they stay honest as presets
// are added. Sliders sit at their max by default, which means "any".
const NIGHTS_MIN = Math.min(...PRESET_ITINERARIES.map(presetNights));
const NIGHTS_MAX = Math.max(...PRESET_ITINERARIES.map(presetNights));
const COST_MIN = Math.floor(Math.min(...PRESET_ITINERARIES.map(presetCost)) / 100) * 100;
const COST_MAX = Math.ceil(Math.max(...PRESET_ITINERARIES.map(presetCost)) / 100) * 100;

export default function BrowsePage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [selected, setSelected] = useState<PresetItinerary | null>(null);
  // Party size for the trip being saved — asked in the detail modal; the
  // built trip (costs, flight search, travelers) uses this value.
  const [travelers, setTravelers] = useState(2);
  const [showLogin, setShowLogin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  // Deferred filters: the sidebar controls edit a DRAFT; nothing filters
  // until the user clicks "Apply filters", which commits draft → applied.
  // Sliders filter by "at most" — full-right means no limit.
  type Filters = { maxNights: number; maxBudget: number; vibe: Vibe | '' };
  const NO_FILTERS: Filters = { maxNights: NIGHTS_MAX, maxBudget: COST_MAX, vibe: '' };
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);

  // Instant natural-language search — re-scores on every keystroke, no
  // network round-trip. Empty query shows the whole marketplace. The
  // applied sidebar filters then narrow whatever the search produced.
  const searchResults = useMemo(() => searchPresets(query, PRESET_ITINERARIES), [query]);
  const isFiltering = query.trim().length > 0;

  const results = useMemo(
    () =>
      searchResults.filter(
        (r) =>
          presetNights(r.preset) <= applied.maxNights &&
          presetCost(r.preset) <= applied.maxBudget &&
          (applied.vibe === '' || presetVibes(r.preset).includes(applied.vibe)),
      ),
    [searchResults, applied],
  );

  const filtersDirty =
    draft.maxNights !== applied.maxNights ||
    draft.maxBudget !== applied.maxBudget ||
    draft.vibe !== applied.vibe;
  const anyFilterActive =
    applied.maxNights < NIGHTS_MAX || applied.maxBudget < COST_MAX || applied.vibe !== '';

  const applyFilters = () => setApplied(draft);
  const clearFilters = () => {
    setDraft(NO_FILTERS);
    setApplied(NO_FILTERS);
  };

  // A preset is an unsaved trip — reuse the same intent machinery the
  // results page uses, so login (password AND Google OAuth) resumes
  // straight into the save.
  const buildIntent = (preset: PresetItinerary): CanvasIntent => {
    const trip = buildPresetTrip(preset, travelers);
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

      {/* Full-bleed layout — no max-width, so the filter sidebar sits right
          at the viewport edge and the grid gets the leftover width. */}
      <div className="pt-20 px-5 pb-12 w-full">
        {/* Header */}
        <div className="text-center mb-5">
          <h1 className="text-[26px] font-bold text-gray-900">Browse itineraries</h1>
          <p className="text-sm text-gray-500 mt-1">
            Hand-crafted trips you can make your own — open one in the canvas and start editing.
          </p>
        </div>

        {/* Search — centered on the page, above the sidebar/grid row */}
        <div className="max-w-xl mx-auto mb-6">
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
          {(isFiltering || anyFilterActive) && results.length > 0 && (
            <div className="text-[11px] text-gray-400 text-center mt-2.5">
              {results.length} of {PRESET_ITINERARIES.length} itineraries
              {isFiltering ? ' match — best match first' : ''}
            </div>
          )}
        </div>

        {/* Sidebar + results. A hidden right spacer mirrors the sidebar's
            width, so the card grid sits perfectly centered on the page —
            on the same axis as the search bar above. */}
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* ─── Filter sidebar ─── */}
          <aside className="w-full lg:w-60 flex-shrink-0 lg:sticky lg:top-20 bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-gray-800 text-[13px] font-semibold">
                <SlidersHorizontal size={14} style={{ color: '#2563eb' }} />
                Filters
              </div>
              {(anyFilterActive || filtersDirty) && (
                <button
                  onClick={clearFilters}
                  className="text-[11px] text-gray-400 underline hover:text-gray-600 transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>

            {/* Trip length slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label
                  htmlFor="filter-nights"
                  className="text-[10px] uppercase tracking-wider text-gray-400"
                >
                  Trip length
                </label>
                <span className="text-[11px] font-medium text-gray-700">
                  {draft.maxNights >= NIGHTS_MAX ? 'Any' : `≤ ${draft.maxNights} nights`}
                </span>
              </div>
              <input
                id="filter-nights"
                type="range"
                aria-label="Trip length"
                min={NIGHTS_MIN}
                max={NIGHTS_MAX}
                step={1}
                value={draft.maxNights}
                onChange={(e) => setDraft((d) => ({ ...d, maxNights: Number(e.target.value) }))}
                className="w-full cursor-pointer accent-[#2563eb]"
              />
              <div className="flex justify-between text-[9px] text-gray-400 mt-1">
                <span>{NIGHTS_MIN} nights</span>
                <span>Any</span>
              </div>
            </div>

            {/* Budget slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label
                  htmlFor="filter-budget"
                  className="text-[10px] uppercase tracking-wider text-gray-400"
                >
                  Budget
                </label>
                <span className="text-[11px] font-medium text-gray-700">
                  {draft.maxBudget >= COST_MAX ? 'Any' : `≤ $${draft.maxBudget.toLocaleString()}`}
                </span>
              </div>
              <input
                id="filter-budget"
                type="range"
                aria-label="Budget"
                min={COST_MIN}
                max={COST_MAX}
                step={100}
                value={draft.maxBudget}
                onChange={(e) => setDraft((d) => ({ ...d, maxBudget: Number(e.target.value) }))}
                className="w-full cursor-pointer accent-[#2563eb]"
              />
              <div className="flex justify-between text-[9px] text-gray-400 mt-1">
                <span>${COST_MIN.toLocaleString()}</span>
                <span>Any</span>
              </div>
            </div>

            {/* Vibe dropdown */}
            <div>
              <label
                htmlFor="filter-vibe"
                className="block text-[10px] uppercase tracking-wider text-gray-400 mb-2"
              >
                Vibe
              </label>
              <select
                id="filter-vibe"
                aria-label="Vibe"
                value={draft.vibe}
                onChange={(e) => setDraft((d) => ({ ...d, vibe: e.target.value as Vibe | '' }))}
                className="w-full px-3 py-2 rounded-xl text-[12px] text-gray-800 outline-none cursor-pointer border transition-colors focus:border-[#2563eb]"
                style={{ background: '#f0f4f8', borderColor: 'rgba(0,0,0,0.08)' }}
              >
                <option value="">Any vibe</option>
                {VIBES.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Apply — filters only take effect when clicked */}
            <button
              onClick={applyFilters}
              disabled={!filtersDirty}
              className="w-full py-2.5 rounded-xl text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
              style={{ background: '#2563eb' }}
            >
              Apply filters
            </button>

            <div className="text-[10px] text-gray-400 border-t border-gray-100 pt-3">
              {results.length} of {PRESET_ITINERARIES.length} itineraries shown
              {filtersDirty && (
                <span className="block mt-1 text-amber-600">
                  Unapplied changes — click Apply
                </span>
              )}
            </div>
          </aside>

          {/* ─── Main column: results fill all remaining width ─── */}
          <div className="flex-1 min-w-0">
            {/* Search found trips, but the sidebar filters excluded them all */}
            {searchResults.length > 0 && results.length === 0 && (
              <div className="flex flex-col items-center py-14 text-center">
                <h2 className="text-[15px] font-medium text-gray-900 mb-1">
                  No trips match these filters
                </h2>
                <p className="text-[13px] text-gray-500 mb-5 max-w-sm">
                  {isFiltering
                    ? 'There are matching trips outside your current filters.'
                    : 'Try raising the length or budget sliders, or switching the vibe.'}
                </p>
                <button
                  onClick={clearFilters}
                  className="px-5 py-2.5 rounded-xl text-[13px] font-medium text-white transition-all hover:brightness-110"
                  style={{ background: '#2563eb' }}
                >
                  Clear filters
                </button>
              </div>
            )}

            {/* No matches at all — hand off to the AI planner */}
            {isFiltering && searchResults.length === 0 && (
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

            {/* Cards — compact squares, 3-up on desktop */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {results.map(({ preset }, idx) => (
                <motion.button
                  key={preset.slug}
                  onClick={() => {
                    setSelected(preset);
                    setTravelers(preset.travelers);
                  }}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: idx * 0.05, ease: 'easeOut' }}
                  whileHover={{ y: -3 }}
                  className="text-left bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col min-h-[420px]"
                >
                  {/* Gradient banner */}
                  <div
                    className="h-44 flex-shrink-0 px-4 flex flex-col justify-end pb-2.5 relative"
                    style={{ background: preset.coverGradient }}
                  >
                    <span
                      className="absolute top-2 right-2 text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                      style={{ background: 'rgba(255,255,255,0.25)', color: 'white' }}
                    >
                      {preset.scope.toUpperCase()}
                    </span>
                    <div className="text-white text-[15px] font-bold leading-tight drop-shadow-sm line-clamp-2">
                      {preset.title}
                    </div>
                    <div className="text-white/85 text-[10px] mt-0.5">{preset.flags}</div>
                  </div>

                  {/* Body */}
                  <div className="p-4 flex-1 flex flex-col min-h-0">
                    <p className="text-[12px] text-gray-600 leading-snug mb-2">
                      {preset.tagline}
                    </p>
                    <div className="flex items-center gap-1 text-[11px] text-gray-500 min-w-0 mb-2.5">
                      <MapPin size={11} className="flex-shrink-0" />
                      <span className="truncate">
                        {preset.cities.map((c) => c.name).join(' → ')}
                      </span>
                    </div>

                    {/* Vibe chips */}
                    <div className="flex flex-wrap gap-1 mb-3">
                      {presetVibes(preset).slice(0, 4).map((v) => (
                        <span
                          key={v}
                          className="px-2 py-0.5 rounded-full text-[9px] font-medium uppercase tracking-wider"
                          style={{ background: 'rgba(37,99,235,0.07)', color: '#2563eb' }}
                        >
                          {v}
                        </span>
                      ))}
                    </div>

                    {/* Highlights — the best moment from each city */}
                    <div>
                      <div className="text-[9px] uppercase tracking-wider text-gray-400 mb-1.5">
                        Highlights
                      </div>
                      <ul className="flex flex-col gap-1.5">
                        {preset.cities.slice(0, 4).map(
                          (c) =>
                            c.activities[0] && (
                              <li
                                key={c.name}
                                className="flex items-start gap-1.5 text-[11px] text-gray-600 leading-snug"
                              >
                                <Sparkles
                                  size={10}
                                  className="flex-shrink-0 mt-0.5"
                                  style={{ color: '#2563eb' }}
                                />
                                <span>{c.activities[0]}</span>
                              </li>
                            ),
                        )}
                      </ul>
                    </div>

                    <div className="flex items-center justify-between mt-auto pt-3 border-t border-gray-100">
                      <div className="flex gap-2.5 text-[10px] text-gray-500">
                        <span className="flex items-center gap-0.5">
                          <Moon size={10} />
                          {presetNights(preset)}n
                        </span>
                        <span className="flex items-center gap-0.5">
                          <Users size={10} />
                          {preset.travelers}
                        </span>
                      </div>
                      <span className="text-[12px] font-semibold" style={{ color: '#2563eb' }}>
                        ~${presetCost(preset).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>
          </div>
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
                      <Users size={12} /> {travelers} {travelers === 1 ? 'traveler' : 'travelers'}
                    </span>
                    <span className="font-semibold">~${presetCostFor(selected, travelers).toLocaleString()}</span>
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
                  {/* Ask party size before saving — the built itinerary uses it */}
                  <div className="flex items-center gap-3">
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 rounded-xl"
                      style={{ background: '#f0f4f8', border: '1px solid rgba(0,0,0,0.08)' }}
                    >
                      <Users size={13} className="text-gray-400" />
                      <span className="text-[12px] text-gray-600">Travelers</span>
                      <button
                        aria-label="Fewer travelers"
                        onClick={() => setTravelers((t) => Math.max(1, t - 1))}
                        className="w-6 h-6 rounded-lg flex items-center justify-center text-gray-500 hover:bg-white hover:text-gray-800 transition-colors"
                      >
                        <Minus size={12} />
                      </button>
                      <span className="text-[13px] font-semibold text-gray-900 w-5 text-center tabular-nums">
                        {travelers}
                      </span>
                      <button
                        aria-label="More travelers"
                        onClick={() => setTravelers((t) => Math.min(12, t + 1))}
                        className="w-6 h-6 rounded-lg flex items-center justify-center text-gray-500 hover:bg-white hover:text-gray-800 transition-colors"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                    <span className="text-[11px] text-gray-400 hidden sm:inline">
                      Saves to your trips
                    </span>
                  </div>
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
