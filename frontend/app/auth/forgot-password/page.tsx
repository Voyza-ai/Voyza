'use client';

import { useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      setError('Authentication is not configured. Please set up Supabase.');
      return;
    }

    setError(null);
    setLoading(true);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback`,
    });

    setLoading(false);

    if (resetError) {
      setError(resetError.message);
      return;
    }

    setSent(true);
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4" style={{ background: '#f0f4f8' }}>
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8">
        <div className="text-center mb-6">
          <Link href="/" className="text-2xl font-bold" style={{ color: '#2563eb' }}>
            VOYZA
          </Link>
        </div>

        {sent ? (
          <div className="text-center">
            <div className="rounded-lg px-4 py-3 mb-4" style={{ background: '#f0fdf4', color: '#16a34a' }}>
              Check your email for a reset link
            </div>
            <p className="text-sm text-gray-500 mb-4">
              We sent a password reset link to <strong className="text-gray-700">{email}</strong>
            </p>
            <Link
              href="/auth/login"
              className="text-sm font-medium hover:underline"
              style={{ color: '#2563eb' }}
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-gray-900 text-lg font-medium text-center mb-4">Reset your password</h1>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 bg-white text-gray-900 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/20 focus:border-[#2563eb] transition-colors"
                  placeholder="you@example.com"
                  required
                />
              </div>

              {error && (
                <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: '#fef2f2', color: '#dc2626' }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-medium text-white transition-all disabled:opacity-50"
                style={{ background: '#2563eb' }}
              >
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
            </form>

            <p className="text-center text-sm text-gray-500 mt-5">
              <Link href="/auth/login" className="font-medium hover:underline" style={{ color: '#2563eb' }}>
                Back to sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
