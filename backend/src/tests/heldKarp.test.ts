/**
 * B5 — bestOrderingsByMatrix is exact.
 *
 * For 6+ cities the optimizer used to score at most three hand-built
 * orderings, measured 13-27% dearer than the best country-clustered
 * ordering. It now runs Held–Karp (k-best) over a pairwise price matrix.
 * These tests compare it against brute force — every permutation, the same
 * clustering rule, the same cost — on many random matrices for n ≤ 8.
 */
jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

import { bestOrderingsByMatrix } from '../services/optimizer';

/** Deterministic PRNG (mulberry32) so a failure is reproducible by seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array(n).fill(false);
  const go = () => {
    if (cur.length === n) return void out.push([...cur]);
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      go();
      cur.pop();
      used[i] = false;
    }
  };
  go();
  return out;
}

/**
 * Every known country's cities are contiguous. A city whose country is
 * unknown counts as its own one-city country: it may go anywhere, but it
 * does sit BETWEEN its neighbours (FR, ?, FR is not contiguous France).
 */
function clustered(order: number[], country: Array<string | undefined>): boolean {
  const seen = new Set<string>();
  let current: string | undefined;
  for (const i of order) {
    const c = country[i] ?? `?${i}`;
    if (c !== current) {
      if (seen.has(c)) return false;
      seen.add(c);
      current = c;
    }
  }
  return true;
}

type Instance = {
  n: number;
  legM: number[][];
  outV: number[];
  retV: number[];
  country: Array<string | undefined>;
};

function randomInstance(n: number, r: () => number): Instance {
  const price = () => {
    const x = r();
    if (x < 0.08) return 5000; // an unpriceable inter-city leg (penalty)
    return Math.floor(r() * 1000);
  };
  const legM = Array.from({ length: n }, () => Array.from({ length: n }, price));
  const outV = Array.from({ length: n }, () => (r() < 0.05 ? 100000 : Math.floor(r() * 2000)));
  const retV = Array.from({ length: n }, () => (r() < 0.05 ? 100000 : Math.floor(r() * 2000)));
  const countries = ['FR', 'IT', 'ES', 'PT'].slice(0, 1 + Math.floor(r() * 4));
  const country = Array.from({ length: n }, () =>
    r() < 0.15 ? undefined : countries[Math.floor(r() * countries.length)],
  );
  return { n, legM, outV, retV, country };
}

const costOf = (order: number[], inst: Instance) => {
  let c = inst.outV[order[0]] + inst.retV[order[order.length - 1]];
  for (let i = 0; i + 1 < order.length; i++) c += inst.legM[order[i]][order[i + 1]];
  return c;
};

describe('bestOrderingsByMatrix vs brute force', () => {
  const perms: Record<number, number[][]> = {};
  const trials: Record<number, number> = { 1: 20, 2: 50, 3: 200, 4: 200, 5: 200, 6: 150, 7: 40, 8: 12 };

  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`matches brute force on ${trials[n]} random ${n}-city matrices (top-3 costs, validity)`, () => {
      perms[n] = perms[n] ?? permutations(n);
      for (let seed = 1; seed <= trials[n]; seed++) {
        const r = rng(n * 10007 + seed);
        const inst = randomInstance(n, r);

        const brute = perms[n]
          .filter((o) => clustered(o, inst.country))
          .map((o) => costOf(o, inst))
          .sort((a, b) => a - b)
          .slice(0, 3);

        const got = bestOrderingsByMatrix({
          n,
          leg: (i, j) => inst.legM[i][j],
          out: (i) => inst.outV[i],
          ret: (i) => inst.retV[i],
          country: inst.country,
          k: 3,
        });

        const ctxMsg = `n=${n} seed=${seed}`;
        expect({ ctxMsg, costs: got.map((g) => g.cost) }).toEqual({ ctxMsg, costs: brute });
        const seen = new Set<string>();
        for (const g of got) {
          // A real permutation, clustered, whose reported cost is its cost.
          expect([...g.order].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
          expect(clustered(g.order, inst.country)).toBe(true);
          expect(costOf(g.order, inst)).toBe(g.cost);
          seen.add(g.order.join(','));
        }
        expect(seen.size).toBe(got.length); // three DIFFERENT orderings
      }
    });
  }

  it('keeps countries contiguous (Japan / China, the case the old heuristic broke)', () => {
    // 0 Tokyo, 1 Beijing, 2 Osaka, 3 Shanghai, 4 Kyoto, 5 Chengdu; every leg
    // costs the same, so only the constraint shapes the answer.
    const country = ['JP', 'CN', 'JP', 'CN', 'JP', 'CN'];
    const got = bestOrderingsByMatrix({ n: 6, leg: () => 100, out: () => 0, ret: () => 0, country, k: 3 });
    expect(got).toHaveLength(3);
    for (const g of got) {
      const seq = g.order.map((i) => country[i]);
      const switches = seq.filter((c, i) => i > 0 && c !== seq[i - 1]).length;
      expect(switches).toBe(1);
    }
  });

  it('prefers a missing ground leg over a missing home flight (same penalties as rankCost)', () => {
    // City 0 has no outbound/return (100000); its legs are unpriceable (5000).
    const n = 3;
    const got = bestOrderingsByMatrix({
      n,
      leg: (i, j) => (i === 0 || j === 0 ? 5000 : 150),
      out: (i) => (i === 0 ? 100000 : 600),
      ret: (i) => (i === 0 ? 100000 : 580),
      country: [undefined, undefined, undefined],
      k: 1,
    });
    expect(got[0].order[1]).toBe(0);
  });
});
