import { getSupabase } from './supabase';

/**
 * How many trips planned on BlueMurr put someone on a train: of the trips
 * that have at least one leg between two cities, the share with a train leg.
 *
 * Read-only — it counts the existing `transports` rows and writes nothing.
 * Every trip ever planned counts (archiving a trip doesn't un-plan it),
 * single-city trips don't (they have no leg to take a train on).
 *
 * Below MIN_TRIPS the share is too thin to quote, and the answer says so
 * (`percent: null`) rather than presenting "100% (1 of 1)" as a fact.
 */
export type RailDemand = {
  tripsWithLegs: number;
  tripsWithTrain: number;
  /** Whole percent, or null when there are too few trips to say. */
  percent: number | null;
  asOf: string;
};

export const MIN_TRIPS = 10;
const PAGE = 1000;
const CACHE_MS = 10 * 60 * 1000;
let cached: { at: number; value: RailDemand } | null = null;

export function railDemandFromLegs(rows: Array<{ trip_id: string; mode: string | null }>, now = new Date()): RailDemand {
  const modes = new Map<string, boolean>();
  for (const r of rows) {
    if (!r?.trip_id) continue;
    modes.set(r.trip_id, (modes.get(r.trip_id) ?? false) || r.mode === 'train');
  }
  const tripsWithLegs = modes.size;
  let tripsWithTrain = 0;
  modes.forEach((hasTrain) => {
    if (hasTrain) tripsWithTrain++;
  });
  return {
    tripsWithLegs,
    tripsWithTrain,
    percent: tripsWithLegs >= MIN_TRIPS ? Math.round((100 * tripsWithTrain) / tripsWithLegs) : null,
    asOf: now.toISOString(),
  };
}

export async function getRailDemand(): Promise<RailDemand> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const supabase = getSupabase();
  const rows: Array<{ trip_id: string; mode: string | null }> = [];
  // Paged: a select returns at most 1,000 rows.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('transports')
      .select('trip_id, mode')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as any[]));
    if (!data || data.length < PAGE) break;
  }
  const value = railDemandFromLegs(rows);
  cached = { at: Date.now(), value };
  return value;
}

/** Tests only. */
export function clearRailDemandCache(): void {
  cached = null;
}
