'use client';

import { Suspense, useEffect, useState } from 'react';
import MobileTrip from '@/components/mobile/MobileTrip';
import { useTripStore } from '@/store/tripStore';
import { installDemoApi, demoTrip, type DemoChatScript } from '@/components/mobile/demoApi';
import type { Trip } from '@/lib/types';
import rawTrip from '@/data/mobile-demo/demoTrip.json';
import chatScript from '@/data/mobile-demo/demoChat.json';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * A saved sample trip (New York → Paris → London, 2 travellers, recorded from
 * a real planner run) that works with no backend: the app's /api calls are
 * answered from fixtures in the browser, so a branch preview on a phone can
 * click through every screen, including a scripted BlueMurr AI proposal.
 */
export default function MobileDemoPage() {
  // The fixture API goes in before the trip screen mounts (so none of its
  // effects can reach the network), and the trip is in the store before the
  // screen first reads it. Rendering waits for both, client-side only.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const { trip, dayShift } = demoTrip(rawTrip as unknown as Trip);
    useTripStore.getState().setTrip(trip);
    const uninstall = installDemoApi(API_BASE, chatScript as DemoChatScript, dayShift);
    setReady(true);
    return uninstall;
  }, []);
  if (!ready) return null;

  return (
    <Suspense fallback={null}>
      <MobileTrip demo />
    </Suspense>
  );
}
