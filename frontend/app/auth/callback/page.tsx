'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { Suspense } from 'react';

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <AuthCallbackInner />
    </Suspense>
  );
}

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const setUser = useAuthStore((s) => s.setUser);
  const setSession = useAuthStore((s) => s.setSession);

  useEffect(() => {
    const code = searchParams.get('code');
    if (!code) {
      setError('No verification code found in URL');
      return;
    }

    if (!supabase) {
      setError('Authentication is not configured');
      return;
    }

    supabase.auth
      .exchangeCodeForSession(code)
      .then(({ data, error: authError }) => {
        if (authError) {
          setError(authError.message);
          return;
        }
        setSession(data.session);
        setUser(data.user);

        // Return the user to where they were before the OAuth bounce.
        // LoginModal stashes the pre-OAuth location in sessionStorage.
        // Fall back to /history for users who arrived at callback
        // without a return-to set (e.g. direct sign-up link).
        let returnTo = '/history';
        try {
          const saved = sessionStorage.getItem('voyza.oauth_return_to');
          if (saved && saved.startsWith('/')) {
            returnTo = saved;
          }
          sessionStorage.removeItem('voyza.oauth_return_to');
        } catch {
          // sessionStorage unavailable (SSR, privacy mode) — use default.
        }
        router.push(returnTo);
      });
  }, [searchParams, router, setUser, setSession]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4" style={{ background: '#f0f4f8' }}>
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
        {error ? (
          <>
            <div className="rounded-lg px-3 py-2.5 text-sm mb-4" style={{ background: '#fef2f2', color: '#dc2626' }}>
              {error}
            </div>
            <Link
              href="/auth/login"
              className="text-sm font-medium hover:underline"
              style={{ color: '#2563eb' }}
            >
              Back to sign in
            </Link>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div
              className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#2563eb', borderTopColor: 'transparent' }}
            />
            <p className="text-gray-500 text-sm">Verifying...</p>
          </div>
        )}
      </div>
    </main>
  );
}
