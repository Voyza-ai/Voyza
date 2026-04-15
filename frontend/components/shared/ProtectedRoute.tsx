'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !user) {
      router.push(`/auth/login?redirect=${encodeURIComponent(pathname)}`);
    }
  }, [isLoading, user, router, pathname]);

  if (isLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#2563eb', borderTopColor: 'transparent' }}
          />
        </div>
      </main>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}
