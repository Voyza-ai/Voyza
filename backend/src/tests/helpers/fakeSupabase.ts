/**
 * A tiny in-memory stand-in for the parts of the supabase-js query builder the
 * text-bot store uses, with migration 016's keys enforced (unique violations
 * return code 23505 like PostgREST). Single-threaded JS makes each call atomic,
 * which matches the single-statement guarantees proven in the 016 rehearsal.
 */
type Row = Record<string, any>;

const KEYS: Record<string, string[][]> = {
  user_phones: [['user_id'], ['phone_e164']],
  text_threads: [['id'], ['provider', 'provider_thread_id']],
  text_link_codes: [['code']],
  text_phone_prefs: [['phone_e164']],
  blue_nudges: [['trip_id', 'nudge_key']],
  text_legs_booked: [['trip_id', 'leg_id']],
};
const DEFAULTS: Record<string, () => Row> = {
  text_threads: () => ({ id: `th-${Math.random().toString(36).slice(2)}`, history: [], participants: [], muted_until: null }),
  blue_nudges: () => ({ status: 'pending', thread_id: null }),
  text_phone_prefs: () => ({ opted_out_at: null, proactive_consent_at: null }),
};

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  calls: string[] = [];
  from(table: string) {
    this.tables[table] ??= [];
    return new Query(this, table);
  }
}

class Query implements PromiseLike<any> {
  private filters: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private returning = false;
  private mode: 'many' | 'maybeSingle' | 'single' = 'many';
  private countHead = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private cols = '*';

  constructor(private db: FakeSupabase, private table: string) {}

  select(cols = '*', opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') this.cols = cols;
    else this.returning = true;
    if (opts?.head) this.countHead = true;
    return this;
  }
  insert(p: Row | Row[]) { this.op = 'insert'; this.payload = p; return this; }
  upsert(p: Row | Row[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) { this.op = 'upsert'; this.payload = p; this.upsertOpts = o; return this; }
  update(p: Row) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this; }
  is(c: string, v: any) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  gt(c: string, v: any) { this.filters.push((r) => r[c] != null && r[c] > v); return this; }
  like(c: string, pat: string) {
    const re = new RegExp('^' + pat.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    this.filters.push((r) => re.test(String(r[c] ?? '')));
    return this;
  }
  order(col: string, o: { ascending?: boolean } = {}) { this.orderBy = { col, asc: o.ascending !== false }; return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.mode = 'maybeSingle'; return this; }
  single() { this.mode = 'single'; return this; }

  then<A, B>(ok?: (v: any) => A | PromiseLike<A>, bad?: (e: any) => B | PromiseLike<B>): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }

  private rows() { return this.db.tables[this.table]; }
  private match(r: Row) { return this.filters.every((f) => f(r)); }
  private conflict(row: Row, keys: string[][], except?: Row): Row | null {
    for (const k of keys) {
      const hit = this.rows().find((r) => r !== except && k.every((c) => r[c] !== undefined && r[c] === row[c]));
      if (hit) return hit;
    }
    return null;
  }
  private out(data: Row[]) {
    const pick = (r: Row) => (this.cols === '*' ? { ...r } : Object.fromEntries(this.cols.split(',').map((c) => [c.trim(), r[c.trim()]])));
    if (this.mode === 'many') return { data: data.map(pick), error: null };
    if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
    if (!data.length && this.mode === 'single') return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    return { data: data[0] ? pick(data[0]) : null, error: null };
  }

  private run(): any {
    this.db.calls.push(`${this.op} ${this.table}`);
    const keys = KEYS[this.table] ?? [];
    if (this.op === 'select') {
      let data = this.rows().filter((r) => this.match(r));
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        data = [...data].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.lim !== null) data = data.slice(0, this.lim);
      if (this.countHead) return { data: null, count: data.length, error: null };
      return this.out(data);
    }
    if (this.op === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload!];
      for (const p of list) {
        const row = { ...(DEFAULTS[this.table]?.() ?? {}), ...p };
        if (this.conflict(row, keys)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        this.rows().push(row);
      }
      return { data: null, error: null };
    }
    if (this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const onKey = (this.upsertOpts.onConflict ?? keys[0]?.join(',') ?? '').split(',').map((s) => s.trim());
      const written: Row[] = [];
      for (const p of list) {
        const existing = this.rows().find((r) => onKey.every((c) => r[c] === p[c]));
        if (existing) {
          if (this.upsertOpts.ignoreDuplicates) continue;
          const next = { ...existing, ...p };
          if (this.conflict(next, keys, existing)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          Object.assign(existing, p);
          written.push(existing);
        } else {
          const row = { ...(DEFAULTS[this.table]?.() ?? {}), ...p };
          if (this.conflict(row, keys)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          this.rows().push(row);
          written.push(row);
        }
      }
      return this.returning ? this.out(written) : { data: null, error: null };
    }
    if (this.op === 'update') {
      const hit = this.rows().filter((r) => this.match(r));
      for (const r of hit) Object.assign(r, this.payload);
      return this.returning ? this.out(hit) : { data: null, error: null };
    }
    // delete
    const keep = this.rows().filter((r) => !this.match(r));
    this.db.tables[this.table] = keep;
    return { data: null, error: null };
  }
}
