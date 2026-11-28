'use client';

import { Suspense, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

/**
 * The canvas is the results page now: sharing, live collaboration and
 * rearranging the trip all happen on /results?tripId=…. This address stays
 * so links already sent — invite emails, notifications, share links
 * (/canvas/<id>?share=<token>), bookmarks — still open the trip.
 */
export default function CanvasRedirect() {
  return (
    <Suspense fallback={null}>
      <Redirect />
    </Suspense>
  );
}

function Redirect() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tripId = params.tripId as string;
  const share = searchParams.get('share');

  useEffect(() => {
    if (!tripId) return;
    const q = new URLSearchParams({ tripId });
    if (share) q.set('share', share);
    router.replace(`/results?${q.toString()}`);
  }, [tripId, share, router]);

  return (
    <div className="h-screen w-screen flex items-center justify-center" style={{ background: '#f0f4f8' }}>
      <div className="w-8 h-8 border-2 border-[#2563eb] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
