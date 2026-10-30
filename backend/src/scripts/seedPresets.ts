/**
 * Sync the bundled catalog (curated.json + generated.json) into the
 * preset_trips table (migration 013).
 *  - Upserts every bundled preset by slug. Engagement counters and refresh
 *    state are never overwritten (they're not in the upsert payload).
 *  - Prunes GENERATED presets that are no longer in generated.json (e.g.
 *    after regenerating). Their engagement events cascade-delete. Curated
 *    rows are never pruned.
 * Safe to re-run.
 *
 *   npx tsx src/scripts/seedPresets.ts
 */
import { getSupabase } from '../services/supabase';
import { bundledCatalog, toRow } from '../services/presets';

(async () => {
  const supabase = getSupabase();
  const rows = bundledCatalog().map(({ data, source }) => toRow(data, source));
  const { error } = await supabase.from('preset_trips').upsert(rows, { onConflict: 'slug' });
  if (error) {
    console.error('❌ seed failed:', error.message);
    console.error(
      '   Have migrations 013_preset_marketplace.sql and 014_record_preset_event.sql been applied in the Supabase SQL editor?',
    );
    process.exit(1);
  }

  const keep = new Set(rows.map((r) => r.slug));
  const { data: generatedRows } = await supabase
    .from('preset_trips')
    .select('slug')
    .eq('source', 'generated');
  const stale = (generatedRows ?? []).map((r: any) => r.slug).filter((s: string) => !keep.has(s));
  if (stale.length > 0) {
    const { error: delErr } = await supabase.from('preset_trips').delete().in('slug', stale);
    if (delErr) {
      console.error('❌ prune failed:', delErr.message);
      process.exit(1);
    }
  }
  console.log(`✅ seeded ${rows.length} presets into preset_trips; pruned ${stale.length} stale generated: ${stale.join(', ') || 'none'}`);
  process.exit(0);
})();
