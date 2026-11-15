'use client';

import { useState } from 'react';
import { resendConfirmation } from '@/lib/authEmail';

/**
 * Shown in place of Supabase's bare "Email not confirmed" when signing in to
 * an account that was never confirmed: says what to do, and can send the
 * confirmation email again.
 */
export default function UnconfirmedEmailNotice({ email, next }: { email: string; next?: string | null }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | string>('idle');
  const send = async () => {
    setState('sending');
    const err = await resendConfirmation(email, next);
    setState(err ? err : 'sent');
  };
  const failed = state !== 'idle' && state !== 'sending' && state !== 'sent';
  return (
    <div
      role="alert"
      className="rounded-lg px-3 py-2.5 text-sm"
      style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' }}
    >
      <p>
        Please confirm your email first. We sent a link to <strong>{email}</strong> when you signed up.
      </p>
      {state === 'sent' ? (
        <p className="mt-1.5 font-medium">Sent. Check your inbox (and spam) for the new link.</p>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={state === 'sending'}
          className="mt-1.5 font-medium underline disabled:opacity-50"
        >
          {state === 'sending' ? 'Sending…' : 'Resend confirmation email'}
        </button>
      )}
      {failed && <p className="mt-1.5" style={{ color: '#dc2626' }}>{state}</p>}
    </div>
  );
}
