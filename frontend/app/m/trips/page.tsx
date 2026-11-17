'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Trash2, Users, Plus } from 'lucide-react';
import MobileTabBar from '@/components/mobile/MobileTabBar';
import BottomSheet from '@/components/mobile/BottomSheet';
import { M, dashedRoute } from '@/components/mobile/theme';
import { getCityColor } from '@/lib/cityColors';
import { humanDay } from '@/lib/dateHelpers';
import { getAuthHeader } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import LoginModal from '@/components/shared/LoginModal';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** The summary row GET /api/trips returns (the same one /history reads). */
type TripSummary = {
  id: string;
  title: string;
  travelers: number;
  total_cost: number;
  city_count: number;
  cities: string[];
  date_range?: { start: string; end: string };
  role?: string;
  owner_name?: string | null;
};

/** My trips on a phone: the /history list (own + shared with me), open or delete. */
export default function MobileTrips() {
  const user = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.isLoading);
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [shared, setShared] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TripSummary | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    if (authLoading || !user) {
      setLoading(authLoading);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const headers = await getAuthHeader();
        const res = await fetch(`${BASE_URL}/api/trips`, { headers: { 'Content-Type': 'application/json', ...headers } });
        if (!res.ok) throw new Error('Failed to load trips');
        const data = await res.json();
        if (!alive) return;
        setTrips(data.trips ?? []);
        setShared(data.shared ?? []);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load trips');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user?.id, authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (id: string) => {
    const headers = await getAuthHeader();
    const res = await fetch(`${BASE_URL}/api/trips/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...headers } });
    if (res.ok) setTrips((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <main className="pb-28 px-4" style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }} data-testid="m-trips">
      <h1 className="px-1 pt-2 text-[28px] font-semibold text-gray-900">My trips</h1>

      {!authLoading && !user ? (
        <div className="mt-8 rounded-3xl bg-white border p-6 text-center" style={{ borderColor: M.line }}>
          <p className="text-[15px] text-gray-600">Sign in to see the trips you've saved and the ones shared with you.</p>
          <button onClick={() => setLoginOpen(true)} className="mt-4 w-full min-h-[50px] rounded-2xl text-white text-[16px] font-semibold" style={{ background: M.blue }}>
            Sign in
          </button>
        </div>
      ) : loading ? (
        <div className="mt-10 flex justify-center">
          <div className="w-7 h-7 border-2 border-[#2563eb] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <p className="mt-8 text-center text-red-500 text-[15px]">{error}</p>
      ) : (
        <>
          {trips.length === 0 && (
            <div className="mt-6 rounded-3xl bg-white border p-6 text-center" style={{ borderColor: M.line }}>
              <p className="text-[15px] text-gray-600">No saved trips yet.</p>
              <Link href="/m/plan" className="mt-4 min-h-[50px] flex items-center justify-center gap-2 rounded-2xl text-white text-[16px] font-semibold" style={{ background: M.blue }}>
                <Plus size={18} /> Plan a trip
              </Link>
            </div>
          )}
          <div className="mt-4 flex flex-col gap-3">
            {trips.map((t) => (
              <TripRow key={t.id} t={t} onDelete={() => setConfirmDelete(t)} />
            ))}
          </div>
          {shared.length > 0 && (
            <>
              <h2 className="px-1 mt-8 text-[17px] font-semibold text-gray-900">Shared with me</h2>
              <div className="mt-3 flex flex-col gap-3">
                {shared.map((t) => (
                  <TripRow key={t.id} t={t} />
                ))}
              </div>
            </>
          )}
        </>
      )}

      <BottomSheet open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete this trip?" subtitle={confirmDelete?.title}>
        <div className="px-5 pb-[max(16px,env(safe-area-inset-bottom))] flex gap-2">
          <button onClick={() => setConfirmDelete(null)} className="flex-1 min-h-[50px] rounded-2xl border text-[16px]" style={{ borderColor: M.line }}>
            Keep
          </button>
          <button
            onClick={() => {
              const id = confirmDelete!.id;
              setConfirmDelete(null);
              remove(id);
            }}
            className="flex-1 min-h-[50px] rounded-2xl text-white text-[16px] font-semibold bg-red-600"
          >
            Delete
          </button>
        </div>
      </BottomSheet>
      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={() => setLoginOpen(false)} />
      <MobileTabBar />
    </main>
  );
}

function TripRow({ t, onDelete }: { t: TripSummary; onDelete?: () => void }) {
  const c = getCityColor(0);
  return (
    <div className="relative rounded-3xl bg-white border overflow-hidden" style={{ borderColor: M.line }} data-testid="m-trip-row">
      <Link href={`/m/trip?tripId=${t.id}`} className="block p-4 pr-14">
        <div className="text-[17px] font-semibold text-gray-900 truncate">{t.title || 'Untitled trip'}</div>
        <div className="mt-1 text-[13px] text-gray-500 flex items-center gap-2">
          {t.date_range?.start ? `${humanDay(t.date_range.start)} – ${humanDay(t.date_range.end)}` : `${t.city_count} stops`}
          <span className="flex items-center gap-0.5">
            <Users size={12} /> {t.travelers}
          </span>
          {t.owner_name && <span>· from {t.owner_name}</span>}
        </div>
        <div className="mt-2.5 flex items-center flex-wrap gap-y-1.5">
          {(t.cities ?? []).map((n, i) => {
            const col = getCityColor(i);
            return (
              <span key={`${n}-${i}`} className="flex items-center">
                <span className="px-2.5 py-1 rounded-full text-[12px] font-medium border" style={{ background: col.bg, color: col.text, borderColor: col.border }}>
                  {n}
                </span>
                {i < t.cities.length - 1 && <span className="w-4 h-[2px] mx-0.5" style={{ backgroundImage: dashedRoute('#9ca3af', false) }} aria-hidden />}
              </span>
            );
          })}
        </div>
        {t.total_cost > 0 && <div className="mt-2 text-[15px] font-semibold" style={{ color: c.text }}>${Math.round(t.total_cost).toLocaleString()}</div>}
      </Link>
      {onDelete && (
        <button onClick={onDelete} aria-label={`Delete ${t.title}`} className="absolute top-2 right-2 w-11 h-11 rounded-full flex items-center justify-center text-gray-400 active:bg-gray-100">
          <Trash2 size={18} />
        </button>
      )}
    </div>
  );
}
