'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { readCanvasIntent, clearCanvasIntent, resolveCanvasTripId } from '@/lib/canvasHandoff';
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
    if (!supabase) {
      setError('Authentication is not configured');
      return;
    }

    // Post-OAuth flow. There's a subtle race with Supabase's client:
    // `createClient` defaults to `detectSessionInUrl: true`, which means
    // the client auto-parses `?code=...` on page load, exchanges it,
    // persists the session, and clears the query string — all before
    // our React effect runs. So by the time we check searchParams, the
    // code is already gone even though sign-in actually succeeded.
    //
    // Strategy:
    //   1. Ask the client for the current session. If auto-detect did
    //      its thing, we already have one — just redirect.
    //   2. If no session yet, the URL may still contain a `?code=` that
    //      auto-detect hasn't processed (slower devices, StrictMode
    //      double-mount, etc.) — try a manual exchange.
    //   3. Only fall through to an error if both fail.
    const finish = (session: any, user: any) => {
      setSession(session);
      setUser(user);

      // Did the user start an "Edit in Canvas" flow before signing in? If so,
      // save the trip (now that we're authenticated) and go straight to the
      // canvas instead of the page they came from.
      const canvasIntent = readCanvasIntent();
      if (canvasIntent) {
        clearCanvasIntent();
        resolveCanvasTripId(canvasIntent)
          .then((tripId) => {
            if (!tripId) return router.push('/history');
            router.push(
              canvasIntent.destination === 'results'
                ? `/results?tripId=${tripId}`
                : `/canvas/${tripId}`,
            );
          })
          .catch(() => router.push('/history'));
        return;
      }

      // Default to the hub, not My Trips: someone who just signed in wants the
      // three front doors (Browse / Describe / View or edit trips), not one of
      // them picked for them.
      let returnTo = '/main';
      try {
        const saved = sessionStorage.getItem('voyza.oauth_return_to');
        // StrictMode double-invokes this effect in dev, so the second run finds this already removed and a deep-link sign-in lands on /main locally; a production build correctly returns to the trip.
        sessionStorage.removeItem('voyza.oauth_return_to');
        // LoginModal stores whatever page the modal was opened from, which is
        // right for a deep link ("/results?tripId=…" → back to that trip) but
        // wrong for the pages you sign in *from*. The landing page and the
        // auth screens aren't destinations — returning there just looks like
        // the sign-in did nothing. Send those to the hub instead.
        //
        // "starts with /" alone is NOT enough to prove a path is local:
        // "//evil.com" is protocol-relative, browsers normalise "/\evil.com"
        // the same way, and the URL parser strips tabs and newlines, so
        // "/\t/evil.com" becomes "//evil.com". Rather than pattern-match every
        // shape, resolve it exactly as the browser will and require the
        // result to stay on this origin.
        if (saved) {
          const url = new URL(saved, window.location.origin);
          const isDestination =
            url.origin === window.location.origin &&
            url.pathname !== '/' &&
            !url.pathname.startsWith('/auth/');
          if (isDestination) returnTo = url.pathname + url.search + url.hash;
        }
      } catch {
        // sessionStorage unavailable (SSR, privacy mode) — use default.
      }
      router.push(returnTo);
    };

    (async () => {
      // 1. Did auto-detect already capture the session?
      const { data: existing } = await supabase.auth.getSession();
      if (existing?.session) {
        finish(existing.session, existing.session.user);
        return;
      }

      // 2. Fallback: manual exchange if the code is still in the URL.
      const code = searchParams.get('code');
      if (code) {
        const { data, error: authError } = await supabase.auth.exchangeCodeForSession(code);
        if (authError) {
          setError(authError.message);
          return;
        }
        finish(data.session, data.user);
        return;
      }

      // 3. No session, no code — something upstream went wrong. Wait
      //    one tick for any in-flight auto-detect to land, then retry
      //    getSession once before giving up.
      await new Promise((r) => setTimeout(r, 500));
      const { data: retry } = await supabase.auth.getSession();
      if (retry?.session) {
        finish(retry.session, retry.session.user);
        return;
      }
      setError('No verification code found in URL. Please try signing in again.');
    })();
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
