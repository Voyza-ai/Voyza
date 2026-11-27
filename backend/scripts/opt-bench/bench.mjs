#!/usr/bin/env node
/**
 * One benchmark run: start a backend (version A or B) with the record/replay
 * preload, POST one trip to /api/optimize, poll its progress, save the answer
 * and the provider request log, stop the backend.
 *
 *   node bench.mjs --version A --dir <backend dir> --trip T1 --mode replay \
 *     --port 4100 --tapes <dir> --out <dir> [--tag r1] [--two-phase]
 *     [--limit 30] [--phase 0] [--variant C|B2] [--slots 8] [--budget 30]
 *
 *   --mode     record | topup | replay (see replay.cjs)
 *   --limit    Duffel searches per one-minute window, replay only (Duffel: 30)
 *   --phase    seconds of that window already gone when the run starts
 *   --variant  OPT_VARIANT for version B; --slots / --budget override the
 *              rail gate (trains.ts) and PLAN_SEARCH_BUDGET (optimizer.ts)
 *
 * Every backend runs on a dummy Supabase project, stubbed locally as an empty
 * database by replay.cjs: nothing is read from or written to the real one.
 *
 * A fresh process per run: flights.ts, trains.ts and allaboard.ts keep
 * process-wide caches, so a second run in the same process would be warm.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) {
      const next = all[i + 1];
      acc.push([a.slice(2), next && !next.startsWith('--') ? next : true]);
    }
    return acc;
  }, []),
);

export const TRIPS = {
  T1: { cities: ['Paris', 'Amsterdam', 'Berlin'], origin: 'New York', originAirports: ['JFK', 'EWR', 'LGA'] },
  T2: { cities: ['Paris', 'Amsterdam', 'Berlin', 'Prague'], origin: 'New York', originAirports: ['JFK', 'EWR', 'LGA'] },
  T3: { cities: ['Paris', 'Amsterdam', 'Berlin', 'Prague', 'Vienna'], origin: 'New York', originAirports: ['JFK', 'EWR', 'LGA'] },
  T4: { cities: ['Lisbon', 'Sintra'], origin: 'Boston', originAirports: ['BOS'], totalNights: 4 },
};

export function tripBody(id) {
  const t = TRIPS[id];
  return {
    cities: t.cities.map((name) => ({ name })),
    startDate: '2027-01-12',
    travelers: 2,
    origin: t.origin,
    originAirports: t.originAirports,
    returnToHome: true,
    totalNights: t.totalNights ?? 2 * t.cities.length + 1,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const version = String(args.version);
  const dir = path.resolve(String(args.dir));
  const trip = String(args.trip);
  const mode = String(args.mode);
  const port = Number(args.port);
  const tapes = path.resolve(String(args.tapes));
  const out = path.resolve(String(args.out));
  const tag = args.tag ? String(args.tag) : 'r1';
  const twoPhase = !!args['two-phase'];
  const limit = args.limit ? String(args.limit) : '30';
  const variant = args.variant ? String(args.variant) : '';
  // Rail search slots (trains.ts MAX_CONCURRENT_TRAIN_SEARCHES), B only.
  const slots = args.slots ? String(args.slots) : '';
  // PLAN_SEARCH_BUDGET override (optimizer.ts), B only.
  const budget = args.budget ? String(args.budget) : '';
  // Seconds already gone from Duffel's minute window when the run starts.
  const phase = args.phase ? String(args.phase) : '0';
  // POST /api/optimize/prewarm first, then wait this many seconds (the rest
  // of the chat: budget and notes) before POST /api/optimize. Version N only.
  const prewarmGap = args.prewarm !== undefined ? Number(args.prewarm) : null;
  // Rail for ranking: 'full' to rank on the full All Aboard search (N only).
  const rankingRail = args['ranking-rail'] ? String(args['ranking-rail']) : '';
  const railRetry = args['rail-retry'] !== undefined ? String(args['rail-retry']) : '';
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(tapes, { recursive: true });

  const name = `${trip}-${version}${variant ? '-' + variant : ''}${slots ? '-s' + slots : ''}${budget ? '-b' + budget : ''}${rankingRail ? '-rr' + rankingRail : ''}${railRetry ? '-retry' + railRetry : ''}${prewarmGap !== null ? '-g' + prewarmGap : ''}${twoPhase ? '-2p' : ''}-${mode}${mode === 'replay' ? '-p' + phase : ''}-${tag}`;
  const reqLog = path.join(out, `${name}.req.jsonl`);
  const srvLog = path.join(out, `${name}.server.log`);
  for (const f of [reqLog, srvLog]) if (fs.existsSync(f)) fs.unlinkSync(f);

  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  Object.assign(env, {
    NODE_USE_ENV_PROXY: '1',
    PORT: String(port),
    NODE_ENV: 'development',
    CORS_ORIGIN: 'http://localhost:3000',
    SUPABASE_URL: 'https://dummyproj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy',
    DUFFEL_ACCESS_TOKEN: 'duffel_test_placeholder',
    RAPIDAPI_KEY: 'placeholder',
    ALLABOARD_API_KEY: 'placeholder',
    NODE_OPTIONS: `--require ${path.join(here, 'replay.cjs')}`,
    OPTBENCH_MODE: mode,
    OPTBENCH_TAPE: path.join(tapes, `${trip}.tape.jsonl`),
    OPTBENCH_LOG: reqLog,
    OPTBENCH_DUFFEL_LIMIT: mode === 'replay' ? limit : '0',
    OPTBENCH_DUFFEL_PHASE: phase,
    ...(variant ? { OPT_VARIANT: variant } : {}),
    ...(slots ? { OPT_TRAIN_SLOTS: slots } : {}),
    ...(budget ? { OPT_PLAN_BUDGET: budget } : {}),
    ...(rankingRail ? { OPT_RANKING_RAIL: rankingRail } : {}),
    ...(railRetry ? { OPT_RAIL_RETRY: railRetry } : {}),
  });
  // All Aboard's own counters, before and after a live run (production shares
  // the key, so a delta can include someone else's searches).
  const quota = () => {
    if (mode === 'replay') return null;
    try {
      const out = execFileSync('node', [path.join(here, 'aaquota.mjs')], {
        env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_OPTIONS: '' },
        encoding: 'utf8',
        timeout: 20_000,
      });
      const q = {};
      for (const line of out.trim().split('\n')) {
        const r = JSON.parse(line);
        if (r.resource) q[`${r.resource}/${r.unit}`] = r.remaining;
      }
      return q;
    } catch {
      return null;
    }
  };
  const quotaBefore = quota();
  const logStream = fs.createWriteStream(srvLog);
  const child = spawn('npx', ['tsx', 'src/index.ts'], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverText = '';
  const onData = (d) => {
    logStream.write(d);
    serverText += d.toString();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  };
  process.on('exit', stop);

  const base = `http://127.0.0.1:${port}`;
  // Ready: answers / and has built its location index (a 0.4 s CPU block).
  const readyBy = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > readyBy) throw new Error('backend did not start:\n' + serverText.slice(-2000));
    try {
      const r = await fetch(`${base}/`);
      if (r.ok && /Location index built|location index/i.test(serverText)) break;
    } catch {}
    await sleep(200);
  }
  await sleep(500);

  const progressId = `optbench-${trip}-${version}-${Date.now().toString(36)}`;
  const body = { ...tripBody(trip), progressId, ...(twoPhase ? { twoPhase: true } : {}) };
  let prewarm = null;
  if (prewarmGap !== null) {
    const p0 = Date.now();
    const r = await fetch(`${base}/api/optimize/prewarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tripBody(trip)),
    });
    prewarm = { status: r.status, body: await r.json(), answeredMs: Date.now() - p0, gapMs: prewarmGap * 1000 };
    await sleep(Math.max(0, prewarmGap * 1000 - (Date.now() - p0)));
  }
  const timeline = [];
  const stages = {};
  const t0 = Date.now();
  let done = false;
  const poll = (async () => {
    while (!done) {
      try {
        const r = await fetch(`${base}/api/optimize/progress/${progressId}`);
        if (r.ok) {
          const p = await r.json();
          const t = Date.now() - t0;
          if (!stages[p.stage]) stages[p.stage] = t;
          const last = timeline[timeline.length - 1];
          if (!last || last.stage !== p.stage || last.legsPriced !== p.legsPriced || last.flightSearches !== p.flightSearches) {
            timeline.push({ t, stage: p.stage, legsAsked: p.legsAsked, legsPriced: p.legsPriced, flightSearches: p.flightSearches });
          }
        }
      } catch {}
      await sleep(50);
    }
  })();

  const res = await fetch(`${base}/api/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseMs = Date.now() - t0;
  const json = await res.json();
  let finalMs = null;
  let finalJson = null;
  if (json && json.finalPending) {
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      const r = await fetch(`${base}/api/optimize/final/${progressId}`);
      if (r.status === 200) {
        finalJson = await r.json();
        finalMs = Date.now() - t0;
        break;
      }
      await sleep(50);
    }
  }
  done = true;
  await poll;
  // Let any background provider calls still running land in the log (they
  // spend quota even though no answer waits on them), then stop.
  const settle = Number(args.settle ?? (mode === 'replay' ? 2000 : 5000));
  await sleep(settle);
  stop();
  logStream.end();
  const quotaAfter = quota();
  const quotaUsed =
    quotaBefore && quotaAfter ? Object.fromEntries(Object.keys(quotaBefore).map((k) => [k, quotaBefore[k] - quotaAfter[k]])) : null;
  const prewarmLine = serverText.split('\n').find((l) => l.includes('"Optimize prewarm"'));

  const result = {
    name,
    version,
    variant: variant || null,
    slots: slots || null,
    budget: budget || null,
    duffelPhase: Number(phase),
    trip,
    mode,
    twoPhase,
    duffelLimit: mode === 'replay' ? Number(limit) : 0,
    rankingRail: rankingRail || null,
    railRetry: railRetry || null,
    prewarm: prewarm ? { ...prewarm, server: prewarmLine ? JSON.parse(prewarmLine.slice(prewarmLine.indexOf('{'))) : null } : null,
    quotaUsed,
    status: res.status,
    responseMs,
    finalMs,
    stages,
    timeline,
    response: json,
    final: finalJson,
  };
  fs.writeFileSync(path.join(out, `${name}.result.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ name, status: res.status, responseMs, finalMs, finishingAt: stages.finishing ?? null, quotaUsed }));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
