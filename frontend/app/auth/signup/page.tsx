'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff, Mail } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { confirmRedirectUrl, resendConfirmation, safeReturnPath } from '@/lib/authEmail';
import { track } from '@/lib/track';

function getPasswordStrength(pw: string): { label: string; color: string; width: string } {
  if (!pw || pw.length < 8) return { label: 'Weak', color: '#dc2626', width: '33%' };
  const hasNumber = /\d/.test(pw);
  const hasSpecial = /[^a-zA-Z0-9]/.test(pw);
  if (hasNumber && hasSpecial) return { label: 'Strong', color: '#16a34a', width: '100%' };
  if (hasNumber) return { label: 'Medium', color: '#d97706', width: '66%' };
  return { label: 'Weak', color: '#dc2626', width: '33%' };
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupInner />
    </Suspense>
  );
}

function SignupInner() {
  const router = useRouter();
  // Where to go once signed in (e.g. the shared trip that asked for an
  // account). Carried through the confirmation email.
  const next = safeReturnPath(useSearchParams().get('next'));
  /** Set once the account is made but its email still needs confirming. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resend, setResend] = useState<'idle' | 'sending' | 'sent' | string>('idle');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setUser = useAuthStore((s) => s.setUser);
  const setSession = useAuthStore((s) => s.setSession);

  const strength = getPasswordStrength(password);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) {
      setError('Authentication is not configured. Please set up Supabase.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setError(null);
    setLoading(true);

    const { data, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: confirmRedirectUrl(next),
      },
    });

    setLoading(false);
    track(authError ? 'signup_failed' : 'signed_up');

    if (authError) {
      setError(authError.message);
      return;
    }

    // No session = the project requires email confirmation. Before, the page
    // went on to My Trips signed out, and the next sign-in failed with a bare
    // "Email not confirmed".
    if (!data.session) {
      setSentTo(email.trim());
      return;
    }
    setSession(data.session);
    setUser(data.user);
    router.push(next ?? '/history');
  };

  if (sentTo) {
    const doResend = async () => {
      setResend('sending');
      const err = await resendConfirmation(sentTo, next);
      setResend(err ? err : 'sent');
    };
    return (
      <main className="min-h-screen flex items-center justify-center px-4" style={{ background: '#f0f4f8' }}>
        <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
          <Link href="/" className="text-2xl font-bold" style={{ color: '#2563eb' }}>
            BlueMurr
          </Link>
          <div className="mx-auto mt-5 mb-3 w-12 h-12 rounded-full flex items-center justify-center bg-blue-50">
            <Mail size={22} className="text-[#2563eb]" />
          </div>
          <h1 className="text-gray-900 text-lg font-medium">Check your email</h1>
          <p className="text-sm text-gray-500 mt-2">
            We sent a confirmation link to <strong className="text-gray-800">{sentTo}</strong>. Click it to finish
            creating your account{next ? ' and go straight back to the trip' : ''}.
          </p>
          <p className="text-xs text-gray-400 mt-3">Not there after a minute? Check your spam folder.</p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={doResend}
              disabled={resend === 'sending' || resend === 'sent'}
              className="w-full py-2.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {resend === 'sending' ? 'Sending…' : resend === 'sent' ? 'Sent again' : 'Resend email'}
            </button>
            <Link
              href={next ? `/auth/login?redirect=${encodeURIComponent(next)}` : '/auth/login'}
              className="block w-full py-2.5 rounded-lg text-sm font-medium text-white"
              style={{ background: '#2563eb' }}
            >
              I've confirmed, sign in
            </Link>
          </div>
          {resend !== 'idle' && resend !== 'sending' && resend !== 'sent' && (
            <p className="text-sm mt-3" style={{ color: '#dc2626' }}>{resend}</p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4" style={{ background: '#f0f4f8' }}>
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8">
        <div className="text-center mb-6">
          <Link href="/" className="text-2xl font-bold" style={{ color: '#2563eb' }}>
            BlueMurr
          </Link>
          <h1 className="text-gray-900 text-lg font-medium mt-3">Create your account</h1>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="fullName" className="block text-sm font-medium text-gray-700 mb-1">
              Full name
            </label>
            <input
              id="fullName"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 bg-white text-gray-900 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/20 focus:border-[#2563eb] transition-colors"
              placeholder="Jane Doe"
              required
            />
          </div>

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
                placeholder="At least 8 characters"
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
            {password && (
              <div className="mt-2">
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{ width: strength.width, background: strength.color }}
                  />
                </div>
                <p className="text-xs mt-1" style={{ color: strength.color }}>
                  {strength.label}
                </p>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
              Confirm password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 bg-white text-gray-900 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/20 focus:border-[#2563eb] transition-colors"
              placeholder="Re-enter your password"
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
            {loading ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-5">
          Already have an account?{' '}
          <Link href={next ? `/auth/login?redirect=${encodeURIComponent(next)}` : '/auth/login'} className="font-medium hover:underline" style={{ color: '#2563eb' }}>
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
