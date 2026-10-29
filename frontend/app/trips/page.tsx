import type { Metadata } from 'next';
import Link from 'next/link';
import Navbar from '@/components/shared/Navbar';
import { fetchCatalogServer } from '@/lib/presetsServer';
import { SITE_URL } from '@/lib/site';

/** Server-rendered index of every category landing page (SEO hub). */

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Trip Ideas & Ready-Made Itineraries | BlueMurr',
  description:
    'Browse ready-made trip itineraries by style — romance, culture, adventure, beaches, food, weekend getaways and more — priced and ready to customize.',
  alternates: { canonical: `${SITE_URL}/trips` },
};

export default async function TripsIndexPage() {
  const catalog = await fetchCatalogServer();
  const bySlug = new Map((catalog?.presets ?? []).map((p) => [p.slug, p]));
  const categories = catalog?.categories ?? [];

  return (
    <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
      <Navbar />
      <div className="pt-20 px-5 pb-16 max-w-5xl mx-auto">
        <h1 className="text-[28px] font-bold text-gray-900">Trip ideas</h1>
        <p className="mt-2 text-[14px] text-gray-600">
          Ready-made itineraries by travel style. Open any trip and make it your own.
        </p>
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {categories.map((c) => {
            const cover = c.presetSlugs.map((s) => bySlug.get(s)?.heroImageUrl).find(Boolean);
            return (
              <Link
                key={c.slug}
                href={`/trips/${c.slug}`}
                className="block bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm hover:shadow-md transition-shadow"
              >
                <div
                  className="w-full h-32 flex items-end px-4 pb-3"
                  style={{
                    background: cover
                      ? `linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.6) 100%), url(${cover}) center/cover no-repeat, #64748b`
                      : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  }}
                >
                  <h2 className="text-white text-[17px] font-bold">{c.title}</h2>
                </div>
                <div className="w-full p-4">
                  <p className="text-[13px] text-gray-600 leading-snug line-clamp-3">{c.intro}</p>
                  <p className="mt-2 text-[12px] font-medium text-[#2563eb]">
                    {c.presetSlugs.length} {c.presetSlugs.length === 1 ? 'trip' : 'trips'} →
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
        {categories.length === 0 && (
          <p className="mt-8 text-sm text-gray-500">
            Trip ideas are temporarily unavailable. <Link href="/browse" className="text-[#2563eb]">Browse all trips</Link>
          </p>
        )}
      </div>
    </main>
  );
}
