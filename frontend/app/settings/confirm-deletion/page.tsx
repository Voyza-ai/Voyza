'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { confirmAccountDeletion } from '@/lib/api';

/**
 * Step 2 of account deletion — the page the emailed link opens. Works
 * signed out (the token is the credential). Deletion only happens on the
 * button press (a POST), never on page load, so mail scanners that prefetch
 * links can't trigger it.
 */
export default function ConfirmDeletionPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmDeletionInner />
    </Suspense>
  );
}

const niceDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

function ConfirmDeletionInner() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>(token ? 'idle' : 'error');
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [error, setError] = useState<string>(
    token ? '' : 'This confirmation link is incomplete. Request a new one from Settings → Account.',
  );

  const confirm = async () => {
    setState('busy');
    try {
      const res = await confirmAccountDeletion(token);
      setScheduledAt(res.scheduledDeletionAt);
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — try again.');
      setState('error');
    }
  };

  return (
    <main className="min-h-screen flex items-start justify-center px-4 pt-24" style={{ background: '#f0f4f8' }}>
      <div className="w-full max-w-md">
        <Link href="/main" className="block text-center text-xl font-bold text-[#2563eb] mb-6">
          BlueMurr
        </Link>
        <div className="bg-white rounded-2xl border border-gray-100 p-7">
          {(state === 'idle' || state === 'busy') && (
            <>
              <div className="flex items-center gap-2.5 mb-3">
                <AlertTriangle size={20} className="text-red-500" />
                <h1 className="text-lg font-semibold text-gray-900">Confirm account deletion</h1>
              </div>
              <p className="text-[13px] text-gray-600 mb-6">
                Your account will be scheduled for permanent deletion in 30 days. Until then everything keeps
                working and you can cancel from Settings → Account. After that, your name, email and personal
                details are erased for good.
              </p>
              <div className="flex gap-2 justify-end">
                <Link
                  href="/settings?tab=account"
                  className="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  Keep my account
                </Link>
                <button
                  onClick={confirm}
                  disabled={state === 'busy'}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {state === 'busy' && <Loader2 size={13} className="animate-spin" />}
                  Delete my account
                </button>
              </div>
            </>
          )}

          {state === 'done' && scheduledAt && (
            <>
              <h1 className="text-lg font-semibold text-gray-900 mb-3">Deletion scheduled</h1>
              <p className="text-[13px] text-gray-600 mb-6">
                Your account will be permanently deleted on{' '}
                <span className="font-medium text-gray-900">{niceDate(scheduledAt)}</span>. Changed your mind? Sign
                in and choose &ldquo;Keep my account&rdquo; in Settings → Account before then.
              </p>
              <div className="flex justify-end">
                <Link
                  href="/settings?tab=account"
                  className="px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-[#2563eb] hover:bg-[#1d4ed8] transition-colors"
                >
                  Go to Settings
                </Link>
              </div>
            </>
          )}

          {state === 'error' && (
            <>
              <h1 className="text-lg font-semibold text-gray-900 mb-3">Link not valid</h1>
              <p role="alert" className="text-[13px] text-gray-600 mb-6">
                {error}
              </p>
              <div className="flex justify-end">
                <Link
                  href="/settings?tab=account"
                  className="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 transition-colors"
                >
                  Go to Settings
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
