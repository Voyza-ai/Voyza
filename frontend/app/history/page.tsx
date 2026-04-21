'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, MapPin, Users, Calendar, Plane, Plus } from 'lucide-react';
import Navbar from '@/components/shared/Navbar';
import ProtectedRoute from '@/components/shared/ProtectedRoute';
import { getAuthHeader } from '@/lib/supabase';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type TripSummary = {
  id: string;
  title: string;
  status: 'active' | 'completed' | 'archived';
  travelers: number;
  total_cost: number;
  savings_vs_alternative: number;
  created_at: string;
  city_count: number;
  cities: string[];
  date_range?: { start: string; end: string };
};

const STATUS_STYLES: Record<string, { label: string }> = {
  active: { label: 'ACTIVE' },
  completed: { label: 'COMPLETED' },
  archived: { label: 'ARCHIVED' },
};

const CARD_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
];

export default function HistoryPage() {
  return (
    <ProtectedRoute>
      <HistoryPageInner />
    </ProtectedRoute>
  );
}

function HistoryPageInner() {
  const router = useRouter();
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTrips() {
      try {
        const headers = await getAuthHeader();
        const res = await fetch(`${BASE_URL}/api/trips`, {
          headers: { 'Content-Type': 'application/json', ...headers },
        });
        if (!res.ok) throw new Error('Failed to load trips');
        const data = await res.json();
        setTrips(data.trips ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load trips');
      } finally {
        setLoading(false);
      }
    }
    fetchTrips();
  }, []);

  const handleDelete = async (tripId: string) => {
    const headers = await getAuthHeader();
    const res = await fetch(`${BASE_URL}/api/trips/${tripId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
    });
    if (res.ok) {
      setTrips((prev) => prev.filter((t) => t.id !== tripId));
    }
  };

  return (
    <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
      <Navbar />
      <div className="pt-20 px-6 pb-10 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">My Trips</h1>
          <button
            onClick={() => router.push('/plan')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-all hover:brightness-110"
            style={{ background: '#2563eb' }}
          >
            <Plus size={14} />
            New Trip
          </button>
        </div>

        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-100 overflow-hidden animate-pulse">
                <div className="h-24 bg-gray-200" />
                <div className="p-4 space-y-3">
                  <div className="h-4 bg-gray-200 rounded w-3/4" />
                  <div className="h-3 bg-gray-100 rounded w-1/2" />
                  <div className="h-3 bg-gray-100 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-lg px-4 py-3 text-sm" style={{ background: '#fef2f2', color: '#dc2626' }}>
            {error}
          </div>
        )}

        {!loading && !error && trips.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4" style={{ background: 'rgba(37,99,235,0.08)' }}>
              <Plane size={28} style={{ color: '#2563eb' }} />
            </div>
            <h2 className="text-lg font-medium text-gray-900 mb-1">No trips yet</h2>
            <p className="text-sm text-gray-500 mb-5">Plan your first adventure</p>
            <button
              onClick={() => router.push('/plan')}
              className="px-6 py-2.5 rounded-lg text-sm font-medium text-white"
              style={{ background: '#2563eb' }}
            >
              Start planning
            </button>
          </div>
        )}

        {!loading && trips.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {trips.map((trip, idx) => {
              const status = STATUS_STYLES[trip.status] ?? STATUS_STYLES.active;
              return (
                <div
                  key={trip.id}
                  className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-sm hover:shadow-md transition-shadow group"
                >
                  <div
                    className="h-20 px-4 flex items-end pb-2"
                    style={{ background: CARD_GRADIENTS[idx % CARD_GRADIENTS.length] }}
                  >
                    <span
                      className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(255,255,255,0.25)', color: 'white' }}
                    >
                      {status.label}
                    </span>
                  </div>

                  <div className="p-4">
                    <h3 className="text-gray-900 font-medium text-sm mb-2 truncate">
                      {trip.title || trip.cities.join(' \u00b7 ')}
                    </h3>

                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mb-3">
                      <span className="flex items-center gap-1">
                        <MapPin size={12} />
                        {trip.city_count ?? trip.cities.length} cities
                      </span>
                      <span className="flex items-center gap-1">
                        <Users size={12} />
                        {trip.travelers}
                      </span>
                      {trip.date_range && (
                        <span className="flex items-center gap-1">
                          <Calendar size={12} />
                          {trip.date_range.start}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold" style={{ color: '#2563eb' }}>
                        ${trip.total_cost.toLocaleString()}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(trip.id);
                          }}
                          className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 size={14} />
                        </button>
                        <button
                          onClick={() => router.push(`/results?tripId=${trip.id}`)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-white"
                          style={{ background: '#2563eb' }}
                        >
                          Open trip
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
