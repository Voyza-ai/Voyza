import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/** /robots.txt — index the marketing/SEO surface, keep private app pages out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/canvas/', '/results', '/plan', '/history', '/auth/', '/explore', '/main', '/group/', '/trip/'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
