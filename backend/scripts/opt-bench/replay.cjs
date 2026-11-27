'use strict';
/**
 * Record/replay for provider HTTP — benchmark harness only, never product code.
 *
 * Preloaded into a backend process with NODE_OPTIONS="--require <this file>".
 * It wraps the two HTTP clients the optimize path uses:
 *   - global fetch   (All Aboard, Deutsche Bahn REST, FX rates, RapidAPI, Supabase)
 *   - node-fetch     (the Duffel SDK)
 * and, per OPTBENCH_MODE:
 *   record  every request goes live; the response, its headers and its
 *           latency (request sent -> body read) are appended to the tape.
 *   topup   requests already on the tape are replayed; the rest go live and
 *           are appended (used once per trip for the other version's misses).
 *   replay  everything is served from the tape after the recorded latency; a
 *           request that is not on the tape fails as a network error and is
 *           logged as a MISS (the run is then not a fair replay).
 *   off     nothing is wrapped.
 *
 * Tape key: method + URL + body. All Aboard's GraphQL query text is
 * whitespace-normalised and its random `session` header is ignored. A key
 * recorded several times (a rail search retried after an incomplete answer)
 * is served in recorded order; past the last recording the last one repeats.
 *
 * Duffel 429s on the tape are skipped on replay: whether a search is rate
 * limited depends on everything else sent in that minute, not on the search.
 * Instead OPTBENCH_DUFFEL_LIMIT (e.g. 30) simulates Duffel's per-token window
 * on replay (see duffelGate): past the limit in a window, the next request is
 * answered 429 with a `ratelimit-reset` header, as Duffel does.
 *
 * Supabase is never contacted (the backends run on a dummy project): every
 * request to *.supabase.co is answered locally as an EMPTY database, in every
 * mode — see the stub in intercept().
 *
 * Every request is logged to OPTBENCH_LOG (JSONL) with timing and a summary.
 */
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const Module = require('module');

const MODE = process.env.OPTBENCH_MODE || 'off';
if (MODE !== 'off') install();

function install() {
  const TAPE = process.env.OPTBENCH_TAPE;
  const LOG = process.env.OPTBENCH_LOG;
  const DUFFEL_LIMIT = Number(process.env.OPTBENCH_DUFFEL_LIMIT || 0);
  const T0 = Date.now();
  if (!TAPE) throw new Error('OPTBENCH_TAPE is required');

  /** key -> recordings[] (in recorded order) */
  let tape = null;
  const cursors = new Map();
  function loadTape() {
    if (tape) return tape;
    tape = new Map();
    if (fs.existsSync(TAPE)) {
      for (const line of fs.readFileSync(TAPE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        if (!tape.has(rec.key)) tape.set(rec.key, []);
        tape.get(rec.key).push(rec);
      }
    }
    return tape;
  }

  function log(entry) {
    if (!LOG) return;
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  }

  const hostKind = (url) => {
    const h = url.hostname;
    if (h.endsWith('supabase.co')) return 'supabase';
    if (h === 'api.duffel.com') return 'duffel';
    if (h.endsWith('allaboard.eu')) return 'allaboard';
    if (h.endsWith('db.transport.rest')) return 'dbrest';
    if (h.endsWith('er-api.com')) return 'fx';
    if (h.endsWith('rapidapi.com')) return 'rapidapi';
    return 'other';
  };

  function bodyText(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body.toString('utf8');
    if (body instanceof URLSearchParams) return body.toString();
    return String(body);
  }

  /** What identifies a request on the tape, plus a short human summary. */
  function describe(method, urlStr, rawBody) {
    const url = new URL(urlStr);
    const kind = hostKind(url);
    const text = bodyText(rawBody);
    let norm = text;
    let summary = `${method} ${url.pathname}`;
    let op = kind;
    if (kind === 'allaboard' && text) {
      try {
        const b = JSON.parse(text);
        const q = String(b.query || '').replace(/\s+/g, ' ').trim();
        norm = JSON.stringify({ q, v: b.variables || {} });
        const name = (q.match(/\{\s*(\w+)\s*\(/) || [])[1] || 'gql';
        op = `aa.${name}`;
        summary = `${name} ${JSON.stringify(b.variables || {})}`;
        // party size is in the query text for getJourneyOffer
        const pax = (q.match(/\{type: ADULT\}/g) || []).length;
        if (name === 'getJourneyOffer') summary += ` pax=${pax}`;
      } catch {}
    } else if (kind === 'duffel') {
      if (url.pathname.includes('offer_requests')) {
        op = 'duffel.offer_request';
        try {
          const s = JSON.parse(text).data.slices[0];
          const pax = JSON.parse(text).data.passengers.length;
          summary = `${s.origin}-${s.destination} ${s.departure_date} pax=${pax}`;
        } catch {}
      } else if (url.pathname.includes('suggestions')) {
        op = 'duffel.suggestions';
        summary = `suggestions ${url.searchParams.get('query')}`;
      } else {
        op = `duffel.${url.pathname}`;
      }
    } else if (kind === 'rapidapi') {
      op = 'rapidapi';
      summary = `${url.pathname}${url.search}`.slice(0, 160);
    } else if (kind === 'dbrest') {
      op = 'dbrest';
      summary = `${url.pathname}${url.search}`.slice(0, 160);
    }
    const key = crypto.createHash('sha1').update(`${method} ${url.href}\n${norm}`).digest('hex');
    return { kind, op, key, summary, url: url.href };
  }

  /** A short readout of a response, for the log. */
  function inspect(op, status, text) {
    try {
      if (op === 'aa.getJourneys') {
        const j = JSON.parse(text);
        const list = (j.data && j.data.getJourneys) || [];
        const statuses = new Set();
        let withSegs = 0;
        for (const x of list) {
          if (x.status) statuses.add(x.status);
          let segs = 0;
          for (const it of x.itinerary || []) {
            if (it.status) statuses.add(it.status);
            segs += (it.segments || []).length;
          }
          if (segs > 0) withSegs++;
        }
        return { journeys: list.length, withSegments: withSegs, statuses: [...statuses], errors: j.errors ? j.errors.map((e) => e.message) : undefined };
      }
      if (op === 'aa.getJourneyOffer') {
        const j = JSON.parse(text);
        const it = (j.data && j.data.getJourneyOffer && j.data.getJourneyOffer.itinerary) || [];
        const statuses = [...new Set(it.map((x) => x.status).filter(Boolean))];
        const amounts = it.flatMap((x) => (x.offers || []).map((o) => o.price && o.price.amount)).filter((a) => typeof a === 'number');
        return { statuses, offers: amounts.length, min: amounts.length ? Math.min(...amounts) / 100 : null, errors: j.errors ? j.errors.map((e) => e.message) : undefined };
      }
      if (op === 'aa.getLocations') {
        const j = JSON.parse(text);
        return { locations: ((j.data && j.data.getLocations) || []).slice(0, 5).map((l) => `${l.name}=${l.uid}`) };
      }
      if (op === 'duffel.offer_request') {
        if (status !== 200 && status !== 201) return { status };
        const j = JSON.parse(text);
        const offers = (j.data && j.data.offers) || [];
        const prices = offers.map((o) => parseFloat(o.total_amount)).filter((p) => p > 0);
        return { offers: offers.length, min: prices.length ? Math.min(...prices) : null };
      }
    } catch {}
    return undefined;
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  function abortError() {
    try {
      return new DOMException('This operation was aborted', 'AbortError');
    } catch {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      return e;
    }
  }
  function networkError() {
    return new TypeError('fetch failed');
  }

  const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
  function headerPairs(headers) {
    const out = [];
    headers.forEach((v, k) => {
      if (!DROP_HEADERS.has(k.toLowerCase())) out.push([k, v]);
    });
    return out;
  }

  // ── Duffel rate-limit simulation (replay only) ──────────────────────
  // Duffel answers every request with `ratelimit-limit: 30` and a
  // `ratelimit-reset` on the next wall-clock minute (measured 2026-11-24):
  // fixed one-minute windows. Simulated as fixed 60 s windows that start
  // OPTBENCH_DUFFEL_PHASE seconds before the run's first Duffel request
  // (default 0: the run starts with a fresh window — the best case).
  const PHASE_MS = Number(process.env.OPTBENCH_DUFFEL_PHASE || 0) * 1000;
  let windowStart = null;
  let windowCount = 0;
  function duffelGate(now) {
    if (!DUFFEL_LIMIT) return null;
    if (windowStart === null) windowStart = now - PHASE_MS;
    while (now >= windowStart + 60_000) {
      windowStart += 60_000;
      windowCount = 0;
    }
    if (windowCount >= DUFFEL_LIMIT) return windowStart + 60_000;
    windowCount++;
    return null;
  }

  /** Pick the recording to serve for this key, or null for a miss. */
  function pick(desc, forTopup) {
    const recs = loadTape().get(desc.key);
    if (!recs || recs.length === 0) return null;
    let usable = recs;
    if (desc.kind === 'duffel') {
      const not429 = recs.filter((r) => r.status !== 429);
      if (not429.length === 0) return forTopup ? null : { rec: recs[recs.length - 1], index: recs.length - 1 };
      usable = not429;
    }
    const i = cursors.get(desc.key) || 0;
    // Top-up: a rail search asked more times than the tape holds (variant C's
    // retry of a route-day) is a new question to the provider, not the same
    // answer again — go live and record it.
    if (forTopup && desc.op === 'aa.getJourneys' && i >= usable.length) return null;
    cursors.set(desc.key, i + 1);
    const index = Math.min(i, usable.length - 1);
    return { rec: usable[index], index };
  }

  /**
   * The one interceptor. `realFetch` sends live; `makeResponse(buf, init)`
   * builds the client's own Response type.
   */
  async function intercept(client, realFetch, makeResponse, input, init) {
    init = init || {};
    const urlStr = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    let desc;
    try {
      desc = describe(method, urlStr, init.body);
    } catch {
      return realFetch(input, init);
    }
    const tReq = Date.now() - T0;
    const signal = init.signal;

    if (desc.kind === 'supabase') {
      // An empty database, answered locally the way PostgREST would — never
      // the network. A network error here is retried by postgrest-js with a
      // 1/2/4 s backoff (3 retries per GET), which would add ~7 s to every
      // leg_price_cache read and swamp the timings. Production's Supabase
      // answers a cold trip's cache reads with no rows in tens of ms.
      const headersIn = new Headers((init && init.headers) || (input && input.headers) || {});
      const accept = headersIn.get('accept') || '';
      await sleep(40, signal);
      log({ t: tReq, client, op: 'supabase', served: 'stub', summary: desc.summary });
      if (method === 'GET' || method === 'HEAD') {
        if (accept.includes('vnd.pgrst.object')) {
          return makeResponse(
            Buffer.from(JSON.stringify({ code: 'PGRST116', details: 'The result contains 0 rows', hint: null, message: 'JSON object requested, multiple (or no) rows returned' })),
            { status: 406, statusText: 'Not Acceptable', headers: [['content-type', 'application/json']], url: desc.url },
          );
        }
        return makeResponse(Buffer.from('[]'), { status: 200, statusText: 'OK', headers: [['content-type', 'application/json'], ['content-range', '*/0']], url: desc.url });
      }
      return makeResponse(Buffer.from(''), { status: 201, statusText: 'Created', headers: [], url: desc.url });
    }

    const replayRec = MODE === 'replay' || MODE === 'topup' ? pick(desc, MODE === 'topup') : null;

    if (replayRec) {
      const { rec, index } = replayRec;
      // The simulated window as it stood when this request was accepted.
      let stamp = null;
      if (MODE === 'replay' && desc.kind === 'duffel') {
        const resetAt = duffelGate(Date.now());
        if (!resetAt && DUFFEL_LIMIT) stamp = { remaining: DUFFEL_LIMIT - windowCount, resetAt: windowStart + 60_000 };
        if (resetAt) {
          // Simulated 429: refused quickly, like Duffel does.
          await sleep(150, signal);
          const body = JSON.stringify({
            meta: { status: 429, request_id: 'optbench-sim' },
            errors: [{ type: 'rate_limit_error', code: 'rate_limit_exceeded', title: 'Rate limit exceeded', message: 'Simulated by optbench' }],
          });
          log({ t: tReq, done: Date.now() - T0, client, op: desc.op, served: 'sim429', status: 429, summary: desc.summary, ms: 150 });
          return makeResponse(Buffer.from(body), {
            status: 429,
            statusText: 'Too Many Requests',
            headers: [
              ['content-type', 'application/json'],
              ['ratelimit-limit', String(DUFFEL_LIMIT)],
              ['ratelimit-remaining', '0'],
              ['ratelimit-reset', new Date(resetAt).toUTCString()],
            ],
            url: desc.url,
          });
        }
      }
      try {
        await sleep(rec.latencyMs, signal);
      } catch (e) {
        log({ t: tReq, done: Date.now() - T0, client, op: desc.op, served: `tape#${index}`, error: 'AbortError', summary: desc.summary, ms: Date.now() - T0 - tReq, recordedMs: rec.latencyMs });
        throw e;
      }
      if (rec.error) {
        log({ t: tReq, done: Date.now() - T0, client, op: desc.op, served: `tape#${index}`, error: rec.error.name, summary: desc.summary, ms: rec.latencyMs });
        if (rec.error.name === 'AbortError') throw abortError();
        throw networkError();
      }
      const buf = zlib.gunzipSync(Buffer.from(rec.body, 'base64'));
      log({ t: tReq, done: Date.now() - T0, client, op: desc.op, served: `tape#${index}`, status: rec.status, summary: desc.summary, ms: rec.latencyMs, info: inspect(desc.op, rec.status, buf.toString('utf8')) });
      let headersOut = rec.headers;
      if (stamp) {
        // The recorded ratelimit-* headers describe the recording's minute,
        // not this replay's: state the simulated window instead, as Duffel
        // would (the optimizer paces itself on them).
        headersOut = rec.headers
          .filter(([k]) => !/^ratelimit-/i.test(k))
          .concat([
            ['ratelimit-limit', String(DUFFEL_LIMIT)],
            ['ratelimit-remaining', String(Math.max(0, stamp.remaining))],
            ['ratelimit-reset', new Date(stamp.resetAt).toUTCString()],
          ]);
      }
      return makeResponse(buf, { status: rec.status, statusText: rec.statusText || '', headers: headersOut, url: desc.url });
    }

    if (MODE === 'replay') {
      log({ t: tReq, client, op: desc.op, served: 'MISS', summary: desc.summary, key: desc.key });
      throw networkError();
    }

    // record, or a top-up miss: go live.
    const started = Date.now();
    let res;
    try {
      res = await realFetch(input, init);
    } catch (err) {
      const latencyMs = Date.now() - started;
      const name = err && err.name === 'AbortError' ? 'AbortError' : 'NetworkError';
      appendTape({ key: desc.key, op: desc.op, summary: desc.summary, url: desc.url, method, error: { name, message: String(err && err.message) }, latencyMs, recordedAt: new Date().toISOString() });
      log({ t: tReq, done: Date.now() - T0, client, op: desc.op, served: 'live', error: name, summary: desc.summary, ms: latencyMs });
      throw err;
    }
    let buf;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      const latencyMs = Date.now() - started;
      const name = err && err.name === 'AbortError' ? 'AbortError' : 'NetworkError';
      appendTape({ key: desc.key, op: desc.op, summary: desc.summary, url: desc.url, method, error: { name, message: String(err && err.message) }, latencyMs, recordedAt: new Date().toISOString() });
      log({ t: tReq, done: Date.now() - T0, client, op: desc.op, served: 'live', error: name, summary: desc.summary, ms: latencyMs });
      throw err;
    }
    const latencyMs = Date.now() - started;
    const headers = headerPairs(res.headers);
    appendTape({
      key: desc.key,
      op: desc.op,
      summary: desc.summary,
      url: desc.url,
      method,
      status: res.status,
      statusText: res.statusText,
      headers,
      body: zlib.gzipSync(buf).toString('base64'),
      latencyMs,
      recordedAt: new Date().toISOString(),
    });
    log({ t: tReq, done: Date.now() - T0, client, op: desc.op, served: 'live', status: res.status, summary: desc.summary, ms: latencyMs, info: inspect(desc.op, res.status, buf.toString('utf8')), rl: headers.filter(([k]) => /ratelimit|quota|limit/i.test(k)) });
    return makeResponse(buf, { status: res.status, statusText: res.statusText, headers, url: desc.url });
  }

  function appendTape(rec) {
    fs.appendFileSync(TAPE, JSON.stringify(rec) + '\n');
    if (tape) {
      if (!tape.has(rec.key)) tape.set(rec.key, []);
      tape.get(rec.key).push(rec);
      // The live call just made is the newest one this process has "used".
      cursors.set(rec.key, tape.get(rec.key).length);
    }
  }

  // ── global fetch ────────────────────────────────────────────────────
  const realGlobalFetch = globalThis.fetch;
  globalThis.fetch = function optbenchFetch(input, init) {
    return intercept(
      'fetch',
      realGlobalFetch,
      (buf, r) => {
        const nullBody = r.status === 204 || r.status === 304;
        return new Response(nullBody ? null : buf, { status: r.status, statusText: r.statusText, headers: r.headers });
      },
      input,
      init,
    );
  };

  // ── node-fetch (the Duffel SDK) ─────────────────────────────────────
  const wrapped = new Map();
  const realLoad = Module._load;
  Module._load = function optbenchLoad(request, parent, isMain) {
    const exported = realLoad.apply(this, arguments);
    if (request !== 'node-fetch') return exported;
    if (wrapped.has(exported)) return wrapped.get(exported);
    const real = exported;
    const fn = function nodeFetchOptbench(input, init) {
      return intercept(
        'node-fetch',
        real,
        (buf, r) => new real.Response(buf, { status: r.status, statusText: r.statusText, headers: r.headers, url: r.url }),
        input,
        init,
      );
    };
    Object.assign(fn, real);
    fn.default = fn;
    wrapped.set(exported, fn);
    return fn;
  };
}
