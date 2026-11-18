/**
 * Product usage tracking — what people do in BlueMurr, so we can see whether
 * anyone plans, saves and comes back.
 *
 * OFF unless NEXT_PUBLIC_POSTHOG_KEY is set (a PostHog project's public
 * "project API key", which is meant to be in the browser). With no key every
 * call is a no-op: nothing leaves the browser. Set one key per environment
 * (Vercel → Settings → Environment Variables) so dev testing never mixes
 * with real usage.
 *
 * Privacy: an anonymous random id per browser (localStorage), never a name or
 * email. Event properties are counts and kinds (cities: 2, kind: 'dinner'),
 * never free text the person typed. "Do Not Track" turns it off.
 *
 * No SDK: one fetch per event to PostHog's capture endpoint, fire-and-forget.
 * A failure is ignored — tracking must never break the app.
 */

type Props = Record<string, string | number | boolean | null | undefined>;

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';
const HOST = (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com').replace(/\/+$/, '');
const ID_KEY = 'bluemurr.anonId';
const SESSION_KEY = 'bluemurr.sessionId';

export const trackingEnabled = (): boolean =>
  !!KEY && typeof window !== 'undefined' && (navigator as any).doNotTrack !== '1' && (window as any).doNotTrack !== '1';

function stored(storage: Storage | undefined, key: string): string {
  try {
    const have = storage?.getItem(key);
    if (have) return have;
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    storage?.setItem(key, id);
    return id;
  } catch {
    return 'anon';
  }
}

/** Record one event. Safe to call anywhere, any time. */
export function track(event: string, props: Props = {}): void {
  if (!trackingEnabled()) return;
  try {
    const body = {
      api_key: KEY,
      event,
      distinct_id: stored(window.localStorage, ID_KEY),
      timestamp: new Date().toISOString(),
      properties: {
        ...props,
        $session_id: stored(window.sessionStorage, SESSION_KEY),
        $current_url: window.location.origin + window.location.pathname,
        $pathname: window.location.pathname,
        $host: window.location.host,
        $referrer: document.referrer || undefined,
        $screen_width: window.innerWidth,
        app: 'web',
      },
    };
    void fetch(`${HOST}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never break the app */
  }
}

/** A rough size bucket for a dollar amount, so totals are comparable without exact prices. */
export function moneyBucket(usd: number | null | undefined): string | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 500) return '<500';
  if (usd < 1000) return '500-1k';
  if (usd < 2500) return '1k-2.5k';
  if (usd < 5000) return '2.5k-5k';
  return '5k+';
}
