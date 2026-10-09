'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Flame, Loader2, MapPin, Search, TrendingUp, Users } from 'lucide-react';
import Navbar from '@/components/shared/Navbar';
import ProtectedRoute from '@/components/shared/ProtectedRoute';
import { getPopularTrips, cloneTrip, type PopularTrip } from '@/lib/api';

const VIBES = ['beach', 'food', 'history', 'art', 'nature', 'city', 'nightlife', 'romance'];

const BUDGETS: Array<{ label: string; value: number | undefined }> = [
  { label: 'Any budget', value: undefined },
  { label: 'Under $1,000', value: 1000 },
  { label: 'Under $2,500', value: 2500 },
  { label: 'Under $5,000', value: 5000 },
];

export default function ExplorePage() {
  return (
    <ProtectedRoute>
      <ExploreInner />
    </ProtectedRoute>
  );
}

/**
 * Explore: real trips other travelers shared (opt-in "Share to Explore"),
 * ranked by how often they've been cloned. Cloning makes a personal,
 * editable copy and opens it on the results page.
 */
function ExploreInner() {
  const router = useRouter();
  const [sort, setSort] = useState<'popular' | 'trending'>('popular');
  const [vibe, setVibe] = useState<string>('');
  const [maxBudget, setMaxBudget] = useState<number | undefined>(undefined);
  const [cityDraft, setCityDraft] = useState('');
  const [city, setCity] = useState('');
  const [trips, setTrips] = useState<PopularTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [cloningId, setCloningId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(false);
    getPopularTrips({
      sort,
      vibe: vibe || undefined,
      maxBudget,
      cities: city ? [city] : undefined,
    })
      .then((r) => !disposed && setTrips(r.trips))
      .catch(() => !disposed && setError(true))
      .finally(() => !disposed && setLoading(false));
    return () => {
      disposed = true;
    };
  }, [sort, vibe, maxBudget, city]);

  const handleClone = async (t: PopularTrip) => {
    if (cloningId) return;
    setCloningId(t.id);
    try {
      const res = await cloneTrip(t.id);
      router.push(`/results?tripId=${res.tripId}`);
    } catch {
      setCloningId(null);
    }
  };

  const filtersActive = !!vibe || maxBudget !== undefined || !!city;

  return (
    <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
      <Navbar />
      <div className="pt-20 px-5 pb-12 max-w-6xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-[26px] font-bold text-gray-900">Explore trips</h1>
          <p className="text-sm text-gray-500 mt-1">
            Real itineraries other travelers shared. Clone one to make it your own.
          </p>
        </div>

        {/* Sort */}
        <div className="flex justify-center mb-4">
          <div className="inline-flex p-1 rounded-xl bg-white border border-gray-200">
            {(['popular', 'trending'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                  sort === s ? 'bg-[#2563eb] text-white' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {s === 'popular' ? <TrendingUp size={13} /> : <Flame size={13} />}
                {s === 'popular' ? 'Most cloned' : 'Trending this week'}
              </button>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
          <button
            onClick={() => setVibe('')}
            className={`px-3 py-1 rounded-full text-[12px] border transition-colors ${
              vibe === '' ? 'bg-[#2563eb] text-white border-[#2563eb]' : 'bg-white text-gray-600 border-gray-200'
            }`}
          >
            All vibes
          </button>
          {VIBES.map((v) => (
            <button
              key={v}
              onClick={() => setVibe(vibe === v ? '' : v)}
              className={`px-3 py-1 rounded-full text-[12px] border capitalize transition-colors ${
                vibe === v ? 'bg-[#2563eb] text-white border-[#2563eb]' : 'bg-white text-gray-600 border-gray-200'
              }`}
            >
              {v}
            </button>
          ))}
          <select
            aria-label="Budget"
            value={maxBudget ?? ''}
            onChange={(e) => setMaxBudget(e.target.value ? Number(e.target.value) : undefined)}
            className="px-3 py-1.5 rounded-full text-[12px] border border-gray-200 bg-white text-gray-700 outline-none"
          >
            {BUDGETS.map((b) => (
              <option key={b.label} value={b.value ?? ''}>
                {b.label}
              </option>
            ))}
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setCity(cityDraft.trim());
            }}
            className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-gray-200 bg-white"
          >
            <Search size={12} className="text-gray-400" />
            <input
              value={cityDraft}
              onChange={(e) => {
                setCityDraft(e.target.value);
                if (!e.target.value.trim()) setCity('');
              }}
              placeholder="Filter by city"
              aria-label="Filter by city"
              className="w-28 text-[12px] outline-none bg-transparent"
            />
          </form>
        </div>

        {/* Results */}
        {loading ? (
          <div className="flex justify-center py-16 text-gray-400">
            <Loader2 size={22} className="animate-spin" />
          </div>
        ) : error ? (
          <p className="text-center text-sm text-gray-500 py-16">
            Couldn&apos;t load trips. Try again in a moment.
          </p>
        ) : trips.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-sm text-gray-600 font-medium">
              {sort === 'trending' && !filtersActive
                ? 'Nothing trending this week yet'
                : filtersActive
                  ? 'No shared trips match these filters'
                  : 'No shared trips yet'}
            </p>
            <p className="text-[12px] text-gray-400 mt-1">
              Share one of yours from My Trips with &ldquo;Share to Explore&rdquo;.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {trips.map((t) => (
              <div key={t.id} className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col">
                <h2 className="text-[15px] font-semibold text-gray-900 leading-snug">{t.title}</h2>
                <div className="flex items-center gap-1 mt-1 text-[12px] text-gray-500">
                  <MapPin size={11} />
                  <span className="truncate">
                    {t.cities.map((c) => c.name).join(' → ') || 'Multi-city trip'}
                  </span>
                </div>
                {t.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2.5">
                    {t.tags.slice(0, 4).map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide bg-blue-50 text-[#2563eb]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-3 text-[11.5px] text-gray-500">
                  <span className="flex items-center gap-1">
                    <Copy size={11} /> {t.cloneCount} {t.cloneCount === 1 ? 'clone' : 'clones'}
                  </span>
                  {t.clonesThisWeek > 0 && (
                    <span className="flex items-center gap-1 text-orange-500">
                      <Flame size={11} /> {t.clonesThisWeek} this week
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Users size={11} /> {t.travelers}
                  </span>
                </div>
                <div className="mt-auto pt-4 flex items-center justify-between">
                  <div className="min-w-0">
                    {t.totalCost != null && (
                      <div className="text-[14px] font-semibold text-gray-900">
                        ~${Math.round(t.totalCost).toLocaleString()}
                      </div>
                    )}
                    <div className="text-[10.5px] text-gray-400 truncate">
                      {t.isMine ? 'Your trip' : `Shared by ${t.ownerName ?? 'a BlueMurr traveler'}`}
                    </div>
                  </div>
                  {t.isMine ? (
                    <button
                      onClick={() => router.push(`/results?tripId=${t.id}`)}
                      className="px-3.5 py-1.5 rounded-lg text-[12px] font-medium text-[#2563eb] border border-[#2563eb] hover:bg-blue-50 transition-colors"
                    >
                      Open
                    </button>
                  ) : (
                    <button
                      onClick={() => handleClone(t)}
                      disabled={cloningId !== null}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-medium text-white bg-[#2563eb] hover:brightness-110 disabled:opacity-50 transition-all"
                    >
                      {cloningId === t.id ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />}
                      {cloningId === t.id ? 'Cloning…' : 'Clone trip'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
