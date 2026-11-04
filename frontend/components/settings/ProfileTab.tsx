'use client';

import { useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { suggestLocations, updateCurrentUser, type UserProfile } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { resizeImageToDataUrl } from '@/lib/avatar';
import { SettingsCard, Field, inputClass, PrimaryButton, SecondaryButton, Status } from './ui';
import Autocomplete, { type AutocompleteOption } from './Autocomplete';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'INR'];

type Form = {
  fullName: string;
  homeCity: string;
  homeAirport: string;
  preferredCurrency: string;
  defaultTravelers: string;
};

const formFrom = (p: UserProfile): Form => ({
  fullName: p.fullName ?? '',
  homeCity: p.preferences.homeCity ?? '',
  homeAirport: p.preferences.homeAirport ?? '',
  preferredCurrency: p.preferences.preferredCurrency ?? 'USD',
  defaultTravelers: String(p.preferences.defaultTravelers ?? 1),
});

export function initialsFor(name: string | null | undefined, email: string | null | undefined) {
  if (name && name.trim()) {
    return name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return (email?.[0] ?? '?').toUpperCase();
}

const fetchCities = async (q: string, signal: AbortSignal): Promise<AutocompleteOption[]> =>
  (await suggestLocations('city', q, signal)).map((c) => ({ key: c.label, value: c.label, primary: c.label }));

const fetchAirports = async (q: string, signal: AbortSignal): Promise<AutocompleteOption[]> =>
  (await suggestLocations('airport', q, signal)).map((a) => ({
    key: a.iata,
    value: a.iata,
    primary: `${a.iata} · ${a.name}`,
    secondary: [a.city, a.country].filter(Boolean).join(', ') || undefined,
  }));

export default function ProfileTab({
  profile,
  onSaved,
}: {
  profile: UserProfile;
  onSaved: (p: UserProfile) => void;
}) {
  const [form, setForm] = useState<Form>(() => formFrom(profile));
  const [avatar, setAvatar] = useState<string | null>(profile.avatarUrl);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const saved = formFrom(profile);
  const dirty =
    (Object.keys(form) as (keyof Form)[]).some((k) => form[k] !== saved[k]) ||
    avatar !== profile.avatarUrl;

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setStatus(null);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  // A photo is saved the moment it is picked (or removed) — no Save click —
  // and pushed to the auth store so the navbar avatar changes at once.
  const [photoBusy, setPhotoBusy] = useState(false);
  const saveAvatar = async (next: string | null) => {
    const previous = avatar;
    setAvatar(next);
    setPhotoBusy(true);
    try {
      const res = await updateCurrentUser({ avatarUrl: next });
      const saved = res.avatarUrl ?? next;
      useAuthStore.getState().setAvatarUrl(saved);
      onSaved({ ...profile, ...res, avatarUrl: saved, preferences: res.preferences ?? profile.preferences });
      setStatus({ kind: 'ok', text: next ? 'Photo updated.' : 'Photo removed.' });
    } catch (err) {
      setAvatar(previous);
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save your photo.' });
    } finally {
      setPhotoBusy(false);
    }
  };

  const setText = (k: keyof Form) => (text: string) => {
    setStatus(null);
    setForm((f) => ({ ...f, [k]: text }));
  };

  const pickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStatus(null);
    let dataUrl: string;
    try {
      dataUrl = await resizeImageToDataUrl(file);
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not use that image.' });
      return;
    }
    await saveAvatar(dataUrl);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const fullName = form.fullName.trim();
    if (!fullName) {
      setStatus({ kind: 'error', text: 'Enter your name.' });
      return;
    }
    const travelers = Number(form.defaultTravelers);
    if (!Number.isInteger(travelers) || travelers < 1 || travelers > 20) {
      setStatus({ kind: 'error', text: 'Default travelers must be a whole number from 1 to 20.' });
      return;
    }
    const homeAirport = form.homeAirport.trim().toUpperCase();
    if (homeAirport && !/^[A-Z]{3}$/.test(homeAirport)) {
      setStatus({ kind: 'error', text: 'Pick your home airport from the list, or type its 3-letter code.' });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await updateCurrentUser({
        fullName,
        avatarUrl: avatar,
        preferences: {
          homeCity: form.homeCity.trim(),
          homeAirport,
          preferredCurrency: form.preferredCurrency,
          defaultTravelers: travelers,
        },
      });
      // The navbar's initials read the auth user's metadata — keep it in step.
      if (fullName !== profile.fullName) {
        try {
          const { data } = await supabase.auth.updateUser({ data: { full_name: fullName } });
          if (data?.user) useAuthStore.getState().setUser(data.user);
        } catch {
          /* non-fatal: the profile row is the source of truth */
        }
      }
      onSaved({ ...profile, ...res, preferences: res.preferences ?? profile.preferences });
      setForm((f) => ({ ...f, fullName, homeAirport }));
      setStatus({ kind: 'ok', text: 'Profile saved.' });
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save your profile.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <SettingsCard title="Profile" description="How you appear to people you plan trips with.">
        <div className="flex items-center gap-5 mb-6">
          {avatar ? (
            <img src={avatar} alt="Your avatar" className="w-16 h-16 rounded-full object-cover border border-gray-100" />
          ) : (
            <div
              aria-label="Your avatar"
              className="w-16 h-16 rounded-full flex items-center justify-center text-lg font-semibold text-[#2563eb]"
              style={{ background: 'rgba(37,99,235,0.1)' }}
            >
              {initialsFor(form.fullName, profile.email)}
            </div>
          )}
          <div className="flex items-center gap-2">
            <SecondaryButton type="button" busy={photoBusy} onClick={() => fileRef.current?.click()}>
              <Camera size={14} />
              {avatar ? 'Change photo' : 'Upload photo'}
            </SecondaryButton>
            {avatar && (
              <button
                type="button"
                disabled={photoBusy}
                onClick={() => {
                  setStatus(null);
                  void saveAvatar(null);
                }}
                className="px-3 py-2 text-[13px] font-medium text-gray-500 hover:text-gray-800 transition-colors"
              >
                Remove
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              data-testid="avatar-input"
              onChange={pickAvatar}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" htmlFor="settings-name">
            <input id="settings-name" className={inputClass} value={form.fullName} onChange={set('fullName')} maxLength={200} />
          </Field>
          <Field label="Email" htmlFor="settings-email" hint="Change it under Account.">
            <input id="settings-email" className={inputClass} value={profile.email} disabled />
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard title="Travel preferences" description="Your usual starting point and how you like prices shown.">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Home city" htmlFor="settings-home-city">
            <Autocomplete
              id="settings-home-city"
              value={form.homeCity}
              onChange={setText('homeCity')}
              fetchOptions={fetchCities}
              placeholder="e.g. New York"
              maxLength={200}
            />
          </Field>
          <Field label="Home airport" htmlFor="settings-home-airport" hint="Type a code, airport or city">
            <Autocomplete
              id="settings-home-airport"
              value={form.homeAirport}
              onChange={setText('homeAirport')}
              fetchOptions={fetchAirports}
              placeholder="JFK"
              maxLength={60}
            />
          </Field>
          <Field label="Currency" htmlFor="settings-currency">
            <select id="settings-currency" className={inputClass} value={form.preferredCurrency} onChange={set('preferredCurrency')}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Default travelers" htmlFor="settings-travelers">
            <input
              id="settings-travelers"
              type="number"
              min={1}
              max={20}
              className={inputClass}
              value={form.defaultTravelers}
              onChange={set('defaultTravelers')}
            />
          </Field>
        </div>
      </SettingsCard>

      <div className="flex items-center gap-4">
        <PrimaryButton type="submit" busy={busy} disabled={!dirty}>
          Save changes
        </PrimaryButton>
        {status && <Status kind={status.kind}>{status.text}</Status>}
      </div>
    </form>
  );
}
