'use client';

import { useState } from 'react';
import Link from 'next/link';
import { User } from 'lucide-react';
import LoginModal from './LoginModal';

type NavbarProps = {
  minimal?: boolean;
};

export default function Navbar({ minimal = false }: NavbarProps) {
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <>
      <nav
        className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-6 py-2.5 backdrop-blur-md border-b border-white/5"
        style={{ background: 'rgba(15,15,26,0.78)' }}
      >
        {/* Logo */}
        {!minimal ? (
          <Link
            href="/"
            className="text-lg font-bold tracking-tight"
            style={{ color: '#4f8ef7' }}
          >
            VOYZA
          </Link>
        ) : (
          <div />
        )}

        {/* Login button */}
        <button
          onClick={() => setLoginOpen(true)}
          className="flex items-center gap-2 border border-voyza-border text-white/80 hover:text-white hover:border-white/30 px-4 py-2 rounded-full text-sm transition-all"
        >
          <User size={16} />
          <span>Log in</span>
        </button>
      </nav>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </>
  );
}
