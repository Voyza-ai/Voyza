'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { track } from '@/lib/track';

/** One `$pageview` per route the person lands on (lib/track — off without a key). */
export default function PageviewTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) track('$pageview');
  }, [pathname]);
  return null;
}
