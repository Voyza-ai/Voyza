'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import type { UserProfile } from '@/lib/api';
import DeleteAccountModal from '@/components/shared/DeleteAccountModal';
import { SettingsCard, Field, inputClass, PrimaryButton, Status } from './ui';

type Msg = { kind: 'ok' | 'error'; text: string } | null;

const niceDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

export const MIN_PASSWORD_LENGTH = 8;

export default function AccountTab({
  profile,
  onAccountChanged,
}: {
  profile: UserProfile;
  onAccountChanged: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const providers: string[] = (user?.app_metadata?.providers as string[] | undefined) ?? [];
  // Google-only accounts have no password yet — they set one, no current needed.
  const hasPassword =
    providers.includes('email') || !!user?.identities?.some((i) => i.provider === 'email') || providers.length === 0;
  const pendingEmail = (user as { new_email?: string } | null)?.new_email ?? null;

  // ── Email ──
  const [newEmail, setNewEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<Msg>(null);

  const changeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      setEmailMsg({ kind: 'error', text: 'Enter a valid email address.' });
      return;
    }
    if (next === profile.email.toLowerCase()) {
      setEmailMsg({ kind: 'error', text: 'That is already your email address.' });
      return;
    }
    setEmailBusy(true);
    setEmailMsg(null);
    try {
      const { data, error } = await supabase.auth.updateUser(
        { email: next },
        { emailRedirectTo: `${window.location.origin}/settings?tab=account` },
      );
      if (error) throw error;
      if (data?.user) useAuthStore.getState().setUser(data.user);
      setNewEmail('');
      setEmailMsg({
        kind: 'ok',
        text: `Check ${next} for a confirmation link. Your email changes once it's confirmed (Supabase may also ask you to confirm from your current address).`,
      });
    } catch (err) {
      setEmailMsg({ kind: 'error', text: err instanceof Error ? err.message : 'Could not start the email change.' });
    } finally {
      setEmailBusy(false);
    }
  };

  // ── Password ──
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<Msg>(null);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < MIN_PASSWORD_LENGTH) {
      setPwMsg({ kind: 'error', text: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }
    if (next !== confirm) {
      setPwMsg({ kind: 'error', text: "The new passwords don't match." });
      return;
    }
    setPwBusy(true);
    setPwMsg(null);
    try {
      if (hasPassword) {
        // Re-check the current password before allowing a change.
        const { error } = await supabase.auth.signInWithPassword({ email: profile.email, password: current });
        if (error) {
          setPwMsg({ kind: 'error', text: 'Your current password is incorrect.' });
          return;
        }
      }
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw error;
      setCurrent('');
      setNext('');
      setConfirm('');
      setPwMsg({ kind: 'ok', text: 'Password updated. Use it next time you sign in.' });
    } catch (err) {
      setPwMsg({ kind: 'error', text: err instanceof Error ? err.message : 'Could not update your password.' });
    } finally {
      setPwBusy(false);
    }
  };

  // ── Delete ──
  const [deleteOpen, setDeleteOpen] = useState(false);
  const pending = profile.accountStatus === 'pending_deletion';

  return (
    <div className="space-y-5">
      <SettingsCard title="Email address" description={<>You sign in with <span className="font-medium text-gray-700">{profile.email}</span>.</>}>
        {pendingEmail && (
          <p className="text-[13px] text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-4">
            Waiting for confirmation of <span className="font-medium">{pendingEmail}</span>.
          </p>
        )}
        <form onSubmit={changeEmail} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="New email" htmlFor="settings-new-email">
              <input
                id="settings-new-email"
                type="email"
                className={inputClass}
                value={newEmail}
                onChange={(e) => {
                  setEmailMsg(null);
                  setNewEmail(e.target.value);
                }}
                placeholder="you@example.com"
              />
            </Field>
          </div>
          <PrimaryButton type="submit" busy={emailBusy} disabled={!newEmail.trim()}>
            Change email
          </PrimaryButton>
        </form>
        {emailMsg && <div className="mt-3"><Status kind={emailMsg.kind}>{emailMsg.text}</Status></div>}
      </SettingsCard>

      <SettingsCard
        title={hasPassword ? 'Password' : 'Set a password'}
        description={hasPassword ? undefined : 'You sign in with Google. Add a password to also sign in with your email.'}
      >
        <form onSubmit={changePassword} className="grid grid-cols-3 gap-4 items-end">
          {hasPassword && (
            <Field label="Current password" htmlFor="settings-current-password">
              <input
                id="settings-current-password"
                type="password"
                autoComplete="current-password"
                className={inputClass}
                value={current}
                onChange={(e) => {
                  setPwMsg(null);
                  setCurrent(e.target.value);
                }}
              />
            </Field>
          )}
          <Field label="New password" htmlFor="settings-new-password">
            <input
              id="settings-new-password"
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={next}
              onChange={(e) => {
                setPwMsg(null);
                setNext(e.target.value);
              }}
            />
          </Field>
          <Field label="Confirm new password" htmlFor="settings-confirm-password">
            <input
              id="settings-confirm-password"
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={confirm}
              onChange={(e) => {
                setPwMsg(null);
                setConfirm(e.target.value);
              }}
            />
          </Field>
          <div className="col-span-3 flex items-center gap-4">
            <PrimaryButton type="submit" busy={pwBusy} disabled={!next || !confirm || (hasPassword && !current)}>
              Update password
            </PrimaryButton>
            {pwMsg && <Status kind={pwMsg.kind}>{pwMsg.text}</Status>}
          </div>
        </form>
      </SettingsCard>

      <SettingsCard title="Delete account" tone="danger">
        {pending ? (
          <div className="flex items-center justify-between gap-6">
            <p className="text-[13px] text-gray-600">
              Your account is scheduled for deletion on{' '}
              <span className="font-medium text-gray-900">{niceDate(profile.scheduledDeletionAt)}</span>. Until then
              everything keeps working.
            </p>
            <button
              onClick={() => setDeleteOpen(true)}
              className="shrink-0 px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-[#2563eb] hover:bg-[#1d4ed8] transition-colors"
            >
              Keep my account
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-6">
            <p className="text-[13px] text-gray-600">
              We&apos;ll email you a link to confirm. After confirming you have 30 days to change your mind, then your
              personal details are permanently erased.
            </p>
            <button
              onClick={() => setDeleteOpen(true)}
              className="shrink-0 px-4 py-2 rounded-lg text-[13px] font-medium text-red-600 border border-red-200 hover:bg-red-50 transition-colors"
            >
              Delete account
            </button>
          </div>
        )}
      </SettingsCard>

      <DeleteAccountModal
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onChanged={onAccountChanged}
      />
    </div>
  );
}
