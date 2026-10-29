import type { Metadata } from 'next';
import { SITE_URL } from '@/lib/site';

// /browse is a client page; its SEO metadata lives in this server layout.
export const metadata: Metadata = {
  title: 'Browse Trip Itineraries — Ready-Made Trips from NYC | BlueMurr',
  description:
    'Hand-picked and AI-crafted multi-city itineraries with real hotels, routes, and prices. Filter by vibe, budget, and length, then make any trip your own.',
  alternates: { canonical: `${SITE_URL}/browse` },
};

export default function BrowseLayout({ children }: { children: React.ReactNode }) {
  return children;
}
