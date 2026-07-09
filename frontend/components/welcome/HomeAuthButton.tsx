'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { User } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';

type HomeAuthButtonProps = {
  /** Opens the LoginModal (owned by the welcome page). */
  onLoginClick: () => void;
  /** 'dark' (default) for the old dark hero; 'light' for the paper landing. */
  variant?: 'dark' | 'light';
};

/**
 * Auth-aware corner button for the welcome page.
 *
 * The welcome page doesn't render the shared Navbar (it has its own
 * dark, animated hero layout), so before this component it showed a
 * hardcoded "Log in" button forever — even for signed-in users, which
 * made successful Google sign-ins look like they silently failed.
 *
 * Logged out → the original "Log in" pill (opens LoginModal).
 * Logged in  → initials avatar with the same dropdown actions as the
 * Navbar (My Trips / Sign out), styled for the dark hero background.
 */
export default function HomeAuthButton({ onLoginClick, variant = 'dark' }: HomeAuthButtonProps) {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click — same pattern as Navbar.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClick);
    }
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropdownOpen]);

  if (!user) {
    const pill =
      variant === 'light'
        ? 'bg-white border border-gray-200 text-gray-600 hover:text-gray-900 hover:border-gray-300 shadow-sm'
        : 'bg-white/10 backdrop-blur-sm border border-white/15 text-white/70 hover:text-white hover:bg-white/15';
    return (
      <button
        onClick={onLoginClick}
        className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all ${pill}`}
      >
        <User size={16} />
        <span>Log in</span>
      </button>
    );
  }

  const name = user.user_metadata?.full_name as string | undefined;
  const initials = name
    ? name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : (user.email?.[0] ?? '?').toUpperCase();

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium transition-all ${
          variant === 'light'
            ? 'text-white shadow-sm hover:brightness-110'
            : 'bg-white/10 backdrop-blur-sm border border-white/15 text-white hover:bg-white/20'
        }`}
        style={variant === 'light' ? { background: '#2e6bc4' } : undefined}
        aria-label="Account menu"
      >
        {initials}
      </button>

      {dropdownOpen && (
        <div className="absolute right-0 top-full mt-2 w-52 bg-white rounded-lg shadow-lg border border-gray-100 py-1 z-50">
          <div className="px-3 py-2 border-b border-gray-100">
            <p className="text-xs text-gray-400 truncate">{user.email}</p>
          </div>
          <Link
            href="/history"
            onClick={() => setDropdownOpen(false)}
            className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            My Trips
          </Link>
          <div className="border-t border-gray-100" />
          <button
            onClick={() => {
              setDropdownOpen(false);
              signOut();
            }}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
