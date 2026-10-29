'use client';

import { useState, useMemo, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
  Star,
  Flame,
  ArrowRight,
} from 'lucide-react';
import Link from 'next/link';
import Navbar from '@/components/shared/Navbar';
import PopularTravelerTrips from '@/components/browse/PopularTravelerTrips';
import MiniRoute from '@/components/browse/MiniRoute';
import { getPresetCatalog, sendPresetEvents, type PresetCatalog } from '@/lib/api';
import LoginModal from '@/components/shared/LoginModal';
import { useAuthStore } from '@/store/authStore';
import { useTripStore } from '@/store/tripStore';
import { getCityColor } from '@/lib/cityColors';
import { searchPresets } from '@/lib/marketplaceSearch';
import {
  PRESET_ITINERARIES,
  PresetItinerary,
  presetNights,
  presetCost,
  presetCostFor,
  presetPricePerPersonRange,
  buildPresetTrip,
  presetVibes,
} from '@/data/presetItineraries';
import {
  stashCanvasIntent,
  clearCanvasIntent,
  resolveCanvasTripId,
  type CanvasIntent,
} from '@/lib/canvasHandoff';
import { detectNearestAirportCity } from '@/lib/nearestAirport';
import { originAirportsForCity } from '@/lib/locationResolver';
import { getUseLocationPref, setUseLocationPref } from '@/lib/locationPref';

// Slider bounds derived from the LIVE catalog, so they stay honest as
// presets are added. Sliders sit at their max by default = "any".
const catalogBounds = (presets: PresetItinerary[]) => ({
  nightsMin: Math.min(...presets.map(presetNights)),
  nightsMax: Math.max(...presets.map(presetNights)),
  costMin: Math.floor(Math.min(...presets.map(presetCost)) / 100) * 100,
  costMax: Math.ceil(Math.max(...presets.map(presetCost)) / 100) * 100,
});

const bannerBackground = (preset: PresetItinerary) =>
  preset.coverImage
    ? `linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.55) 100%), url(${preset.coverImage}) center/cover no-repeat, ${preset.coverGradient}`
    : preset.coverGradient;

// Next 14: useSearchParams (the ?preset= deep link) needs a Suspense
// boundary for static rendering.
export default function BrowsePage() {
  return (
    <Suspense fallback={null}>
      <BrowsePageInner />
    </Suspense>
  );
}

function BrowsePageInner() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [selected, setSelected] = useState<PresetItinerary | null>(null);
  // Party size for the trip being saved — asked in the detail modal; the
  // built trip (costs, flight search, travelers) uses this value.
  const [travelers, setTravelers] = useState(2);
  const [showLogin, setShowLogin] = useState(false);
  const [saving, setSaving] = useState(false);
  // Origin detected from the browser's location prompt at save time.
  // Kept in state so the post-login resume saves with the same origin.
  const [detectedOrigin, setDetectedOrigin] = useState<
    { city: string; airports: string[] } | undefined
  >(undefined);
  const [locating, setLocating] = useState(false);
  // App-side location switch — the browser permission can't be revoked by
  // the site, so this is how a user who picked "always allow" opts back out.
  // Initialized in an effect (not the useState initializer) so server and
  // client render the same default and hydration stays clean.
  const [useLocation, setUseLocation] = useState(true);
  useEffect(() => setUseLocation(getUseLocationPref()), []);
  const toggleUseLocation = () => {
    const next = !useLocation;
    setUseLocation(next);
    setUseLocationPref(next);
    // Forget any previously detected origin so a post-login save after
    // toggling off falls back to the JFK default.
    if (!next) setDetectedOrigin(undefined);
  };
  const [query, setQuery] = useState('');

  // Live catalog from the API (curated + AI-generated, with engagement,
  // editorial rows, and category rows). Starts as the bundled presets so
  // the page renders instantly and still works if the API is down.
  const [catalogData, setCatalogData] = useState<PresetCatalog | null>(null);
  useEffect(() => {
    let disposed = false;
    getPresetCatalog()
      .then((c) => {
        if (!disposed && c.presets.length > 0) setCatalogData(c);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  const catalog = useMemo<PresetItinerary[]>(
    () => (catalogData ? catalogData.presets.map((p) => p.data) : PRESET_ITINERARIES),
    [catalogData],
  );
  const bounds = useMemo(() => catalogBounds(catalog), [catalog]);
  const NIGHTS_MIN = bounds.nightsMin;
  const NIGHTS_MAX = bounds.nightsMax;
  const COST_MIN = bounds.costMin;
  const COST_MAX = bounds.costMax;

  // Deep link from an SEO landing page: /browse?preset=<slug> opens it.
  const searchParams = useSearchParams();
  useEffect(() => {
    const slug = searchParams?.get('preset');
    if (!slug) return;
    const p = catalog.find((x) => x.slug === slug);
    if (p) {
      setSelected(p);
      setTravelers(p.travelers);
    }
  }, [searchParams, catalog]);

  // Deferred filters: the sidebar controls edit a DRAFT; nothing filters
  // until the user clicks "Apply filters", which commits draft → applied.
  // Sliders filter by "at most" — full-right means no limit.
  type Filters = { maxNights: number; maxBudget: number };
  const NO_FILTERS: Filters = { maxNights: NIGHTS_MAX, maxBudget: COST_MAX };
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  // When the live catalog widens the bounds, a slider still sitting at the
  // OLD max ("any") must move to the new max — otherwise newly loaded
  // longer/pricier trips would be silently filtered out.
  const prevBoundsRef = useRef(bounds);
  useEffect(() => {
    const prev = prevBoundsRef.current;
    if (prev === bounds) return;
    const widen = (f: Filters): Filters => ({
      ...f,
      maxNights: f.maxNights >= prev.nightsMax ? bounds.nightsMax : f.maxNights,
      maxBudget: f.maxBudget >= prev.costMax ? bounds.costMax : f.maxBudget,
    });
    setDraft(widen);
    setApplied(widen);
    prevBoundsRef.current = bounds;
  }, [bounds]);

  // Instant natural-language search — re-scores on every keystroke, no
  // network round-trip. Empty query shows the whole marketplace. The
  // applied sidebar filters then narrow whatever the search produced.
  const searchResults = useMemo(() => searchPresets(query, catalog), [query, catalog]);
  const isFiltering = query.trim().length > 0;

  const results = useMemo(
    () =>
      searchResults.filter(
        (r) =>
          presetNights(r.preset) <= applied.maxNights &&
          presetCost(r.preset) <= applied.maxBudget,
      ),
    [searchResults, applied],
  );

  const filtersDirty =
    draft.maxNights !== applied.maxNights ||
    draft.maxBudget !== applied.maxBudget;
  const anyFilterActive =
    applied.maxNights < NIGHTS_MAX || applied.maxBudget < COST_MAX;

  const applyFilters = () => setApplied(draft);
  const clearFilters = () => {
    setDraft(NO_FILTERS);
    setApplied(NO_FILTERS);
  };

  // A preset is an unsaved trip — reuse the same intent machinery the
  // results page uses, so login (password AND Google OAuth) resumes
  // straight into the save.
  const buildIntent = (
    preset: PresetItinerary,
    origin?: { city: string; airports: string[] },
  ): CanvasIntent => {
    const trip = buildPresetTrip(preset, travelers, origin);
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

  // Ask for the user's location at save time. The browser shows its native
  // permission prompt (allow while visiting / allow this time / never) —
  // granted maps the coords to the nearest major airport city, anything
  // else (denied, unsupported, no match, timeout) keeps the JFK default.
  const detectOrigin = async (): Promise<
    { city: string; airports: string[] } | undefined
  > => {
    // User turned location off in the app — never even ask the browser.
    if (!useLocation) return undefined;
    setLocating(true);
    try {
      const result = await detectNearestAirportCity();
      if (!result.ok) return undefined;
      const origin = {
        city: result.city.city,
        // Empty for single-airport cities — the backend resolves the IATA
        // code from the city name, same as a typed planner answer.
        //
        // The real geolocation reading is passed as `userLatLon`, and it
        // matters: this table's DC row is named exactly `Washington`, which
        // is ambiguous between the District and Washington State, and the
        // more prominent reading is the STATE. Without the coordinates, every
        // "use my location" tap in the DC metro saved Seattle's airports.
        //
        // Still synchronous and still offline — `resolveLocally` applies the
        // position rule against the hot set, which carries coordinates for
        // every place it ships. Nothing is sent anywhere, which is the
        // promise `nearestAirport.ts` makes about these coordinates.
        airports: originAirportsForCity(result.city.city, 3, {
          userLatLon: result.coords,
        }),
      };
      setDetectedOrigin(origin);
      return origin;
    } finally {
      setLocating(false);
    }
  };

  // Save the preset to the user's trips (same saveTrip flow as a planned
  // trip, so it lands in their history), then open the results page for it
  // where they can edit freely.
  // "Plan a similar trip": instead of copying the preset's stored prices,
  // pre-fill the planner with its shape (cities, ~same length, party,
  // origin, vibe, budget) and immediately run a FRESH optimize with
  // today's prices — the same autorun path the savings-pill replan uses.
  // The user lands on results and can tweak before saving.
  const [planning, setPlanning] = useState(false);
  const planSimilar = async (preset: PresetItinerary) => {
    if (planning) return;
    setPlanning(true);
    sendPresetEvents([{ slug: preset.slug, kind: 'use' }]);
    const origin = (await detectOrigin()) ?? { city: 'New York', airports: ['JFK'] };
    const start = new Date();
    start.setDate(start.getDate() + 30);
    const end = new Date(start);
    end.setDate(end.getDate() + presetNights(preset));
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const staged = {
      destinations: preset.cities.map((c) => c.name),
      dateRange: { start: iso(start), end: iso(end) },
      travelers,
      origin: origin.city,
      originAirports: origin.airports,
      returnToHome: true,
      planningMode: 'destination',
      vibe: presetVibes(preset)[0],
      budget: presetCostFor(preset, travelers),
      budgetPerPerson: false,
    };
    // Start from a clean planning session: resume=1 (needed for autorun)
    // keeps whatever the store holds, and a leftover answer from an earlier
    // plan — e.g. `nights`, which outranks the date range — would silently
    // reshape this trip. Safe here: an event handler, not a render.
    useTripStore.getState().resetPlanning();
    try {
      sessionStorage.setItem('bluemurr-autorun', JSON.stringify(staged));
    } catch {
      // storage blocked — the planner opens normally instead of auto-running
    }
    router.push('/plan?resume=1&autorun=1');
  };

  // Detail opened → a "view" engagement event (feeds Trending).
  useEffect(() => {
    if (selected) sendPresetEvents([{ slug: selected.slug, kind: 'view' }]);
  }, [selected]);

  const saveAndOpen = async (preset: PresetItinerary) => {
    sendPresetEvents([{ slug: preset.slug, kind: 'use' }]);
    const origin = await detectOrigin();
    if (!user) {
      stashCanvasIntent(buildIntent(preset, origin));
      setShowLogin(true);
      return;
    }
    setSaving(true);
    try {
      const tripId = await resolveCanvasTripId(buildIntent(preset, origin));
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
      const tripId = await resolveCanvasTripId(buildIntent(selected, detectedOrigin));
      clearCanvasIntent();
      if (tripId) router.push(`/results?tripId=${tripId}`);
    } catch {
      // save failed — stay on browse
    } finally {
      setSaving(false);
    }
  };

  // ── Headed sections for the grid ─────────────────────────────
  type Section = {
    key: string;
    title: string;
    icon?: 'star' | 'flame';
    href?: string;
    presets: PresetItinerary[];
  };
  const sections = useMemo<Section[]>(() => {
    const filtered = results.map((r) => r.preset);
    if (isFiltering) return [{ key: 'search', title: 'Search results', presets: filtered }];
    const visible = new Map(filtered.map((p) => [p.slug, p]));
    const pick = (slugs: string[]) =>
      slugs.map((slug) => visible.get(slug)).filter((p): p is PresetItinerary => !!p);
    const out: Section[] = [];
    if (catalogData) {
      out.push({ key: 'staff', title: 'Staff picks', icon: 'star', presets: pick(catalogData.editorial.staffPicks) });
      out.push({ key: 'trending', title: 'Trending this week', icon: 'flame', presets: pick(catalogData.editorial.trending) });
      for (const c of catalogData.categories) {
        out.push({ key: c.slug, title: c.title, href: `/trips/${c.slug}`, presets: pick(c.presetSlugs) });
      }
    }
    out.push({ key: 'all', title: 'All trips', presets: filtered });
    return out.filter((sec) => sec.presets.length > 0);
  }, [results, isFiltering, catalogData]);

  // One impression beacon per catalog load for the cards in the editorial
  // and category sections (deduped). Feeds the Trending ranking.
  const impressionsSentRef = useRef(false);
  useEffect(() => {
    if (impressionsSentRef.current || !catalogData) return;
    impressionsSentRef.current = true;
    const shown = Array.from(
      new Set(sections.filter((sec) => sec.key !== 'all' && sec.key !== 'search').flatMap((sec) => sec.presets.map((p) => p.slug))),
    );
    sendPresetEvents(shown.map((slug) => ({ slug, kind: 'impression' as const })));
  }, [catalogData, sections]);

  // Category badge: the preset's first category (catalog order), falling
  // back to its scope ("One country") when the live catalog isn't loaded.
  const categoryLabelFor = (slug: string): string | undefined => {
    if (!catalogData) return undefined;
    const cats = catalogData.presets.find((p) => p.slug === slug)?.categories ?? [];
    return catalogData.categories.find((c) => cats.includes(c.slug))?.title;
  };

  const renderCard = (preset: PresetItinerary, idx: number) => (
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
              {/* Gradient banner. w-full is load-bearing: the card is a
                  <button>, and Safari doesn't stretch a flex button's
                  children — without it the banner shrank to the title's
                  width and the photo covered only part of the card. */}
              <div
                className="w-full h-44 flex-shrink-0 px-4 flex flex-col justify-end pb-2.5 relative"
                style={{ background: bannerBackground(preset) }}
              >
                <span
                  className="absolute top-2 right-2 text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                  style={{ background: 'rgba(0,0,0,0.35)', color: 'white' }}
                  data-testid="category-badge"
                >
                  {(categoryLabelFor(preset.slug) ?? preset.scope).toUpperCase()}
                </span>
                <div className="text-white text-[15px] font-bold leading-tight drop-shadow-sm line-clamp-2">
                  {preset.title}
                </div>
                <div className="text-white/85 text-[10px] mt-0.5">{preset.flags}</div>
              </div>

              {/* Body (w-full: same Safari <button> stretch fix as the banner) */}
              <div className="w-full p-4 flex-1 flex flex-col min-h-0">
                <p className="text-[12px] text-gray-600 leading-snug mb-2">
                  {preset.tagline}
                </p>
                <div className="mb-2.5">
                  <MiniRoute cities={preset.cities} />
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
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: '#2563eb' }}
                    title="Per person: 2 sharing a room – solo"
                  >
                    ${presetPricePerPersonRange(preset).low.toLocaleString()}–$
                    {presetPricePerPersonRange(preset).high.toLocaleString()}
                    <span className="font-normal text-gray-400"> /person</span>
                  </span>
                </div>
              </div>
            </motion.button>
  );

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

        {/* Real traveler trips (opt-in Explore) — renders nothing when empty */}
        <PopularTravelerTrips />

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
              {results.length} of {catalog.length} itineraries
              {isFiltering ? ' match — best match first' : ''}
            </div>
          )}
        </div>

        {/* Sidebar + results. A hidden right spacer mirrors the sidebar's
            width, so the card grid sits perfectly centered on the page —
            on the same axis as the search bar above. */}
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* ─── Filter sidebar ─── */}
          <aside className="w-full lg:w-60 flex-shrink-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-6">
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
              {results.length} of {catalog.length} itineraries shown
              {filtersDirty && (
                <span className="block mt-1 text-amber-600">
                  Unapplied changes — click Apply
                </span>
              )}
            </div>

            {/* Jump to a section — the page's headers, as navigation.
                Lists only sections currently on the page. */}
            {sections.length > 1 && (
              <nav aria-label="Jump to section" className="border-t border-gray-100 pt-4">
                <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-2">Jump to</div>
                <ul className="flex flex-col gap-0.5">
                  {sections.map((section) => (
                    <li key={section.key}>
                      <button
                        onClick={() =>
                          document
                            .getElementById(`section-${section.key}`)
                            ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left text-[12px] text-gray-700 hover:bg-[#f0f4f8] hover:text-[#2563eb] transition-colors"
                      >
                        <span className="truncate">{section.title}</span>
                        <span className="text-[10px] text-gray-400 flex-shrink-0">
                          {section.presets.length}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
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
                    : 'Try raising the length or budget sliders.'}
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

            {/* Headed sections, 3 cards per row. Browsing: Staff picks,
                Trending, each category, then All trips — every section
                narrowed by the search box + sidebar filters (empty sections
                hide). Searching: one relevance-ranked "Search results". */}
            <div className="flex flex-col gap-8">
              {sections.map((section) => (
                <section
                  key={section.key}
                  id={`section-${section.key}`}
                  aria-label={section.title}
                  className="scroll-mt-24"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-gray-900">
                      {section.icon === 'star' && <Star size={14} className="text-amber-500" />}
                      {section.icon === 'flame' && <Flame size={14} className="text-orange-500" />}
                      {section.title}
                      <span className="text-[12px] font-normal text-gray-400">
                        {section.presets.length}
                      </span>
                    </h2>
                    {section.href && (
                      <Link
                        href={section.href}
                        className="flex items-center gap-1 text-[12px] font-medium text-[#2563eb] hover:underline underline-offset-2"
                      >
                        See all <ArrowRight size={12} />
                      </Link>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {section.presets.map((preset, idx) => renderCard(preset, idx))}
                  </div>
                </section>
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
                  style={{ background: bannerBackground(selected) }}
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
                    {/* Location switch — same pill language as the travelers
                        control. Off = never ask the browser, depart from the
                        New York (JFK) default. */}
                    <button
                      role="switch"
                      aria-checked={useLocation}
                      aria-label="Use my location"
                      onClick={toggleUseLocation}
                      title={
                        useLocation
                          ? 'We pick your nearest departure airport when you save. Click to turn off.'
                          : 'Location is off — trips depart from New York (JFK). Click to turn on.'
                      }
                      className="flex items-center gap-2 px-3 py-1.5 rounded-xl transition-colors"
                      style={{ background: '#f0f4f8', border: '1px solid rgba(0,0,0,0.08)' }}
                    >
                      <MapPin
                        size={13}
                        style={{ color: useLocation ? '#2563eb' : '#9ca3af' }}
                      />
                      <span className="text-[12px] text-gray-600 hidden sm:inline">
                        Use my location
                      </span>
                      <span
                        aria-hidden
                        className="relative inline-flex w-8 h-[18px] rounded-full transition-colors"
                        style={{ background: useLocation ? '#2563eb' : '#d1d5db' }}
                      >
                        <span
                          className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-all"
                          style={{ left: useLocation ? '18px' : '2px' }}
                        />
                      </span>
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelected(null)}
                      className="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                    >
                      Close
                    </button>
                    <button
                      onClick={() => planSimilar(selected)}
                      disabled={saving || locating || planning}
                      title="Re-plan this route with today's live prices"
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-all hover:bg-blue-50 disabled:opacity-50"
                      style={{ color: '#2563eb', border: '1px solid #2563eb' }}
                    >
                      {planning ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                      {planning ? 'Planning…' : 'Plan a similar trip'}
                    </button>
                    <button
                      onClick={() => saveAndOpen(selected)}
                      disabled={saving || locating || planning}
                      className="flex items-center gap-2 px-5 py-2 rounded-lg text-[13px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                      style={{ background: '#2563eb' }}
                    >
                      {saving || locating ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Save size={13} />
                      )}
                      {locating
                        ? 'Finding your nearest airport…'
                        : saving
                          ? 'Finding flights…'
                          : 'Save'}
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
