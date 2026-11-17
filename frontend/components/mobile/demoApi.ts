/**
 * The /m/demo route's stand-in for the BlueMurr API.
 *
 * Branch previews can't reach the real API (its CORS allows only the
 * production and dev sites), so the demo answers the app's own /api calls
 * from fixtures in the browser and makes none over the network. Every other
 * request (map tiles, geocoding, images) passes through untouched.
 */
import type { Trip } from '@/lib/types';

export type DemoChatScript = {
  /** Shown as the chat's suggestion chips. */
  suggestions: string[];
  /** The first reply whose `match` is in the message (case-insensitive),
   *  else the first without one. Responses are /api/plan/chat bodies. */
  replies: Array<{ match?: string; response: unknown }>;
};

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

/** Every YYYY-MM-DD in `value` moved by `days`, so a recorded trip stays in the future. */
export function shiftDates<T>(value: T, days: number): T {
  if (days === 0) return value;
  const walk = (v: any): any => {
    if (typeof v === 'string') {
      const m = v.match(ISO_DAY);
      if (!m) return v;
      const [y, mo, d] = m[1].split('-').map(Number);
      const dt = new Date(Date.UTC(y, mo - 1, d + days));
      return dt.toISOString().slice(0, 10) + v.slice(10);
    }
    if (Array.isArray(v)) return v.map(walk);
    // Keys too: a city's schedule is keyed by day.
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k), walk(x)]));
    return v;
  };
  return walk(value);
}

/** Days to add so `firstDay` lands `leadDays` from today. */
export function offsetToLead(firstDay: string, leadDays: number, now = new Date()): number {
  const [y, m, d] = firstDay.slice(0, 10).split('-').map(Number);
  const first = Date.UTC(y, m - 1, d);
  const target = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + leadDays);
  return Math.round((target - first) / 86_400_000);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Route the app's /api calls to the fixtures. Returns the uninstall.
 * `apiBase` is NEXT_PUBLIC_API_URL (or the localhost default).
 */
export function installDemoApi(apiBase: string, script: DemoChatScript, dayShift: number): () => void {
  const realFetch = window.fetch.bind(window);
  const apiOrigin = new URL(apiBase, window.location.href).origin;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/api/')) return realFetch(input as any, init);
    const path = url.pathname;
    // A little latency so the typing dots and loading states are seen.
    await new Promise((r) => setTimeout(r, path === '/api/plan/chat' ? 1100 : 150));
    if (path === '/api/plan/chat-suggestions') return json({ suggestions: script.suggestions });
    if (path === '/api/plan/chat') {
      let message = '';
      try {
        message = String(JSON.parse(String(init?.body ?? '{}')).message ?? '').toLowerCase();
      } catch {}
      const hit =
        script.replies.find((r) => r.match && message.includes(r.match.toLowerCase())) ??
        script.replies.find((r) => !r.match);
      return json(shiftDates(hit?.response ?? { type: 'answer', reply: '' }, dayShift));
    }
    if (path.startsWith('/api/trips/popular')) return json({ trips: [] });
    return json({ error: 'This is the demo — the BlueMurr service is not connected here.' }, 503);
  };
  return () => {
    window.fetch = realFetch;
  };
}

/** The demo trip with its dates moved to start about a month from today. */
export function demoTrip(raw: Trip): { trip: Trip; dayShift: number } {
  const first = raw.origin?.outboundLeg?.departDate ?? raw.cities[0]?.dates.arrival;
  const dayShift = first ? offsetToLead(first, 30) : 0;
  const trip = shiftDates(raw, dayShift);
  return { trip: { ...trip, id: 'mock-demo' }, dayShift };
}
