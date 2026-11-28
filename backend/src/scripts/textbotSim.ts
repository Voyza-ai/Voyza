/**
 * Local simulator for the group-text bot. DEVELOPMENT ONLY — not a live test.
 *
 *   npx tsx src/scripts/textbotSim.ts <trip.json> [--chat-url http://127.0.0.1:4000/api/plan/chat]
 *
 * Talks to the REAL /api/plan/chat (start the backend first) about a trip read
 * from a JSON file in the GET /api/trips/:id `trip` shape. Nothing touches
 * Supabase or a texting provider: the store is in memory, edits are recorded,
 * not applied.
 *
 * Type lines as "<sender>: <text>", senders being owner / editor / viewer /
 * stranger. Everyone except "stranger" is in the group unless you type
 * "/add stranger". Commands: /code link|verify <sender>, /add <s>, /remove <s>,
 * /quit. "$CODE" in a line is replaced by the last code made.
 * Nudges: /time <ISO> sets the fake clock, /book <legId> marks a leg booked,
 * /nudge runs the "Blue texts first" engine once. --stub-chat skips the AI.
 */
import { readFileSync } from 'fs';
import * as readline from 'readline';
import { TextBot } from '../services/textbot/bot';
import { LoopbackChatEngine } from '../services/textbot/chatEngine';
import { MemoryTextStore } from '../services/textbot/store';
import { SimulatorProvider } from '../services/textbot/providers/simulator';
import { NudgeEngine } from '../services/textbot/nudges';
import type { ChatEngine, ProposalApplier, TripLoader } from '../services/textbot/types';

const [tripPath, ...rest] = process.argv.slice(2);
if (!tripPath) {
  console.error('usage: textbotSim.ts <trip.json> [--chat-url URL]');
  process.exit(1);
}
const chatUrlIdx = rest.indexOf('--chat-url');
const chatUrl = chatUrlIdx >= 0 ? rest[chatUrlIdx + 1] : undefined;
/** --stub-chat: answer with a canned line instead of calling the AI (owner's rule: no AI unless testing replies). */
const stubChat = rest.includes('--stub-chat');

const trip = JSON.parse(readFileSync(tripPath, 'utf8'));
const TRIP_ID = String(trip.id ?? 'sim-trip');

const PEOPLE: Record<string, { userId: string; phone: string; role?: 'owner' | 'editor' | 'viewer' }> = {
  owner: { userId: 'u-owner', phone: '+14155550001', role: 'owner' },
  editor: { userId: 'u-editor', phone: '+14155550002', role: 'editor' },
  viewer: { userId: 'u-viewer', phone: '+14155550003', role: 'viewer' },
  stranger: { userId: 'u-stranger', phone: '+14155550009' },
};
const inGroup = new Set(['owner', 'editor', 'viewer']);

let clock = Date.now(); // "/time <ISO>" moves it
const store = new MemoryTextStore(() => clock);
const booked = new Set<string>(); // "/book <legId>"

const trips: TripLoader = {
  async load(id) {
    return id === TRIP_ID ? { trip, title: String(trip.title ?? 'Trip'), updatedAt: 'sim' } : null;
  },
  async members(id) {
    const m = new Map<string, 'owner' | 'editor' | 'viewer'>();
    if (id !== TRIP_ID) return m;
    for (const p of Object.values(PEOPLE)) if (p.role) m.set(p.userId, p.role);
    return m;
  },
};
const applier: ProposalApplier = {
  async apply(_id, result) {
    console.log('  [sim] WOULD APPLY (not applied):', JSON.stringify(result).slice(0, 400));
    // Never claim a save that didn't happen, even in the simulator.
    return { ok: false, reason: 'this is the simulator, which never saves' };
  },
};
const provider = new SimulatorProvider((m) => console.log(`  BlueMurr ▸ ${m.text.replace(/\n/g, '\n             ')}`));
const chat: ChatEngine = stubChat
  ? { run: async ({ message }) => ({ type: 'answer', reply: `[stub AI] you asked: ${message}` }) }
  : new LoopbackChatEngine(chatUrl);
const bot = new TextBot({ store, chat, trips, provider, applier, now: () => clock });
const nudges = new NudgeEngine({ store, trips, provider, bookings: { isBooked: async (_t, leg) => booked.has(leg.id) } });

let n = 0;
let lastCode = '';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
console.log(`Trip "${trip.title}" (${TRIP_ID}). Try: /code link owner, then "owner: link CODE".`);
rl.prompt();
let chain: Promise<void> = Promise.resolve();
rl.on('line', (line) => {
  chain = chain.then(() => onLine(line));
});
rl.on('close', () => { void chain.then(() => process.exit(0)); });
async function onLine(line: string) {
  const l = line.trim().replace(/\$CODE/g, lastCode);
  try {
    if (l === '/quit') return rl.close();
    let t = l.match(/^\/time (.+)$/);
    if (t) {
      const ms = Date.parse(t[1]);
      if (!Number.isFinite(ms)) return console.log('  ? /time 2027-05-15T12:50:00Z');
      clock = ms;
      return console.log(`  [clock] ${new Date(clock).toISOString()}`);
    }
    if ((t = l.match(/^\/book (.+)$/))) {
      booked.add(t[1]);
      return console.log(`  [bookings] booked: ${[...booked].join(', ')}`);
    }
    if (l === '/nudge') {
      const r = await nudges.runOnce(clock);
      return console.log(`  [nudge run] ${r.map((x) => `${x.status}${x.key ? ` ${x.key}` : ''}${x.reason ? ` (${x.reason})` : ''}`).join('; ') || 'no linked trips'}`);
    }
    let m = l.match(/^\/code (link|verify) (\w+)$/);
    if (m && PEOPLE[m[2]]) {
      const c = await store.createCode(m[1] as 'link' | 'verify', TRIP_ID, PEOPLE[m[2]].userId);
      lastCode = c.code;
      console.log(`  [app] ${m[2]}'s ${m[1]} code: ${c.code}  (type $CODE to use it)`);
    } else if ((m = l.match(/^\/(add|remove) (\w+)$/)) && PEOPLE[m[2]]) {
      m[1] === 'add' ? inGroup.add(m[2]) : inGroup.delete(m[2]);
      console.log(`  [group] ${[...inGroup].join(', ')}`);
    } else if ((m = l.match(/^(\w+):\s*(.+)$/)) && PEOPLE[m[1]]) {
      const from = PEOPLE[m[1]].phone;
      const participants = [...inGroup].map((s) => PEOPLE[s].phone).filter((p) => p !== from);
      const out = await bot.handle({
        provider: 'simulator', threadId: 'sim-group', from, participants, text: m[2],
        providerMessageId: `sim-${++n}`, receivedAt: new Date().toISOString(),
      });
      if (!out.length) console.log('  (bot stayed quiet)');
    } else if (l) {
      console.log('  ? "<owner|editor|viewer|stranger>: text", /code link|verify <who>, /add|/remove <who>, /quit');
    }
  } catch (err: any) {
    console.log('  error:', err?.message);
  }
  rl.prompt();
}
