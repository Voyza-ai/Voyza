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
import { spawn } from 'node:child_process';
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
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(tapes, { recursive: true });

  const name = `${trip}-${version}${variant ? '-' + variant : ''}${slots ? '-s' + slots : ''}${budget ? '-b' + budget : ''}${twoPhase ? '-2p' : ''}-${mode}${mode === 'replay' ? '-p' + phase : ''}-${tag}`;
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
  });
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
    status: res.status,
    responseMs,
    finalMs,
    stages,
    timeline,
    response: json,
    final: finalJson,
  };
  fs.writeFileSync(path.join(out, `${name}.result.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ name, status: res.status, responseMs, finalMs, finishingAt: stages.finishing ?? null }));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
