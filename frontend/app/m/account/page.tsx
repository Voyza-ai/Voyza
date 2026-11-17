'use client';

import { useState } from 'react';
import Link from 'next/link';
import { LogOut, Settings, Monitor, ChevronRight } from 'lucide-react';
import MobileTabBar from '@/components/mobile/MobileTabBar';
import { M } from '@/components/mobile/theme';
import { useAuthStore } from '@/store/authStore';
import LoginModal from '@/components/shared/LoginModal';

/**
 * Account on a phone: sign in / out. Profile, privacy, notifications and
 * account deletion open the existing /settings page (see docs/mobile/PLAN.md).
 */
export default function MobileAccount() {
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const signOut = useAuthStore((s) => s.signOut);
  const [loginOpen, setLoginOpen] = useState(false);

  const row = (href: string, label: string, Icon: typeof Settings) => (
    <Link href={href} className="min-h-[56px] flex items-center gap-3 px-4 border-b last:border-b-0 text-[16px] text-gray-800" style={{ borderColor: M.line }}>
      <Icon size={19} className="text-gray-500" />
      <span className="flex-1">{label}</span>
      <ChevronRight size={18} className="text-gray-400" />
    </Link>
  );

  return (
    <main className="pb-28 px-4" style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }} data-testid="m-account">
      <h1 className="px-1 pt-2 text-[28px] font-semibold text-gray-900">Account</h1>
      <div className="mt-5 rounded-3xl bg-white border p-5" style={{ borderColor: M.line }}>
        {isLoading ? (
          <div className="h-12" />
        ) : user ? (
          <>
            <div className="text-[13px] text-gray-500">Signed in as</div>
            <div className="text-[17px] font-semibold text-gray-900 truncate">{user.email}</div>
            <button onClick={() => signOut()} className="mt-4 w-full min-h-[48px] flex items-center justify-center gap-2 rounded-2xl border text-[15px] text-gray-700" style={{ borderColor: M.line }}>
              <LogOut size={17} /> Sign out
            </button>
          </>
        ) : (
          <>
            <p className="text-[15px] text-gray-600">Sign in to save trips, share them and plan together.</p>
            <button onClick={() => setLoginOpen(true)} className="mt-4 w-full min-h-[50px] rounded-2xl text-white text-[16px] font-semibold" style={{ background: M.blue }}>
              Sign in or create an account
            </button>
          </>
        )}
      </div>
      <div className="mt-4 rounded-3xl bg-white border overflow-hidden" style={{ borderColor: M.line }}>
        {user && row('/settings', 'Profile, privacy & notifications', Settings)}
        {row('/main', 'Open the desktop site', Monitor)}
        {row('/m/demo', 'See the demo trip', ChevronRight)}
      </div>
      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={() => setLoginOpen(false)} />
      <MobileTabBar />
    </main>
  );
}
