/**
 * One live calibration run of chat model routing on the labelled eval set
 * (src/tests/fixtures/chat-routing-eval.json, on chat-trip-nyc-paris-london.json).
 *
 * For every case:
 *   - the router's deterministic part (tier 0 / pre-filter) — no call;
 *   - tier 1 (TIER1_MODEL) for the cases that reach it — one call each;
 *   - today's tier-2 call (TIER2_MODEL, all tools, cached prompt) — one call
 *     each, as the baseline: which tool it picks and what it costs.
 * Tools are NOT run (no flight/train searches, no database). Prints a summary
 * and writes every result to EVAL_OUT (JSON).
 *
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   ANTHROPIC_API_KEY=… NODE_USE_ENV_PROXY=1 EVAL_OUT=out.json node dist/scripts/evalChatRouting.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getAnthropicSafe } from '../services/anthropic';
import { costUsd } from '../services/aiUsage';
import { prefilter, tier0, tier1, TIER1_MODEL, TIER2_MODEL, type ChatTurn } from '../services/chatRouter';
import { cachedChatTools, chatSystemBlocks } from '../services/tripChat';

const root = join(__dirname, '..', '..', 'src', 'tests', 'fixtures');
const trip = JSON.parse(readFileSync(join(root, 'chat-trip-nyc-paris-london.json'), 'utf8'));
const cases: any[] = JSON.parse(readFileSync(join(root, 'chat-routing-eval.json'), 'utf8')).cases;
const GREETING: ChatTurn = { role: 'assistant', content: "You're working on a 2-city trip. Ask me anything — swap transports, shift dates, rework a city, or ask why things are ordered this way." };

/** The same request at full price, as if nothing were cached: today's cost. */
const uncached = (model: string, u: any) =>
  costUsd(model, {
    input_tokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
    output_tokens: u?.output_tokens ?? 0,
  }) ?? 0;

async function main() {
  const anthropic = getAnthropicSafe();
  if (!anthropic) throw new Error('No ANTHROPIC_API_KEY');
  const system = chatSystemBlocks(trip);
  const tools = cachedChatTools();
  let calls = 0;
  const rows: any[] = [];

  for (const c of cases) {
    const history: ChatTurn[] = [GREETING, ...(c.history ?? [])];
    const row: any = { q: c.q, expectedTier: c.expectedTier };
    const t0 = tier0(c.q, trip, history);
    const pf = t0 ? null : prefilter(c.q, history);
    if (t0) Object.assign(row, { tier: 0, reply: t0.reply, reason: t0.intent });
    else if (pf) Object.assign(row, { tier: 2, reason: `prefilter:${pf.rule}` });
    else {
      calls++;
      const started = Date.now();
      const t1 = await tier1(anthropic, trip, system[1].text, c.q, history);
      row.tier1Ms = Date.now() - started;
      row.tier1Cost = costUsd(TIER1_MODEL, t1.usage) ?? 0;
      row.tier1Usage = t1.usage;
      if (t1.verdict === 'escalate' && t1.reason === 'tier1_error') throw new Error(`tier-1 call failed on "${c.q}" — check the model id / key`);
      if (t1.verdict === 'answer') Object.assign(row, { tier: 1, reply: t1.reply, reason: 'answer' });
      else Object.assign(row, { tier: 2, reason: `escalate:${t1.reason}` });
    }

    // Baseline: today's tier-2 request (tool not run).
    calls++;
    const started = Date.now();
    const res: any = await anthropic.messages.create({
      model: TIER2_MODEL,
      max_tokens: 1024,
      system,
      tools,
      messages: [...history, { role: 'user', content: c.q }].map((m) => ({ role: m.role, content: m.content })),
    } as any);
    row.tier2Ms = Date.now() - started;
    const use = res.content.find((b: any) => b.type === 'tool_use');
    row.sonnetTool = use?.name ?? null;
    row.sonnetReply = use?.name === 'answer_only' ? use.input?.answer : res.content.find((b: any) => b.type === 'text')?.text ?? '';
    row.tier2Usage = res.usage;
    row.tier2CostCached = costUsd(TIER2_MODEL, res.usage) ?? 0;
    row.tier2CostUncached = uncached(TIER2_MODEL, res.usage);

    // Verdicts
    row.dangerous = row.tier !== 2 && c.expectedTier === 2;
    row.factsOk = row.tier === 2 ? null : (c.mustContain ?? []).every((s: string) => String(row.reply).includes(s));
    row.sonnetToolOk = c.expectedTools ? c.expectedTools.includes(row.sonnetTool) : null;
    // After = what routing + caching costs for this question.
    row.costBefore = row.tier2CostUncached;
    row.costAfter = (row.tier1Cost ?? 0) + (row.tier === 2 ? row.tier2CostCached : 0);
    rows.push(row);
    process.stdout.write(`${row.tier} ${row.dangerous ? 'DANGER ' : ''}${row.factsOk === false ? 'FACTS? ' : ''}${c.q}\n`);
  }

  const sum = (f: (r: any) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const n = rows.length;
  const byTier = [0, 1, 2].map((t) => rows.filter((r) => r.tier === t).length);
  const t1Answered = rows.filter((r) => r.tier === 1);
  const summary = {
    calls,
    cases: n,
    tiers: { tier0: byTier[0], tier1: byTier[1], tier2: byTier[2] },
    dangerous: rows.filter((r) => r.dangerous).map((r) => r.q),
    tier1Answered: t1Answered.length,
    tier1FactsOk: t1Answered.filter((r) => r.factsOk).length,
    tier1Escalated: rows.filter((r) => String(r.reason).startsWith('escalate')).map((r) => `${r.q} [${r.reason}]`),
    tier0FactsOk: rows.filter((r) => r.tier === 0 && r.factsOk).length,
    sonnetToolAgreement: `${rows.filter((r) => r.sonnetToolOk === true).length}/${rows.filter((r) => r.sonnetToolOk !== null).length}`,
    cacheReadFromSecondCall: rows.slice(1).every((r) => (r.tier2Usage?.cache_read_input_tokens ?? 0) > 0),
    avgTier2InputTokens: Math.round(sum((r) => (r.tier2Usage?.input_tokens ?? 0) + (r.tier2Usage?.cache_read_input_tokens ?? 0) + (r.tier2Usage?.cache_creation_input_tokens ?? 0)) / n),
    costPerQuestionBefore: +(sum((r) => r.costBefore) / n).toFixed(5),
    costPerQuestionCachingOnly: +(sum((r) => r.tier2CostCached) / n).toFixed(5),
    costPerQuestionAfter: +(sum((r) => r.costAfter) / n).toFixed(5),
    medianMs: {
      tier1: median(rows.filter((r) => r.tier1Ms).map((r) => r.tier1Ms)),
      tier2: median(rows.map((r) => r.tier2Ms)),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, JSON.stringify({ summary, rows }, null, 2));
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

main().catch((e) => {
  console.error('eval failed:', e?.message);
  process.exit(1);
});
