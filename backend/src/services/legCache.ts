import { getSupabase } from './supabase';

/**
 * Cached leg prices for a saved trip.
 *
 * `leg_price_cache` is keyed by (origin, destination, travel_date, mode) —
 * city NAMES, not trip ids — so a trip can't be looked up in it directly.
 * The trip's own city rows have to be read first to derive the keys: leg i
 * is city[i] → city[i+1], travelled on city[i]'s departure date, with the
 * names lowercased the way compareLeg() writes them on the way in.
 *
 * Rows are written by compareLeg() during an optimize run and expire after
 * 2 hours, so a trip whose last optimize is older than that legitimately
 * comes back empty.
 *
 * `raw_response` — the unfiltered provider payload — is neither selected
 * nor mapped out. It's internal debugging data and has no business
 * crossing the API boundary.
 */
export type CachedLeg = {
  id: string;
  origin: string;
  destination: string;
  travelDate: string;
  mode: string;
  price: number | null;
  durationMinutes: number | null;
  operator: string | null;
  fetchedAt: string;
  expiresAt: string | null;
};

const CACHED_LEG_COLUMNS =
  'id, origin, destination, travel_date, mode, price, duration_minutes, operator, fetched_at, expires_at';

type LegKey = { origin: string; destination: string; travelDate: string };

/**
 * Still-live cache rows for the legs of `tripId`. Access control is the
 * caller's job (see GET /api/optimize/:tripId) — this only reads data.
 */
export async function getCachedLegPrices(tripId: string): Promise<CachedLeg[]> {
  const supabase = getSupabase();

  const { data: cities } = await supabase
    .from('cities')
    .select('name, departure_date')
    .eq('trip_id', tripId)
    .order('position', { ascending: true });

  const ordered = cities ?? [];
  const legs: LegKey[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    // A city with no departure date was never priced, so there's no cache
    // row to find either — skip it rather than querying for `null`.
    if (!from.name || !to.name || !from.departure_date) continue;
    legs.push({
      origin: String(from.name).toLowerCase(),
      destination: String(to.name).toLowerCase(),
      travelDate: from.departure_date,
    });
  }

  if (legs.length === 0) return [];

  // One `.in()` per column matches the cross product of the legs (e.g.
  // Rome → Paris on a Lisbon leg's date), so the exact triples get
  // filtered out below. The expires_at bound keeps this to live rows —
  // the same window compareLeg() reads.
  const { data: rows } = await supabase
    .from('leg_price_cache')
    .select(CACHED_LEG_COLUMNS)
    .in('origin', legs.map((l) => l.origin))
    .in('destination', legs.map((l) => l.destination))
    .in('travel_date', legs.map((l) => l.travelDate))
    .gte('expires_at', new Date().toISOString());

  const wanted = new Set(
    legs.map((l) => `${l.origin}|${l.destination}|${l.travelDate}`),
  );

  return (rows ?? [])
    .filter((r: any) => wanted.has(`${r.origin}|${r.destination}|${r.travel_date}`))
    .map((r: any) => ({
      id: r.id,
      origin: r.origin,
      destination: r.destination,
      travelDate: r.travel_date,
      mode: r.mode,
      price: r.price === null || r.price === undefined ? null : Number(r.price),
      durationMinutes: r.duration_minutes ?? null,
      operator: r.operator ?? null,
      fetchedAt: r.fetched_at,
      expiresAt: r.expires_at ?? null,
    }));
}
