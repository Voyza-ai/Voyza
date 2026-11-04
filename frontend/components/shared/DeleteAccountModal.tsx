'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Mail, X } from 'lucide-react';
import {
  getCurrentUser,
  requestAccountDeletion,
  cancelAccountDeletion,
} from '@/lib/api';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** Called after the account's deletion state changes (e.g. cancelled). */
  onChanged?: () => void;
};

type View = 'loading' | 'confirm' | 'emailSent' | 'scheduled' | 'error';

const niceDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

/**
 * The "Delete account" flow (profile menu + Settings → Account).
 *
 * States, resolved on open from GET /users/me:
 *  - active account   → explain the 30-day grace period + "Email me a link"
 *  - emailSent        → step 1 done: nothing is scheduled until the user
 *                       clicks the emailed link (/settings/confirm-deletion)
 *  - pending_deletion → show the countdown + "Keep my account" (cancel)
 *
 * Confirming the link schedules anonymization 30 days out (GDPR erasure) —
 * the user stays signed in through the grace period and can cancel from
 * here any time. A self-notification with the same info lands in the bell.
 */
export default function DeleteAccountModal({ isOpen, onClose, onChanged }: Props) {
  const [view, setView] = useState<View>('loading');
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let disposed = false;
    setView('loading');
    getCurrentUser()
      .then((me) => {
        if (disposed) return;
        if (me.accountStatus === 'pending_deletion') {
          setScheduledAt(me.scheduledDeletionAt ?? null);
          setView('scheduled');
        } else {
          setView('confirm');
        }
      })
      .catch(() => {
        if (disposed) return;
        setErrorText(null);
        setView('error');
      });
    return () => {
      disposed = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await requestAccountDeletion();
      if (res.alreadyScheduled) {
        setScheduledAt(res.scheduledDeletionAt ?? null);
        setView('scheduled');
      } else {
        setSentTo(res.email ?? null);
        setView('emailSent');
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : null);
      setView('error');
    } finally {
      setBusy(false);
    }
  };

  const handleKeep = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await cancelAccountDeletion();
      onChanged?.();
      onClose();
    } catch {
      setView('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <X size={18} />
        </button>

        {view === 'loading' && (
          <div className="py-10 flex items-center justify-center text-gray-400">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {view === 'confirm' && (
          <>
            <div className="flex items-center gap-2.5 mb-3">
              <AlertTriangle size={20} className="text-red-500" />
              <h2 className="text-lg font-semibold text-gray-900">Delete your account?</h2>
            </div>
            <div className="text-[13px] text-gray-600 space-y-2.5 mb-5">
              <p>
                We&apos;ll email you a confirmation link first — nothing happens until you
                click it. Once confirmed, your account is scheduled for permanent deletion with
                a <span className="font-medium text-gray-800">30-day grace period</span> to
                change your mind: you stay signed in and can cancel from Settings any time
                before then.
              </p>
              <p>
                After 30 days, your name, email, and personal details are permanently erased.
                Trips you shared with others stay available to them (without your identity), and
                collaborators are offered their own copy.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Keep my account
              </button>
              <button
                onClick={handleDelete}
                disabled={busy}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                Email me a confirmation link
              </button>
            </div>
          </>
        )}

        {view === 'emailSent' && (
          <>
            <div className="flex items-center gap-2.5 mb-3">
              <Mail size={20} className="text-[#2563eb]" />
              <h2 className="text-lg font-semibold text-gray-900">Check your email</h2>
            </div>
            <p className="text-[13px] text-gray-600 mb-5">
              We sent a confirmation link to{' '}
              <span className="font-medium text-gray-800">{sentTo ?? 'your email address'}</span>.
              Your account is only scheduled for deletion once you open it and confirm. The link
              expires in 24 hours.
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Close
              </button>
            </div>
          </>
        )}

        {view === 'scheduled' && (
          <>
            <div className="flex items-center gap-2.5 mb-3">
              <AlertTriangle size={20} className="text-amber-500" />
              <h2 className="text-lg font-semibold text-gray-900">Deletion scheduled</h2>
            </div>
            <p className="text-[13px] text-gray-600 mb-5">
              Your account will be permanently deleted on{' '}
              <span className="font-medium text-gray-800">{niceDate(scheduledAt)}</span>. Until
              then everything keeps working — and you can call the whole thing off right here.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleKeep}
                disabled={busy}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-[#2563eb] hover:brightness-110 disabled:opacity-50 transition-all"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                Keep my account
              </button>
            </div>
          </>
        )}

        {view === 'error' && (
          <p className="py-6 text-center text-[13px] text-gray-500">
            {errorText || 'Something went wrong — close this and try again.'}
          </p>
        )}
      </div>
    </div>
  );
}
