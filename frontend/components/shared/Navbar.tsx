'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import LoginModal from '@/components/shared/LoginModal';

type NavbarProps = {
  minimal?: boolean;
  /**
   * Optional content rendered on the right side of the bar, just before the
   * auth corner (results page passes its view tabs here so Flowchart /
   * Calendar / Schedule / Map live in the navbar instead of eating a row of
   * the page). Visually adjacent to — but independent of — the auth button.
   */
  tabs?: React.ReactNode;
};

export default function Navbar({ minimal = false, tabs }: NavbarProps) {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
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

  const initials = (() => {
    const name = user?.user_metadata?.full_name as string | undefined;
    if (name) {
      return name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    }
    return (user?.email?.[0] ?? '?').toUpperCase();
  })();

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-6 py-2.5"
      style={{ background: '#2563eb' }}
    >
      {/* Logo */}
      {!minimal ? (
        <Link href="/" className="text-lg font-bold tracking-tight text-white">
          VOYZA
        </Link>
      ) : (
        <div />
      )}

      {/* Center — optional page tabs (results view switcher), truly centered
          regardless of how wide the logo / auth sides are */}
      {tabs && (
        <div className="absolute left-1/2 -translate-x-1/2">{tabs}</div>
      )}

      {/* Right side — the auth corner */}
      <div className="flex items-center gap-4">
      {user ? (
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-medium transition-opacity hover:opacity-80"
            style={{ background: 'rgba(255,255,255,0.2)' }}
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
      ) : (
        // Single entry point: the LoginModal already offers Google, email
        // sign-in, AND "Create account" — a separate Sign up button was
        // redundant chrome.
        <button
          onClick={() => setLoginOpen(true)}
          className="px-4 py-1.5 rounded-full text-sm font-medium border border-white/30 text-white hover:bg-white/10 transition-colors"
        >
          Log in
        </button>
      )}
      </div>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </nav>
  );
}
