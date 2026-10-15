import { getSupabase } from './supabase';

/**
 * Trip discovery: real user trips their owners opted into Explore.
 *
 * Visibility gate is `is_public = true` — NOT `allow_recommendations`.
 * allow_recommendations defaults to TRUE on every trip and means "BlueMurr
 * may learn from this trip's patterns"; gating a public page on it would
 * publish every user's trips without consent. is_public defaults to false
 * and is flipped by the owner's "Share to Explore" switch.
 *
 * Popularity:
 *  - popular  → all-time clone_count (incremented by POST /:id/clone)
 *  - trending → distinct people who cloned it in the last 7 days, read
 *               straight from the clones (cloned_from_trip_id + user_id +
 *               created_at) — no extra counter/table needed.
 * Both count PEOPLE: repeat clones by one user count once; the owner's
 * own clones never count.
 */

export type PopularSort = 'popular' | 'trending';

export type PopularFilters = {
  vibe?: string;
  /** Max TOTAL trip cost, USD. */
  maxBudget?: number;
  /** Trip must include at least one of these cities (case-insensitive). */
  cities?: string[];
  sort?: PopularSort;
  limit?: number;
};

export type PopularTrip = {
  id: string;
  title: string;
  travelers: number;
  totalCost: number | null;
  startDate: string | null;
  cloneCount: number;
  clonesThisWeek: number;
  createdAt: string;
  cities: Array<{ name: string; country: string | null }>;
  /** Vibe tags: the trip's vibe + every city's vibes, deduped, lowercase. */
  tags: string[];
  /** Owner's display name — public trips were shared intentionally, but
   *  emails are never exposed. */
  ownerName: string | null;
  isMine: boolean;
};

const TRENDING_WINDOW_MS = 7 * 86_400_000;
const CANDIDATE_CAP = 300;

/** Pure filter + rank step — exported for tests. */
export function filterAndRank(trips: PopularTrip[], f: PopularFilters): PopularTrip[] {
  const vibe = f.vibe?.trim().toLowerCase();
  const cities = (f.cities ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);

  const out = trips.filter((t) => {
    if (vibe && !t.tags.includes(vibe)) return false;
    if (typeof f.maxBudget === 'number' && (t.totalCost == null || t.totalCost > f.maxBudget)) {
      return false;
    }
    if (cities.length > 0) {
      const names = t.cities.map((c) => c.name.toLowerCase());
      if (!cities.some((c) => names.includes(c))) return false;
    }
    return true;
  });

  const sort = f.sort ?? 'popular';
  out.sort((a, b) => {
    const primary =
      sort === 'trending'
        ? b.clonesThisWeek - a.clonesThisWeek || b.cloneCount - a.cloneCount
        : b.cloneCount - a.cloneCount || b.clonesThisWeek - a.clonesThisWeek;
    return primary || b.createdAt.localeCompare(a.createdAt);
  });

  // Trending means "something happened this week" — an all-quiet trip
  // isn't trending no matter how its all-time count compares.
  const ranked = sort === 'trending' ? out.filter((t) => t.clonesThisWeek > 0) : out;
  return ranked.slice(0, Math.max(1, Math.min(f.limit ?? 30, 100)));
}

export async function fetchPopularTrips(
  f: PopularFilters,
  requesterId: string,
  now = new Date(),
): Promise<PopularTrip[]> {
  const supabase = getSupabase();

  const { data: trips, error } = await supabase
    .from('trips')
    .select('id, title, travelers, total_cost, vibe, start_date, clone_count, created_at, user_id')
    .eq('is_public', true)
    .neq('status', 'archived')
    .order('clone_count', { ascending: false })
    .limit(CANDIDATE_CAP);
  if (error) throw new Error(error.message);
  if (!trips || trips.length === 0) return [];

  const ids = trips.map((t: any) => t.id);
  const ownerIds = Array.from(new Set(trips.map((t: any) => t.user_id).filter(Boolean)));
  const since = new Date(now.getTime() - TRENDING_WINDOW_MS).toISOString();

  const [{ data: cityRows }, { data: recentClones }, { data: owners }] = await Promise.all([
    supabase
      .from('cities')
      .select('trip_id, name, country, vibes, position')
      .in('trip_id', ids)
      .order('position', { ascending: true }),
    supabase
      .from('trips')
      .select('cloned_from_trip_id, user_id')
      .in('cloned_from_trip_id', ids)
      .gte('created_at', since),
    supabase.from('user_profiles').select('id, full_name').in('id', ownerIds),
  ]);

  const citiesByTrip = new Map<string, any[]>();
  for (const c of cityRows ?? []) {
    const list = citiesByTrip.get(c.trip_id) ?? [];
    list.push(c);
    citiesByTrip.set(c.trip_id, list);
  }
  // Distinct PEOPLE per trip this week (same rule as clone_count): one
  // user cloning repeatedly counts once, and the owner never counts.
  const ownerOf = new Map<string, string>(trips.map((t: any) => [t.id, t.user_id]));
  const weekCloners = new Map<string, Set<string>>();
  for (const r of recentClones ?? []) {
    const k = r.cloned_from_trip_id as string;
    if (!r.user_id || r.user_id === ownerOf.get(k)) continue;
    const set = weekCloners.get(k) ?? new Set<string>();
    set.add(r.user_id);
    weekCloners.set(k, set);
  }
  const weekClones = new Map<string, number>(
    Array.from(weekCloners, ([k, set]) => [k, set.size]),
  );
  const nameById = new Map<string, string | null>(
    (owners ?? []).map((o: any) => [o.id, o.full_name ?? null]),
  );

  const enriched: PopularTrip[] = trips.map((t: any) => {
    const cs = citiesByTrip.get(t.id) ?? [];
    const tags = new Set<string>();
    if (t.vibe) tags.add(String(t.vibe).toLowerCase());
    for (const c of cs) {
      for (const v of Array.isArray(c.vibes) ? c.vibes : []) tags.add(String(v).toLowerCase());
    }
    return {
      id: t.id,
      title: t.title,
      travelers: t.travelers ?? 1,
      totalCost: t.total_cost != null ? Number(t.total_cost) : null,
      startDate: t.start_date ?? null,
      cloneCount: t.clone_count ?? 0,
      clonesThisWeek: weekClones.get(t.id) ?? 0,
      createdAt: t.created_at,
      cities: cs.map((c) => ({ name: c.name, country: c.country ?? null })),
      tags: Array.from(tags),
      ownerName: nameById.get(t.user_id) ?? null,
      isMine: t.user_id === requesterId,
    };
  });

  return filterAndRank(enriched, f);
}
