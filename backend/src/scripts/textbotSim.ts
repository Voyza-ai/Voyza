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
 */
import { readFileSync } from 'fs';
import * as readline from 'readline';
import { TextBot } from '../services/textbot/bot';
import { LoopbackChatEngine } from '../services/textbot/chatEngine';
import { MemoryTextStore } from '../services/textbot/store';
import { SimulatorProvider } from '../services/textbot/providers/simulator';
import type { ProposalApplier, TripLoader } from '../services/textbot/types';

const [tripPath, ...rest] = process.argv.slice(2);
if (!tripPath) {
  console.error('usage: textbotSim.ts <trip.json> [--chat-url URL]');
  process.exit(1);
}
const chatUrlIdx = rest.indexOf('--chat-url');
const chatUrl = chatUrlIdx >= 0 ? rest[chatUrlIdx + 1] : undefined;

const trip = JSON.parse(readFileSync(tripPath, 'utf8'));
const TRIP_ID = String(trip.id ?? 'sim-trip');

const PEOPLE: Record<string, { userId: string; phone: string; role?: 'owner' | 'editor' | 'viewer' }> = {
  owner: { userId: 'u-owner', phone: '+14155550001', role: 'owner' },
  editor: { userId: 'u-editor', phone: '+14155550002', role: 'editor' },
  viewer: { userId: 'u-viewer', phone: '+14155550003', role: 'viewer' },
  stranger: { userId: 'u-stranger', phone: '+14155550009' },
};
const inGroup = new Set(['owner', 'editor', 'viewer']);

const store = new MemoryTextStore();
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
const bot = new TextBot({ store, chat: new LoopbackChatEngine(chatUrl), trips, provider, applier });

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
