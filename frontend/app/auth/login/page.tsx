'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { useTripStore } from '@/store/tripStore';
import { Suspense } from 'react';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirect');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setUser = useAuthStore((s) => s.setUser);
  const setSession = useAuthStore((s) => s.setSession);
  const currentTrip = useTripStore((s) => s.currentTrip);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      setError('Authentication is not configured. Please set up Supabase.');
      return;
    }

    setError(null);
    setLoading(true);

    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    setSession(data.session);
    setUser(data.user);

    if (redirectTo) {
      router.push(redirectTo);
    } else if (currentTrip && currentTrip.cities.length > 0) {
      router.push('/results');
    } else {
      router.push('/history');
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4" style={{ background: '#f0f4f8' }}>
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8">
        <div className="text-center mb-6">
          <Link href="/" className="text-2xl font-bold" style={{ color: '#2563eb' }}>
            VOYZA
          </Link>
          <h1 className="text-gray-900 text-lg font-medium mt-3">Welcome back</h1>
        </div>

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

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 bg-white text-gray-900 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/20 focus:border-[#2563eb] transition-colors pr-10"
                placeholder="Enter your password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
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
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="flex items-center justify-between mt-4 text-sm">
          <Link href="/auth/forgot-password" className="text-gray-500 hover:text-gray-700 transition-colors">
            Forgot password?
          </Link>
        </div>

        <div className="flex items-center gap-3 my-5">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs text-gray-400">or</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        <div className="relative group">
          <button
            disabled
            className="w-full py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-300 bg-gray-50 cursor-not-allowed"
          >
            Continue with Google
          </button>
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            Coming soon
          </div>
        </div>

        <p className="text-center text-sm text-gray-500 mt-5">
          Don&apos;t have an account?{' '}
          <Link href="/auth/signup" className="font-medium hover:underline" style={{ color: '#2563eb' }}>
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
