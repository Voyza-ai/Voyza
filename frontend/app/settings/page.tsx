'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bell, Lock, Shield, User } from 'lucide-react';
import Navbar from '@/components/shared/Navbar';
import { useAuthStore } from '@/store/authStore';
import ProtectedRoute from '@/components/shared/ProtectedRoute';
import { getCurrentUser, updateCurrentUser, type UserProfile } from '@/lib/api';
import ProfileTab from '@/components/settings/ProfileTab';
import AccountTab from '@/components/settings/AccountTab';
import NotificationsTab from '@/components/settings/NotificationsTab';
import PrivacyTab from '@/components/settings/PrivacyTab';

const TABS = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'account', label: 'Account', icon: Lock },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'privacy', label: 'Privacy & data', icon: Shield },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Prefs = UserProfile['preferences'];

/** Same nested merge the backend does (notifications/email/privacy). */
function mergePrefs(current: Prefs, patch: Prefs): Prefs {
  const out: Record<string, any> = { ...current, ...patch };
  for (const k of ['notifications', 'email', 'privacy'] as const) {
    if (patch[k]) out[k] = { ...(current[k] ?? {}), ...patch[k] };
  }
  return out as Prefs;
}

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <Suspense fallback={null}>
        <SettingsInner />
      </Suspense>
    </ProtectedRoute>
  );
}

function SettingsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : 'profile';

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [prefError, setPrefError] = useState<string | null>(null);
  // Toggle saves run one at a time so a fast double-flip can't land out of order.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(() => {
    getCurrentUser()
      .then((p) => {
        setProfile(p);
        useAuthStore.getState().setAvatarUrl(p.avatarUrl ?? null);
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(load, [load]);

  const savePrefs = (patch: Prefs) => {
    if (!profile) return;
    const before = profile;
    setPrefError(null);
    setProfile((p) => (p ? { ...p, preferences: mergePrefs(p.preferences, patch) } : p));
    queue.current = queue.current
      .then(() => updateCurrentUser({ preferences: patch }))
      .then((res) => setProfile((p) => (p ? { ...p, preferences: res.preferences ?? p.preferences } : p)))
      .catch(() => {
        setProfile(before);
        setPrefError("That change didn't save — check your connection and try again.");
      });
  };

  return (
    <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
      <Navbar />
      <div className="pt-20 px-6 pb-12 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

        <div className="flex gap-6 items-start">
          <nav aria-label="Settings sections" className="w-56 shrink-0 bg-white rounded-xl border border-gray-100 p-2">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = id === tab;
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => router.replace(`/settings?tab=${id}`)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                    active ? 'bg-[#2563eb]/10 text-[#2563eb] font-medium' : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <Icon size={15} />
                  {label}
                </button>
              );
            })}
          </nav>

          <div className="flex-1 min-w-0">
            {loadError && (
              <div className="rounded-lg px-4 py-3 text-sm" style={{ background: '#fef2f2', color: '#dc2626' }}>
                Couldn&apos;t load your settings.{' '}
                <button className="underline" onClick={load}>
                  Try again
                </button>
              </div>
            )}

            {!profile && !loadError && (
              <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-3 animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-1/3" />
                <div className="h-3 bg-gray-100 rounded w-1/2" />
                <div className="h-9 bg-gray-100 rounded" />
              </div>
            )}

            {prefError && (
              <div role="alert" className="rounded-lg px-4 py-3 text-sm mb-4" style={{ background: '#fef2f2', color: '#dc2626' }}>
                {prefError}
              </div>
            )}

            {profile && tab === 'profile' && (
              <ProfileTab key={profile.id} profile={profile} onSaved={setProfile} />
            )}
            {profile && tab === 'account' && <AccountTab profile={profile} onAccountChanged={load} />}
            {profile && tab === 'notifications' && (
              <NotificationsTab preferences={profile.preferences} onChange={savePrefs} />
            )}
            {profile && tab === 'privacy' && <PrivacyTab preferences={profile.preferences} onChange={savePrefs} />}
          </div>
        </div>
      </div>
    </main>
  );
}
