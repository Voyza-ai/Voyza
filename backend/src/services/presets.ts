import { getSupabase } from './supabase';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { compareLeg } from './compareLeg';
import { searchHotels, isSameHotel } from './hotels';
import {
  CATEGORIES,
  ORIGIN_REGIONS,
  PRESET_ORIGIN_REGION,
  type OriginRegion,
  categoriesFor,
  presetFacts,
  type PresetData,
  type PresetFacts,
} from './presetTaxonomy';
import curated from '../data/presets/curated.json';
import generated from '../data/presets/generated.json';
import editorial from '../data/presets/editorial.json';

/**
 * Browse catalog: curated + AI-generated preset trips.
 *
 * Source of truth is the preset_trips table (migration 013). Until that
 * table exists — or if the DB read fails — the catalog is served from the
 * bundled JSON (curated.json + generated.json), so /browse and the SEO
 * pages never go dark. Engagement counts are simply zero in that mode.
 */

export type PresetSummary = PresetFacts & {
  slug: string;
  data: PresetData;
  categories: string[];
  heroImageUrl: string | null;
  staffPick: boolean;
  source: 'curated' | 'generated';
  refreshedAt: string | null;
  cloneCount: number;
  viewCount: number;
  impressionCount: number;
  /** Last-7-day engagement score (0 when nothing happened this week). */
  trendingScore: number;
  /** Where the preset is planned and priced from (its origin region hub). */
  origin: { region: string; city: string; airport: string };
};

const TRENDING_WINDOW_MS = 7 * 86_400_000;

const addDaysIso = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
};
// A "use" (save / plan-similar) is the strongest intent signal, a view
// (opened the detail) is medium, an impression (card shown) is weak.
const TRENDING_WEIGHTS = { use: 5, view: 1, impression: 0.05 } as const;

const STAFF_PICKS = new Set<string>(editorial.staffPicks);

/** Bundled catalog rows, used to seed the DB and as the read fallback. */
export function bundledCatalog(): Array<{ data: PresetData; source: 'curated' | 'generated' }> {
  return [
    ...(curated as PresetData[]).map((data) => ({ data, source: 'curated' as const })),
    ...(generated as PresetData[]).map((data) => ({ data, source: 'generated' as const })),
  ];
}

/** Row shape for the preset_trips table — derived facts recomputed from data. */
export function toRow(data: PresetData, source: 'curated' | 'generated') {
  const f = presetFacts(data);
  return {
    slug: data.slug,
    data,
    vibes: f.vibes,
    region: f.region,
    duration_bucket: f.durationBucket,
    budget_tier: f.budgetTier,
    origin_region: PRESET_ORIGIN_REGION,
    nights: f.nights,
    est_cost: f.estCost,
    categories: categoriesFor(f),
    hero_image_url: data.coverImage ?? null,
    staff_pick: STAFF_PICKS.has(data.slug),
    status: 'published',
    source,
  };
}

function summarize(row: any, trendingScore = 0): PresetSummary {
  const data = row.data as PresetData;
  const f = presetFacts(data);
  return {
    ...f,
    slug: data.slug,
    data,
    categories: row.categories ?? categoriesFor(f),
    heroImageUrl: row.hero_image_url ?? data.coverImage ?? null,
    staffPick: row.staff_pick ?? STAFF_PICKS.has(data.slug),
    source: row.source ?? 'curated',
    refreshedAt: row.refreshed_at ?? null,
    cloneCount: row.clone_count ?? 0,
    viewCount: row.view_count ?? 0,
    impressionCount: row.impression_count ?? 0,
    trendingScore,
    origin: {
      region: row.origin_region ?? PRESET_ORIGIN_REGION,
      city: ORIGIN_REGIONS[(row.origin_region ?? PRESET_ORIGIN_REGION) as OriginRegion]?.hubCity ?? 'New York',
      airport: ORIGIN_REGIONS[(row.origin_region ?? PRESET_ORIGIN_REGION) as OriginRegion]?.hubAirport ?? 'JFK',
    },
  };
}

async function trendingScores(now: Date): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - TRENDING_WINDOW_MS).toISOString();
  const { data, error } = await getSupabase()
    .from('preset_events')
    .select('preset_slug, kind')
    .gte('created_at', since)
    .limit(50_000);
  const scores = new Map<string, number>();
  if (error) return scores;
  for (const e of data ?? []) {
    const w = TRENDING_WEIGHTS[e.kind as keyof typeof TRENDING_WEIGHTS] ?? 0;
    scores.set(e.preset_slug, (scores.get(e.preset_slug) ?? 0) + w);
  }
  return scores;
}

/** Published catalog, DB first, bundled JSON as fallback. */
export async function loadCatalog(now = new Date()): Promise<PresetSummary[]> {
  try {
    const { data, error } = await getSupabase()
      .from('preset_trips')
      .select('*')
      .eq('status', 'published');
    if (error) throw new Error(error.message);
    if (data && data.length > 0) {
      const scores = await trendingScores(now);
      return data.map((row: any) => summarize(row, scores.get(row.slug) ?? 0));
    }
  } catch (err: any) {
    logger.warn('presets: DB catalog unavailable, serving bundled JSON', { message: err?.message });
  }
  return bundledCatalog().map(({ data, source }) => summarize({ ...toRow(data, source) }));
}

export type CategoryRow = {
  slug: string;
  title: string;
  seoTitle: string;
  metaDescription: string;
  intro: string;
  presetSlugs: string[];
};

/** Category definitions with their member presets (cheapest first). */
export function buildCategoryRows(catalog: PresetSummary[]): CategoryRow[] {
  return CATEGORIES.map((c) => ({
    slug: c.slug,
    title: c.title,
    seoTitle: c.seoTitle,
    metaDescription: c.metaDescription,
    intro: c.intro,
    presetSlugs: catalog
      .filter((p) => p.categories.includes(c.slug))
      .sort((a, b) => a.costPerPerson - b.costPerPerson)
      .map((p) => p.slug),
  })).filter((c) => c.presetSlugs.length > 0);
}

/** Editorial rows: staff picks + trending this week. */
export function buildEditorialRows(catalog: PresetSummary[]) {
  const staffPicks = catalog.filter((p) => p.staffPick).map((p) => p.slug);
  const trending = catalog
    .filter((p) => p.trendingScore > 0)
    .sort((a, b) => b.trendingScore - a.trendingScore)
    .slice(0, 8)
    .map((p) => p.slug);
  return { staffPicks, trending };
}

export type PresetEventKind = 'impression' | 'view' | 'use';

/** Fire-and-forget engagement events; never throws. */
export async function recordPresetEvents(
  events: Array<{ slug: string; kind: PresetEventKind }>,
): Promise<number> {
  let recorded = 0;
  const supabase = getSupabase();
  for (const e of events) {
    try {
      const { error } = await supabase.rpc('record_preset_event', {
        p_slug: e.slug,
        p_kind: e.kind,
      });
      if (!error) recorded++;
    } catch {
      // table missing (pre-migration) or unknown slug — skip
    }
  }
  return recorded;
}

// Hotel identity matching lives with the hotel search.
export { isSameHotel } from './hotels';

/**
 * Accept a refreshed fare only when it is plausibly the SAME journey at a
 * new price: same mode as the curated leg, and within 3× either way. A
 * mode change is almost always a coverage gap, not a better route — live
 * test: Lisbon → Sintra (a $3 commuter train) came back as a $468 flight to
 * a town with no airport, because no rail source covered the leg. A refresh
 * keeps prices current; it must never rewrite the route.
 */
export function isPlausibleRefresh(
  prev: { mode: string; price: number } | undefined,
  newMode: string,
  newPrice: number,
): boolean {
  if (!prev) return true;
  if (prev.mode !== newMode) return false;
  if (!(prev.price > 0)) return true;
  return newPrice <= prev.price * 3 && newPrice >= prev.price / 3;
}

/**
 * True only when the refresh is switched on (PRESET_REFRESH_ENABLED=true).
 * Gates both the in-process scheduler and POST /run-refresh: the refresh
 * writes into the one Supabase project that also holds real trips, so it
 * must be opted into by exactly one deployment, never by default.
 */
export function presetRefreshEnabled(): boolean {
  return env.PRESET_REFRESH_ENABLED === true;
}

/**
 * True only when flight fares come from Duffel's LIVE mode. Production runs
 * a TEST token today — every offer is `live_mode: false`, priced by Duffel's
 * sandbox and sold by "Duffel Airways" — so a refresh that accepted those
 * fares would overwrite curated prices with made-up ones (audit: curated
 * Vietnam Airlines $64 → Duffel Airways $180). With no token at all the only
 * flight fares compareLeg can return are leg_price_cache rows, which were
 * written by that same test token. So the rule is "live token or nothing",
 * not merely "not a test token".
 */
export function liveFlightFaresAvailable(): boolean {
  return (env.DUFFEL_ACCESS_TOKEN ?? '').startsWith('duffel_live_');
}

/**
 * Weekly price refresh: for every published preset, ~30 days out,
 *  - re-price each inter-city leg with live flight + train search (per
 *    person, matching how presets store transport), and
 *  - re-price each city's hotel: find the SAME hotel in a live search
 *    (1 room, 2 adults — presets store the nightly rate per room) and take
 *    its current nightly rate.
 * Then recompute the derived cost facts. Anything that can't be re-priced
 * (no offer, hotel not in results, API down) keeps its previous price — a
 * refresh must never zero out or invent a price.
 */
export async function refreshPresetPrices(
  now = new Date(),
  opts: { only?: string[] } = {},
): Promise<{
  refreshed: number;
  failed: number;
}> {
  const supabase = getSupabase();
  let query = supabase.from('preset_trips').select('slug, data, source').eq('status', 'published');
  // Limit to specific presets (manual spot-checks; the weekly run does all).
  if (opts.only?.length) query = query.in('slug', opts.only);
  const { data: rows, error } = await query;
  if (error) throw new Error(error.message);

  const date = new Date(now.getTime() + 30 * 86_400_000).toISOString().split('T')[0];
  const liveFlights = liveFlightFaresAvailable();
  let refreshed = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    const data: PresetData = JSON.parse(JSON.stringify(row.data));
    // Why each curated fare that was NOT replaced stayed — logged per preset.
    const kept: string[] = [];
    try {
      await supabase.from('preset_trips').update({ refresh_status: 'refreshing' }).eq('slug', row.slug);

      // Hotels: stay dates chain from the same start date as the legs.
      let checkin = date;
      for (const city of data.cities) {
        const checkout = addDaysIso(checkin, city.nights);
        try {
          // Look up THIS hotel by name (a city search only returns the top
          // ~20 listings, which rarely include the curated hotel).
          const offers = await searchHotels({
            city: city.name,
            hotelName: city.hotel.name,
            checkin,
            checkout,
            adults: 2,
            rooms: 1,
          });
          const match = offers.find((o) => isSameHotel(city.hotel.name, o.name));
          const prevRate = city.hotel.pricePerNight;
          if (
            match &&
            match.pricePerNight > 0 &&
            (!(prevRate > 0) || (match.pricePerNight <= prevRate * 3 && match.pricePerNight >= prevRate / 3))
          ) {
            city.hotel = { ...city.hotel, pricePerNight: Math.round(match.pricePerNight) };
          }
        } catch {
          // hotel search failed — keep the previous nightly rate
        }
        checkin = checkout;
      }

      for (let i = 0; i < data.cities.length - 1; i++) {
        const from = data.cities[i];
        const to = data.cities[i + 1];
        const prev = from.transportOut;
        // A curated flight can only be re-priced by a LIVE fare. Without one
        // the search's answer could never be accepted, so it isn't run —
        // that also skips the airport lookups and price-cache writes it
        // would make against the shared database.
        if (prev?.mode === 'flight' && !liveFlights) {
          kept.push(`${from.name} → ${to.name}: no live Duffel token`);
          continue;
        }
        const cmp = await compareLeg({
          origin: from.name,
          destination: to.name,
          date,
          travelers: 1,
          originCountry: from.country,
          destinationCountry: to.country,
        });
        const pick =
          cmp.recommendation === 'train'
            ? cmp.trainOption
            : cmp.recommendation === 'flight'
              ? cmp.flightOption
              : null;
        const price = (pick as any)?.price;
        if (cmp.recommendation === 'flight' && !liveFlights) {
          // Same rule for a leg with no curated fare to protect.
          kept.push(`${from.name} → ${to.name}: no live Duffel token`);
        } else if (pick && typeof price === 'number' && price > 0 && isPlausibleRefresh(prev, cmp.recommendation, price)) {
          const mins = (pick as any).durationMinutes ?? 0;
          from.transportOut = {
            mode: cmp.recommendation as 'flight' | 'train',
            // The curated operator names the ROUTE ("Vietnam Airlines",
            // "Shinkansen Hikari"); the cheapest offer's carrier is just
            // whoever sold that one fare — under a test token, "Duffel
            // Airways". A refresh updates prices, never the route.
            operator:
              prev?.operator || ((pick as any).operator ?? (pick as any).carrier ?? ''),
            duration: mins ? `${Math.floor(mins / 60)}h ${mins % 60}m` : prev?.duration ?? '',
            price: Math.round(price),
          };
        }
      }
      if (kept.length > 0) {
        logger.info('preset refresh: kept curated fares', { slug: row.slug, kept });
      }
      const r = toRow(data, row.source);
      await supabase
        .from('preset_trips')
        .update({
          data,
          est_cost: r.est_cost,
          budget_tier: r.budget_tier,
          categories: r.categories,
          refresh_status: 'fresh',
          refreshed_at: now.toISOString(),
        })
        .eq('slug', row.slug);
      refreshed++;
    } catch (err: any) {
      failed++;
      logger.warn('preset refresh failed (non-fatal)', { slug: row.slug, message: err?.message });
      await supabase.from('preset_trips').update({ refresh_status: 'failed' }).eq('slug', row.slug);
    }
  }
  return { refreshed, failed };
}

// ── Weekly schedule ─────────────────────────────────────────────────────

const WEEK_MS = 7 * 86_400_000;

/** True when the catalog's prices are due: any preset never refreshed, or
 *  the oldest refresh is over a week old. Exported for tests. */
export async function presetRefreshDue(now = new Date()): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from('preset_trips')
    .select('refreshed_at')
    .eq('status', 'published');
  if (error || !data || data.length === 0) return false; // table missing / empty
  return data.some(
    (r: any) => !r.refreshed_at || now.getTime() - new Date(r.refreshed_at).getTime() > WEEK_MS,
  );
}

let refreshRunning = false;

/**
 * Run `fn` unless a refresh is already in flight in this process, in which
 * case return 'busy' without running it. Both entry points — the scheduler
 * tick and POST /run-refresh — go through here, so an on-demand run can't
 * overlap a scheduled one (the route used to call refreshPresetPrices
 * directly and ignored the flag).
 */
export async function withPresetRefreshLock<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
  if (refreshRunning) return 'busy';
  refreshRunning = true;
  try {
    return await fn();
  } finally {
    refreshRunning = false;
  }
}

/** One scheduler tick: refresh if due and not already running. */
export async function runScheduledPresetRefresh(now = new Date()): Promise<'ran' | 'skipped'> {
  const outcome = await withPresetRefreshLock(async (): Promise<'ran' | 'skipped'> => {
    try {
      if (!(await presetRefreshDue(now))) return 'skipped';
      const result = await refreshPresetPrices(now);
      logger.info('Weekly preset price refresh complete', result);
      return 'ran';
    } catch (err: any) {
      logger.warn('Weekly preset price refresh failed (non-fatal)', { message: err?.message });
      return 'skipped';
    }
  });
  return outcome === 'busy' ? 'skipped' : outcome;
}

/**
 * The weekly cron, in-process: checks every 6 hours whether prices are a
 * week old and refreshes if so. "Due" is read from refreshed_at in the
 * database, so restarts never cause extra runs and multiple checks a week
 * are no-ops. First check waits 10 minutes after boot so a dev restart
 * doesn't immediately spend API quota. POST /api/presets/run-refresh
 * remains for running it on demand.
 *
 * Does nothing unless PRESET_REFRESH_ENABLED=true. index.ts starts this on
 * every non-test boot — including a laptop on `npm run dev`, which talks to
 * the same production database — so the gate lives HERE, where no caller
 * can forget it. Says once at boot which way it went.
 */
export function startPresetRefreshScheduler(): () => void {
  if (!presetRefreshEnabled()) {
    logger.info('Preset price refresh scheduler disabled (set PRESET_REFRESH_ENABLED=true to enable)');
    return () => {};
  }
  logger.info('Preset price refresh scheduler enabled', {
    liveFlightFares: liveFlightFaresAvailable(),
  });
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const first = setTimeout(() => void runScheduledPresetRefresh(), 10 * 60 * 1000);
  const every = setInterval(() => void runScheduledPresetRefresh(), SIX_HOURS);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
