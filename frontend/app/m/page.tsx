'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Users, Copy } from 'lucide-react';
import MobileTabBar from '@/components/mobile/MobileTabBar';
import BottomSheet from '@/components/mobile/BottomSheet';
import { M, dashedRoute } from '@/components/mobile/theme';
import { PRESET_ITINERARIES, buildPresetTrip, presetCost, presetNights, type PresetItinerary } from '@/data/presetItineraries';
import { cardCoverBackground } from '@/components/browse/coverBackground';
import { getCityColor } from '@/lib/cityColors';
import { getPopularTrips, cloneTrip, type PopularTrip } from '@/lib/api';
import { useTripStore } from '@/store/tripStore';
import { useAuthStore } from '@/store/authStore';
import LoginModal from '@/components/shared/LoginModal';

const STARTERS = ['Paris and London in May', 'Two weeks in Japan', 'A beach week under $2,000', 'Rome, Florence and Venice by train'];

/**
 * Mobile home: "Where to?" (straight into the AI planner with that sentence)
 * and Explore — the curated trips from /browse and what other travellers
 * are planning (/explore), as pastel city cards.
 */
export default function MobileHome() {
  const router = useRouter();
  const [where, setWhere] = useState('');
  const [preview, setPreview] = useState<PresetItinerary | null>(null);
  const [popular, setPopular] = useState<PopularTrip[] | null>(null);
  const [loginFor, setLoginFor] = useState<PopularTrip | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    let alive = true;
    getPopularTrips({ sort: 'popular', limit: 6 })
      .then((r) => alive && setPopular(r.trips ?? []))
      .catch(() => alive && setPopular([]));
    return () => {
      alive = false;
    };
  }, []);

  const startPlanning = (text: string) => {
    const t = text.trim();
    // The planner opens its conversation with this sentence (PlanningChat's
    // rawInput seed), exactly as the desktop hero did.
    if (t) useTripStore.getState().setAnswer('rawInput', t);
    router.push('/m/plan');
  };

  const usePreset = (p: PresetItinerary) => {
    useTripStore.getState().setTrip(buildPresetTrip(p, p.travelers));
    router.push('/m/trip');
  };

  const usePopular = async (t: PopularTrip) => {
    if (!user) {
      setLoginFor(t);
      return;
    }
    setCloning(t.id);
    try {
      const res: any = await cloneTrip(t.id);
      const id = res?.tripId ?? res?.trip?.id ?? res?.id;
      if (id) router.push(`/m/trip?tripId=${id}`);
    } finally {
      setCloning(null);
    }
  };

  return (
    <main className="pb-28" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }} data-testid="m-home">
      <div className="px-5 pt-3">
        <div className="text-[26px] font-bold tracking-tight" style={{ color: M.blue }}>BlueMurr</div>
        <h1 className="mt-4 text-[30px] leading-[1.1] font-semibold text-gray-900">Where to?</h1>
        <p className="mt-1 text-[15px] text-gray-500">Say it the way you'd tell a friend — BlueMurr plans flights, trains and stays.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            startPlanning(where);
          }}
          className="mt-4 flex items-center gap-2 bg-white rounded-2xl border p-1.5"
          style={{ borderColor: M.line }}
        >
          <input
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            placeholder="Paris and London, 2 of us, May"
            enterKeyHint="go"
            className="flex-1 min-w-0 h-12 px-3 text-[16px] outline-none bg-transparent"
            aria-label="Where to?"
          />
          <button type="submit" className="w-12 h-12 rounded-xl flex items-center justify-center text-white" style={{ background: M.blue }} aria-label="Start planning">
            <ArrowRight size={20} />
          </button>
        </form>
        <div className="mt-3 flex gap-2 overflow-x-auto -mx-5 px-5 scrollbar-hide">
          {STARTERS.map((s) => (
            <button
              key={s}
              onClick={() => startPlanning(s)}
              className="flex-shrink-0 min-h-[40px] px-3.5 rounded-full border bg-white text-[14px] text-gray-700 whitespace-nowrap"
              style={{ borderColor: M.line }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <section className="mt-8">
        <div className="px-5 flex items-baseline justify-between">
          <h2 className="text-[19px] font-semibold text-gray-900">Trips to steal</h2>
          <span className="text-[13px] text-gray-500">{PRESET_ITINERARIES.length} ready-made</span>
        </div>
        <div className="mt-3 flex flex-col gap-3 px-4">
          {PRESET_ITINERARIES.map((p) => (
            <button
              key={p.slug}
              onClick={() => setPreview(p)}
              className="text-left rounded-3xl overflow-hidden bg-white border active:scale-[0.99] transition-transform"
              style={{ borderColor: M.line }}
              data-testid="m-preset"
            >
              <div className="h-28 relative" style={{ background: cardCoverBackground(p) }}>
                <div className="absolute left-4 bottom-3 right-4 text-white">
                  <div className="text-[12px] opacity-90">{p.flags} · {p.scope}</div>
                  <div className="text-[19px] font-semibold leading-tight">{p.title}</div>
                </div>
              </div>
              <div className="px-4 py-3">
                <RouteChips names={p.cities.map((c) => c.name)} />
                <div className="mt-2 flex items-center justify-between text-[13px] text-gray-500">
                  <span>{presetNights(p)} nights · {p.travelers} travellers</span>
                  <span className="font-semibold text-gray-900">${presetCost(p).toLocaleString()}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {popular && popular.length > 0 && (
        <section className="mt-8">
          <h2 className="px-5 text-[19px] font-semibold text-gray-900">Popular with travellers</h2>
          <div className="mt-3 flex gap-3 overflow-x-auto px-4 pb-1 scrollbar-hide">
            {popular.map((t) => (
              <div key={t.id} className="flex-shrink-0 w-[260px] rounded-3xl bg-white border p-4 flex flex-col gap-2" style={{ borderColor: M.line }}>
                <div className="text-[16px] font-semibold text-gray-900 truncate">{t.title}</div>
                <RouteChips names={t.cities.map((c) => c.name)} />
                <div className="text-[12px] text-gray-500 flex items-center gap-1">
                  <Users size={12} /> {t.travelers} · {t.cloneCount} used it
                </div>
                <button
                  onClick={() => usePopular(t)}
                  disabled={cloning === t.id}
                  className="mt-1 min-h-[44px] flex items-center justify-center gap-1.5 rounded-xl border text-[14px] font-medium disabled:opacity-50"
                  style={{ borderColor: M.blue, color: M.blue }}
                >
                  <Copy size={14} /> {cloning === t.id ? 'Copying…' : 'Use this trip'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <BottomSheet open={!!preview} onClose={() => setPreview(null)} title={preview?.title ?? ''} subtitle={preview?.tagline} testId="m-preset-sheet"
        footer={
          preview ? (
            <div className="px-4 pt-2 pb-[max(14px,env(safe-area-inset-bottom))] border-t" style={{ borderColor: M.line }}>
              <button onClick={() => usePreset(preview)} className="w-full min-h-[52px] rounded-2xl text-[16px] font-semibold text-white" style={{ background: M.blue }}>
                Open this trip
              </button>
            </div>
          ) : undefined
        }
      >
        {preview && (
          <div className="px-5 pb-4 flex flex-col gap-3">
            <p className="text-[15px] text-gray-700 leading-relaxed">{preview.description}</p>
            <div className="flex flex-col">
              {preview.cities.map((c, i) => {
                const col = getCityColor(i);
                return (
                  <div key={c.name}>
                    <div className="rounded-2xl border-2 px-4 py-2.5 flex items-center justify-between" style={{ background: col.bg, borderColor: col.border, color: col.text }}>
                      <span className="text-[16px] font-semibold">{c.name}</span>
                      <span className="text-[13px]">{c.nights} nights</span>
                    </div>
                    {i < preview.cities.length - 1 && (
                      <div className="h-6 ml-6 w-[2px]" style={{ backgroundImage: dashedRoute(`${col.text}88`) }} aria-hidden />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </BottomSheet>

      <LoginModal
        isOpen={!!loginFor}
        subtitle="Sign in to copy this trip to your own trips"
        onClose={() => setLoginFor(null)}
        onSuccess={() => {
          const t = loginFor;
          setLoginFor(null);
          if (t) usePopular(t);
        }}
      />
      <MobileTabBar />
    </main>
  );
}

function RouteChips({ names }: { names: string[] }) {
  return (
    <div className="flex items-center flex-wrap gap-y-1.5">
      {names.map((n, i) => {
        const c = getCityColor(i);
        return (
          <span key={`${n}-${i}`} className="flex items-center">
            <span className="px-2.5 py-1 rounded-full text-[12px] font-medium border" style={{ background: c.bg, color: c.text, borderColor: c.border }}>
              {n}
            </span>
            {i < names.length - 1 && <span className="w-4 h-[2px] mx-0.5" style={{ backgroundImage: dashedRoute('#9ca3af', false) }} aria-hidden />}
          </span>
        );
      })}
    </div>
  );
}
