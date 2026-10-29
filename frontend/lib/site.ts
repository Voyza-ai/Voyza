/** Canonical public origin for SEO (canonical URLs, sitemap, JSON-LD). */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://bluemurr.com').replace(/\/$/, '');

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
