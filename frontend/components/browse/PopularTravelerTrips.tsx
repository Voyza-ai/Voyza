'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Copy, Flame, MapPin } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { getPopularTrips, type PopularTrip } from '@/lib/api';

/**
 * Bonus row on Browse: the most-cloned real trips travelers shared to
 * Explore. Presets stay the primary surface — this row renders nothing
 * until at least one shared trip exists (or when signed out, since the
 * discovery API requires an account).
 */
export default function PopularTravelerTrips() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [trips, setTrips] = useState<PopularTrip[]>([]);

  useEffect(() => {
    if (!user) return;
    let disposed = false;
    getPopularTrips({ sort: 'popular', limit: 3 })
      .then((r) => !disposed && setTrips(r.trips))
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [user]);

  if (!user || trips.length === 0) return null;

  return (
    <section className="max-w-5xl mx-auto mb-6">
      <div className="flex items-center justify-between mb-2.5">
        <h2 className="text-[14px] font-semibold text-gray-800">Popular with travelers</h2>
        <button
          onClick={() => router.push('/explore')}
          className="flex items-center gap-1 text-[12px] font-medium text-[#2563eb] hover:underline underline-offset-2"
        >
          See all <ArrowRight size={12} />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {trips.map((t) => (
          <button
            key={t.id}
            onClick={() => router.push('/explore')}
            className="w-full text-left bg-white rounded-xl border border-gray-200 px-3.5 py-3 hover:shadow-md transition-shadow"
          >
            <div className="text-[13px] font-semibold text-gray-900 truncate">{t.title}</div>
            <div className="flex items-center gap-1 mt-0.5 text-[11px] text-gray-500">
              <MapPin size={10} />
              <span className="truncate">{t.cities.map((c) => c.name).join(' → ')}</span>
            </div>
            <div className="flex items-center gap-2.5 mt-2 text-[11px] text-gray-500">
              <span className="flex items-center gap-1">
                <Copy size={10} /> {t.cloneCount} {t.cloneCount === 1 ? 'clone' : 'clones'}
              </span>
              {t.clonesThisWeek > 0 && (
                <span className="flex items-center gap-1 text-orange-500">
                  <Flame size={10} /> {t.clonesThisWeek} this week
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
