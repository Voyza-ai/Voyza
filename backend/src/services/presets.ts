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

/** Within 3× either way of the anchor (an anchor of 0 accepts anything). */
const within3x = (price: number, anchor: number) =>
  !(anchor > 0) || (price <= anchor * 3 && price >= anchor / 3);

/**
 * The bundled (curated.json / generated.json) copy of each preset — the
 * FIXED anchor a refreshed price is judged against. Anchoring to the row's
 * previous price let a fare ratchet 3× per run with nothing holding it:
 * curated $100 → $290 → $860 → $2,580 in three weekly runs (audit A7).
 */
const BUNDLED_BY_SLUG = new Map(bundledCatalog().map(({ data }) => [data.slug, data]));

/** The bundled city at index i, when it is still the same city. */
const bundledCity = (slug: string, i: number, name: string) => {
  const c = BUNDLED_BY_SLUG.get(slug)?.cities[i];
  return c && c.name === name ? c : undefined;
};

type RepriceOutcome = {
  /** Prices that came back from a live source and were accepted. */
  live: number;
  /** Prices kept as they were, and why ("Rome → Florence: no live train fare"). */
  kept: string[];
  /** Searches that threw. */
  errors: string[];
};

/**
 * Re-price one preset IN PLACE, ~30 days out:
 *  - each city's hotel: find the SAME hotel in a live search (1 room, 2
 *    adults — presets store the nightly rate per room) and take its rate;
 *  - each inter-city leg, per person (how presets store transport), in its
 *    OWN mode: a curated train is priced from the train option, a curated
 *    flight from the flight option. The cheapest-overall recommendation
 *    used to decide, so a priced train lost to a cheaper flight was never
 *    re-priced, and a mode change was only caught by the guard afterwards.
 * Leg dates chain like the stays: a leg departs the day its city's stay
 * ends (every leg used to be searched on the trip's first day).
 * Never throws; anything not re-priced keeps its price and says why — a
 * refresh must never zero out or invent a price.
 */
async function repricePreset(
  slug: string,
  data: PresetData,
  startIso: string,
  liveFlights: boolean,
): Promise<RepriceOutcome> {
  const out: RepriceOutcome = { live: 0, kept: [], errors: [] };

  const stays: Array<{ checkin: string; checkout: string }> = [];
  let checkin = startIso;
  for (const city of data.cities) {
    const checkout = addDaysIso(checkin, city.nights);
    stays.push({ checkin, checkout });
    checkin = checkout;
  }

  for (const [i, city] of data.cities.entries()) {
    try {
      // Look up THIS hotel by name (a city search only returns the top
      // ~20 listings, which rarely include the curated hotel).
      const offers = await searchHotels({
        city: city.name,
        hotelName: city.hotel.name,
        checkin: stays[i].checkin,
        checkout: stays[i].checkout,
        adults: 2,
        rooms: 1,
      });
      const match = offers.find((o) => isSameHotel(city.hotel.name, o.name));
      const anchor = bundledCity(slug, i, city.name)?.hotel.pricePerNight ?? city.hotel.pricePerNight;
      if (!match || !(match.pricePerNight > 0)) {
        out.kept.push(`${city.name} hotel: not in live results`);
      } else if (!within3x(match.pricePerNight, anchor)) {
        out.kept.push(`${city.name} hotel: live $${Math.round(match.pricePerNight)} vs curated $${anchor}, over 3×`);
      } else {
        city.hotel = { ...city.hotel, pricePerNight: Math.round(match.pricePerNight) };
        out.live++;
      }
    } catch (err: any) {
      out.errors.push(`${city.name} hotel: ${err?.message ?? 'search failed'}`);
    }
  }

  for (let i = 0; i < data.cities.length - 1; i++) {
    const from = data.cities[i];
    const to = data.cities[i + 1];
    const leg = `${from.name} → ${to.name}`;
    const prev = from.transportOut;
    // No curated leg: nothing to re-price, and adding one would rewrite the route.
    if (!prev) {
      out.kept.push(`${leg}: no curated leg`);
      continue;
    }
    // A curated flight can only be re-priced by a LIVE fare. Without one
    // the search's answer could never be accepted, so it isn't run —
    // that also skips the airport lookups and price-cache writes it
    // would make against the shared database.
    if (prev.mode === 'flight' && !liveFlights) {
      out.kept.push(`${leg}: no live Duffel token`);
      continue;
    }
    let cmp;
    try {
      cmp = await compareLeg({
        origin: from.name,
        destination: to.name,
        date: stays[i].checkout,
        travelers: 1,
        originCountry: from.country,
        destinationCountry: to.country,
      });
    } catch (err: any) {
      out.errors.push(`${leg}: ${err?.message ?? 'search failed'}`);
      continue;
    }
    const option: any = prev.mode === 'train' ? cmp.trainOption : cmp.flightOption;
    const price = option?.price;
    // While rail has no coverage this is the normal answer for a train leg:
    // a kept price, not a failure.
    if (!(typeof price === 'number' && price > 0)) {
      out.kept.push(`${leg}: no live ${prev.mode} fare`);
      continue;
    }
    const bundledLeg = bundledCity(slug, i, from.name)?.transportOut;
    const anchor = bundledLeg && bundledLeg.mode === prev.mode ? bundledLeg.price : prev.price;
    if (!isPlausibleRefresh({ mode: prev.mode, price: anchor }, prev.mode, price)) {
      out.kept.push(`${leg}: live $${Math.round(price)} vs curated $${anchor}, over 3×`);
      continue;
    }
    const mins = option.durationMinutes ?? 0;
    from.transportOut = {
      mode: prev.mode,
      // The curated operator names the ROUTE ("Vietnam Airlines",
      // "Shinkansen Hikari"); the cheapest offer's carrier is just
      // whoever sold that one fare — under a test token, "Duffel
      // Airways". A refresh updates prices, never the route.
      operator: prev.operator || (option.operator ?? option.carrier ?? ''),
      duration: mins ? `${Math.floor(mins / 60)}h ${mins % 60}m` : prev.duration,
      price: Math.round(price),
    };
    out.live++;
  }
  return out;
}

// ── Which rows a run touches (audit E6) ─────────────────────────────────

const WEEK_MS = 7 * 86_400_000;
/** First retry of a preset whose refresh failed; doubles per failure, capped at a week. */
const BACKOFF_BASE_MS = 12 * 60 * 60 * 1000;
/** Re-pricing one preset takes seconds. A row still 'refreshing' this long
 *  after we first saw it was abandoned by a process that died mid-run. */
const STALE_CLAIM_MS = 60 * 60 * 1000;

/**
 * Per-process memory. Lost on restart, which costs at most one early retry
 * per preset — the schema has no column to hold it and stays unchanged.
 */
const backoff = new Map<string, { failures: number; nextAttemptAt: number }>();
const refreshingSince = new Map<string, number>();

/** Test seam: forget backoff and stale-claim memory. */
export function resetPresetRefreshState(): void {
  backoff.clear();
  refreshingSince.clear();
}

type RefreshRow = {
  slug: string;
  data: PresetData;
  source: 'curated' | 'generated';
  refresh_status: string;
  refreshed_at: string | null;
};

/**
 * Due = never refreshed or last live over a week ago, not backing off, and
 * not mid-refresh elsewhere. The run used to re-price EVERY row whenever
 * any one was due — so one preset that kept failing re-priced the whole
 * catalog every 6 hours, and a restart re-priced rows refreshed minutes
 * earlier.
 */
function rowIsDue(row: RefreshRow, nowMs: number): boolean {
  const b = backoff.get(row.slug);
  if (b && b.nextAttemptAt > nowMs) return false;
  if (row.refresh_status === 'refreshing') {
    const since = refreshingSince.get(row.slug);
    if (since === undefined) {
      refreshingSince.set(row.slug, nowMs);
      return false; // probably another process, right now
    }
    return nowMs - since >= STALE_CLAIM_MS;
  }
  refreshingSince.delete(row.slug);
  return !row.refreshed_at || nowMs - Date.parse(row.refreshed_at) > WEEK_MS;
}

function backOff(slug: string, nowMs: number): void {
  const failures = (backoff.get(slug)?.failures ?? 0) + 1;
  backoff.set(slug, {
    failures,
    nextAttemptAt: nowMs + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), WEEK_MS),
  });
}

/**
 * Claim a row with a conditional update: it flips to 'refreshing' only if
 * it still holds exactly the state this run read. A second process (Railway
 * plus a laptop, or two replicas) that read the same row loses the race and
 * skips it — the in-process flag alone could not see the other process.
 */
async function claimRow(supabase: ReturnType<typeof getSupabase>, row: RefreshRow): Promise<boolean> {
  let claim = supabase
    .from('preset_trips')
    .update({ refresh_status: 'refreshing' })
    .eq('slug', row.slug)
    .eq('refresh_status', row.refresh_status);
  claim = row.refreshed_at == null ? claim.is('refreshed_at', null) : claim.eq('refreshed_at', row.refreshed_at);
  const { data, error } = await claim.select('slug');
  if (error) {
    logger.warn('preset refresh: could not claim row', { slug: row.slug, message: error.message });
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Weekly price refresh: re-price each DUE published preset
 * (repricePreset), then recompute the derived cost facts. `only` names
 * presets to re-price now, due or not (manual spot-checks).
 *
 * A preset is marked 'fresh' — and refreshed_at bumped — only when at least
 * one of its prices really came back from a live source and no search
 * failed. Anything else is 'failed' (the only other end state 013's CHECK
 * allows) with the reasons logged, and refreshed_at is left alone, so it
 * still says when the prices were last live. It used to stamp 'fresh' for
 * a week even when every provider came back empty (audit E5). Live prices
 * found on a failed attempt are still saved — they are real. A failed
 * preset backs off (12 h, doubling, capped at a week) instead of being
 * retried every tick, and every write is checked: a write that fails is a
 * failure, not a silent "refreshed".
 */
export async function refreshPresetPrices(
  now = new Date(),
  opts: { only?: string[] } = {},
): Promise<{
  refreshed: number;
  failed: number;
  /** Not due, backing off, or claimed by another process. */
  skipped: number;
}> {
  const supabase = getSupabase();
  let query = supabase
    .from('preset_trips')
    .select('slug, data, source, refresh_status, refreshed_at')
    .eq('status', 'published');
  const only = opts.only?.length ? opts.only : null;
  if (only) query = query.in('slug', only);
  const { data: rows, error } = await query;
  if (error) throw new Error(error.message);

  const nowMs = now.getTime();
  const start = new Date(nowMs + 30 * 86_400_000).toISOString().split('T')[0];
  const liveFlights = liveFlightFaresAvailable();
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;

  const markFailed = async (slug: string, why: string) => {
    failed++;
    backOff(slug, nowMs);
    logger.warn('preset refresh failed (non-fatal)', { slug, message: why });
    // Release the claim so the row isn't left 'refreshing'.
    const { error: releaseError } = await supabase
      .from('preset_trips')
      .update({ refresh_status: 'failed' })
      .eq('slug', slug);
    if (releaseError) {
      logger.warn('preset refresh: could not release row', { slug, message: releaseError.message });
    }
  };

  for (const row of (rows ?? []) as RefreshRow[]) {
    if ((!only && !rowIsDue(row, nowMs)) || !(await claimRow(supabase, row))) {
      skipped++;
      continue;
    }
    refreshingSince.delete(row.slug);
    const data: PresetData = JSON.parse(JSON.stringify(row.data));
    try {
      const outcome = await repricePreset(row.slug, data, start, liveFlights);
      const fresh = outcome.live > 0 && outcome.errors.length === 0;
      logger.info('preset refresh', {
        slug: row.slug,
        status: fresh ? 'fresh' : 'failed',
        live: outcome.live,
        kept: outcome.kept,
        errors: outcome.errors,
      });

      const patch: Record<string, unknown> = { refresh_status: fresh ? 'fresh' : 'failed' };
      if (outcome.live > 0) {
        const r = toRow(data, row.source);
        Object.assign(patch, {
          data,
          est_cost: r.est_cost,
          budget_tier: r.budget_tier,
          categories: r.categories,
        });
      }
      if (fresh) patch.refreshed_at = now.toISOString();
      const { error: writeError } = await supabase.from('preset_trips').update(patch).eq('slug', row.slug);
      if (writeError) {
        await markFailed(row.slug, `could not save: ${writeError.message}`);
      } else if (fresh) {
        refreshed++;
        backoff.delete(row.slug);
      } else {
        failed++;
        backOff(row.slug, nowMs);
      }
    } catch (err: any) {
      await markFailed(row.slug, err?.message ?? 'unexpected error');
    }
  }
  return { refreshed, failed, skipped };
}

// ── Weekly schedule ─────────────────────────────────────────────────────

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
