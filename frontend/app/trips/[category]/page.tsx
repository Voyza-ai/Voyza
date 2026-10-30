import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import Navbar from '@/components/shared/Navbar';
import MiniRoute from '@/components/browse/MiniRoute';
import { presetPricePerPersonRange } from '@/data/presetItineraries';
import { fetchCatalogServer, fetchCategoryServer, serializeJsonLd } from '@/lib/presetsServer';
import { SITE_URL } from '@/lib/site';

/**
 * SEO category landing page, e.g. /trips/romance-in-europe.
 *
 * SERVER-rendered (no 'use client'): crawlers get the full trip list,
 * editorial intro, canonical URL, Open Graph tags, and schema.org JSON-LD
 * (ItemList of TouristTrip + BreadcrumbList) in the initial HTML.
 * Regenerated at most hourly (ISR) from the public presets API.
 */

export const revalidate = 3600;

export async function generateStaticParams() {
  const catalog = await fetchCatalogServer();
  return (catalog?.categories ?? []).map((c) => ({ category: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: { category: string };
}): Promise<Metadata> {
  const result = await fetchCategoryServer(params.category);
  if (!result || result === 'not-found') return { title: 'Trips — BlueMurr' };
  const { category, presets } = result;
  const url = `${SITE_URL}/trips/${category.slug}`;
  const image = presets.find((p) => p.heroImageUrl)?.heroImageUrl ?? undefined;
  return {
    title: `${category.seoTitle} | BlueMurr`,
    description: category.metaDescription,
    alternates: { canonical: url },
    openGraph: {
      title: category.seoTitle,
      description: category.metaDescription,
      url,
      siteName: 'BlueMurr',
      type: 'website',
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: { card: 'summary_large_image', title: category.seoTitle, description: category.metaDescription },
  };
}

export default async function CategoryPage({ params }: { params: { category: string } }) {
  const result = await fetchCategoryServer(params.category);
  if (result === 'not-found') notFound();
  if (!result) {
    return (
      <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
        <Navbar />
        <p className="pt-28 text-center text-sm text-gray-500">
          These trips are temporarily unavailable. <Link href="/browse" className="text-[#2563eb]">Browse all trips</Link>
        </p>
      </main>
    );
  }

  const { category, presets } = result;
  const catalog = await fetchCatalogServer();
  const otherCategories = (catalog?.categories ?? []).filter((c) => c.slug !== category.slug);
  const pageUrl = `${SITE_URL}/trips/${category.slug}`;

  // schema.org: the page is an ItemList of TouristTrip (each with its city
  // itinerary and a price offer) + a breadcrumb trail.
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: category.title,
      description: category.metaDescription,
      url: pageUrl,
      numberOfItems: presets.length,
      itemListElement: presets.map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'TouristTrip',
          name: p.data.title,
          description: p.data.description,
          url: `${SITE_URL}/browse?preset=${p.slug}`,
          ...(p.heroImageUrl ? { image: p.heroImageUrl } : {}),
          touristType: p.vibes,
          itinerary: {
            '@type': 'ItemList',
            itemListElement: p.data.cities.map((c, j) => ({
              '@type': 'ListItem',
              position: j + 1,
              item: { '@type': 'City', name: c.name, containedInPlace: { '@type': 'Country', name: c.country } },
            })),
          },
          offers: {
            '@type': 'Offer',
            price: p.costPerPerson,
            priceCurrency: 'USD',
            description: `Estimated per person for ${p.nights} nights`,
          },
          // The journey itself: from the origin hub to the first city.
          potentialAction: {
            '@type': 'TravelAction',
            name: `Plan ${p.data.title}`,
            fromLocation: {
              '@type': 'Place',
              name: `${p.origin?.city ?? 'New York'} (${p.origin?.airport ?? 'JFK'})`,
            },
            toLocation: {
              '@type': 'City',
              name: p.data.cities[0]?.name,
              containedInPlace: { '@type': 'Country', name: p.data.cities[0]?.country },
            },
            target: `${SITE_URL}/browse?preset=${p.slug}`,
          },
        },
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
        { '@type': 'ListItem', position: 2, name: 'Trips', item: `${SITE_URL}/trips` },
        { '@type': 'ListItem', position: 3, name: category.title, item: pageUrl },
      ],
    },
  ];

  return (
    <main className="min-h-screen" style={{ background: '#f0f4f8' }}>
      <Navbar />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      <div className="pt-20 px-5 pb-16 max-w-6xl mx-auto">
        <nav aria-label="Breadcrumb" className="text-[12px] text-gray-400 mb-3">
          <Link href="/" className="hover:text-gray-600">Home</Link>
          {' / '}
          <Link href="/trips" className="hover:text-gray-600">Trips</Link>
          {' / '}
          <span className="text-gray-600">{category.title}</span>
        </nav>
        <h1 className="text-[28px] font-bold text-gray-900">{category.title}</h1>
        <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-gray-600">{category.intro}</p>

        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {presets.map((p) => (
            <Link
              key={p.slug}
              href={`/browse?preset=${p.slug}`}
              className="block bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm hover:shadow-md transition-shadow"
            >
              <div
                className="w-full h-40 flex flex-col justify-end px-4 pb-3"
                style={{
                  background: p.heroImageUrl
                    ? `linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.55) 100%), url(${p.heroImageUrl}) center/cover no-repeat, ${p.data.coverGradient}`
                    : p.data.coverGradient,
                }}
              >
                <h2 className="text-white text-[16px] font-bold leading-tight">{p.data.title}</h2>
                <div className="text-white/85 text-[11px] mt-0.5">{p.data.flags}</div>
              </div>
              <div className="w-full p-4">
                <p className="text-[13px] text-gray-600 leading-snug">{p.data.tagline}</p>
                <div className="mt-2.5">
                  <MiniRoute cities={p.data.cities} />
                </div>
                <div className="flex items-center justify-between mt-3 text-[12px]">
                  <span className="text-gray-500">{p.nights} nights</span>
                  <span className="font-semibold text-[#2563eb]" title="Per person: 2 sharing a room – solo">
                    ${presetPricePerPersonRange(p.data).low.toLocaleString()}–$
                    {presetPricePerPersonRange(p.data).high.toLocaleString()} / person
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>

        {otherCategories.length > 0 && (
          <section className="mt-12">
            <h2 className="text-[15px] font-semibold text-gray-900 mb-3">More trip ideas</h2>
            <div className="flex flex-wrap gap-2">
              {otherCategories.map((c) => (
                <Link
                  key={c.slug}
                  href={`/trips/${c.slug}`}
                  className="px-3 py-1.5 rounded-full text-[12px] bg-white border border-gray-200 text-gray-700 hover:border-[#2563eb] hover:text-[#2563eb] transition-colors"
                >
                  {c.title}
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
