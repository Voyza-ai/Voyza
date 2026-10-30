/**
 * Audit E19: two migrations were numbered 013 — the live-DB record
 * (013_preset_marketplace.sql) and a duplicate that re-declared the same
 * tables and was the only home of record_preset_event() — plus a dry-run
 * file sitting in migrations/ where `supabase db push` would pick it up.
 * Static checks only: nothing here connects to a database.
 */
import fs from 'fs';
import path from 'path';

const SUPABASE = path.join(__dirname, '..', '..', 'supabase');
const MIGRATIONS = path.join(SUPABASE, 'migrations');
const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const read = (f: string) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
/** SQL with -- comments removed, so commented-out examples don't count. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('supabase/migrations hygiene (E19)', () => {
  it('every migration has its own number', () => {
    const numbers = files.map((f) => f.slice(0, 3));
    const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('holds migrations only — rehearsals live in supabase/dry-runs/', () => {
    expect(files.filter((f) => /dry-run/i.test(f))).toEqual([]);
    const dryRuns = fs.readdirSync(path.join(SUPABASE, 'dry-runs'));
    expect(dryRuns).toContain('013-014_preset_marketplace.dry-run.sql');
  });

  it('defines each preset table once, and record_preset_event once', () => {
    const count = (re: RegExp) => files.filter((f) => re.test(code(read(f)))).length;
    expect(count(/create table if not exists public\.preset_trips/i)).toBe(1);
    expect(count(/create table if not exists public\.preset_events/i)).toBe(1);
    expect(count(/create (or replace )?function public\.record_preset_event/i)).toBe(1);
  });

  it('014 creates the function only when it is missing, and never replaces a live one', () => {
    const sql = code(read('014_record_preset_event.sql'));
    expect(sql).toMatch(/to_regprocedure\('public\.record_preset_event\(text, text\)'\) is null/);
    expect(sql).not.toMatch(/create or replace function/i);
    expect(sql).toMatch(/revoke execute on function public\.record_preset_event\(text, text\) from public;/);
  });

  it('no migration drops the live preset tables, even in a commented-out reversal', () => {
    for (const f of files) {
      expect([f, /drop table[^;]*preset_(trips|events)/i.test(read(f))]).toEqual([f, false]);
    }
  });
});
