/**
 * Group-text trip assistant core (services/textbot/bot.ts). Everything is in
 * memory: the chat engine, trip loader and applier are fakes, the provider is
 * the simulator. Nothing here touches Supabase, Anthropic or a texting API.
 */
import { TextBot } from '../services/textbot/bot';
import { MemoryTextStore } from '../services/textbot/store';
import { SimulatorProvider } from '../services/textbot/providers/simulator';
import type { ChatEngine, ChatResult, InboundText, ProposalApplier, TripLoader } from '../services/textbot/types';

const OWNER = 'user-owner';
const EDITOR = 'user-editor';
const VIEWER = 'user-viewer';
const STRANGER = 'user-stranger';
const TRIP = 'trip-1';

const P_OWNER = '+14155550001';
const P_EDITOR = '+14155550002';
const P_VIEWER = '+14155550003';
const P_OUTSIDER = '+14155550009';

function setup(opts: { chat?: (m: string) => ChatResult; applier?: ProposalApplier | null } = {}) {
  let t = 1_000_000;
  const store = new MemoryTextStore(() => t);
  const provider = new SimulatorProvider();
  const chatCalls: Array<{ message: string; history: any[] }> = [];
  const chat: ChatEngine = {
    async run({ message, history }) {
      chatCalls.push({ message, history });
      return opts.chat ? opts.chat(message) : { type: 'answer', reply: `**Answer** to: ${message}` };
    },
  };
  const members = new Map<string, 'owner' | 'editor' | 'viewer'>([
    [OWNER, 'owner'],
    [EDITOR, 'editor'],
    [VIEWER, 'viewer'],
  ]);
  const trips: TripLoader = {
    async load(id) {
      return id === TRIP ? { trip: { title: 'Paris & London' }, title: 'Paris & London' } : null;
    },
    async members(id) {
      return id === TRIP ? members : new Map();
    },
  };
  const applied: any[] = [];
  const applier: ProposalApplier | null =
    opts.applier !== undefined
      ? opts.applier
      : {
          async apply(tripId, result, by) {
            applied.push({ tripId, result, by });
            return { ok: true };
          },
        };
  const bot = new TextBot({
    store,
    chat,
    trips,
    provider,
    applier,
    now: () => t,
    config: { siteUrl: 'http://localhost:3000' },
  });
  let n = 0;
  const send = (from: string, text: string, participants: string[] = [], threadId = 'g1', id?: string) =>
    bot.handle({
      provider: 'simulator',
      threadId,
      from,
      participants,
      text,
      providerMessageId: id ?? `m${++n}`,
      receivedAt: new Date(t).toISOString(),
    } as InboundText);
  return {
    bot, store, provider, chatCalls, applied, members, send,
    advance: (ms: number) => { t += ms; },
  };
}

const GROUP = [P_OWNER, P_EDITOR, P_VIEWER];

async function linkedGroup(env: ReturnType<typeof setup>) {
  const link = await env.store.createCode('link', TRIP, OWNER);
  await env.send(P_OWNER, `link ${link.code}`, GROUP);
  for (const [u, p] of [[EDITOR, P_EDITOR], [VIEWER, P_VIEWER]] as const) {
    const c = await env.store.createCode('verify', TRIP, u);
    await env.send(p, `verify ${c.code}`, GROUP);
  }
}

describe('textbot: addressing', () => {
  it('ignores ordinary group chatter and does not call the AI', async () => {
    const env = setup();
    await linkedGroup(env);
    const out = await env.send(P_OWNER, 'what time should we leave for dinner?', GROUP);
    expect(out).toEqual([]);
    expect(env.chatCalls).toHaveLength(0);
  });

  it('does not wake on a word that merely contains the wake word', async () => {
    const env = setup();
    await linkedGroup(env);
    expect(await env.send(P_OWNER, 'the murray hotel was nice', GROUP)).toEqual([]);
  });

  it('answers 1:1 messages without a wake word', async () => {
    const env = setup();
    const out = await env.send(P_OWNER, 'hello', []);
    expect(out[0]).toMatch(/isn't linked to a trip/);
  });
});

describe('textbot: linking and verification', () => {
  it('links a thread with an owner code and binds the sender phone', async () => {
    const env = setup();
    const c = await env.store.createCode('link', TRIP, OWNER);
    const out = await env.send(P_OWNER, `link ${c.code.toLowerCase()}`, GROUP);
    expect(out[0]).toMatch(/Linked to "Paris & London"/);
    expect((await env.store.getThread('simulator', 'g1'))?.tripId).toBe(TRIP);
    expect((await env.store.userForPhone(P_OWNER))?.userId).toBe(OWNER);
  });

  it('a code works once', async () => {
    const env = setup();
    const c = await env.store.createCode('link', TRIP, OWNER);
    await env.send(P_OWNER, `link ${c.code}`, GROUP);
    const out = await env.send(P_OUTSIDER, `link ${c.code}`, [P_OUTSIDER], 'g2');
    expect(out[0]).toMatch(/didn't work/);
    expect(await env.store.getThread('simulator', 'g2')).toBeNull();
    expect(await env.store.userForPhone(P_OUTSIDER)).toBeNull();
  });

  it('an expired code is refused', async () => {
    const env = setup();
    const c = await env.store.createCode('link', TRIP, OWNER);
    env.advance(15 * 60_000 + 1);
    expect((await env.send(P_OWNER, `link ${c.code}`, GROUP))[0]).toMatch(/didn't work/);
    expect(await env.store.getThread('simulator', 'g1')).toBeNull();
  });

  it('a verify code cannot be used to link', async () => {
    const env = setup();
    const c = await env.store.createCode('verify', TRIP, OWNER);
    const out = await env.send(P_OWNER, `link ${c.code}`, GROUP);
    expect(out[0]).toMatch(/didn't work/);
    expect(await env.store.getThread('simulator', 'g1')).toBeNull();
  });

  it('a viewer can verify but not link', async () => {
    const env = setup();
    const c = await env.store.createCode('link', TRIP, VIEWER);
    const out = await env.send(P_VIEWER, `link ${c.code}`, GROUP);
    expect(out[0]).toMatch(/only the trip owner or an editor can link/);
    expect(await env.store.getThread('simulator', 'g1')).toBeNull();
    expect((await env.store.userForPhone(P_VIEWER))?.userId).toBe(VIEWER);
  });

  it('a code from someone no longer on the trip is refused', async () => {
    const env = setup();
    const c = await env.store.createCode('link', TRIP, STRANGER);
    const out = await env.send(P_OUTSIDER, `link ${c.code}`, [P_OUTSIDER]);
    expect(out[0]).toMatch(/isn't on this trip/);
    expect(await env.store.userForPhone(P_OUTSIDER)).toBeNull();
  });

  it('locks a number out after 5 wrong codes, even if the 6th is right', async () => {
    const env = setup();
    for (let i = 0; i < 5; i++) await env.send(P_OUTSIDER, 'link ZZZZZZ', [P_OUTSIDER]);
    const good = await env.store.createCode('link', TRIP, OWNER);
    const out = await env.send(P_OUTSIDER, `link ${good.code}`, [P_OUTSIDER]);
    expect(out[0]).toMatch(/Too many wrong codes/);
    // The good code was not burned by the locked-out attempt.
    expect((await env.send(P_OWNER, `link ${good.code}`, GROUP))[0]).toMatch(/Linked/);
  });
});

describe('textbot: privacy', () => {
  it('shares nothing while an unverified number is in the thread', async () => {
    const env = setup();
    const c = await env.store.createCode('link', TRIP, OWNER);
    await env.send(P_OWNER, `link ${c.code}`, GROUP);
    const out = await env.send(P_OWNER, 'BlueMurr where are we staying in Paris?', GROUP);
    expect(out[0]).toMatch(/can't share trip details while •••0002, •••0003 aren't verified/);
    expect(out[0]).not.toContain('+1415');
    expect(env.chatCalls).toHaveLength(0);
  });

  it('a verified member of a DIFFERENT trip still counts as an outsider', async () => {
    const env = setup();
    await linkedGroup(env);
    await env.store.linkPhone(STRANGER, P_OUTSIDER);
    const out = await env.send(P_OWNER, 'BlueMurr hi', [...GROUP, P_OUTSIDER]);
    expect(out[0]).toMatch(/•••0009 isn't verified/);
    expect(env.chatCalls).toHaveLength(0);
  });

  it('answers once everyone is verified, as plain text', async () => {
    const env = setup();
    await linkedGroup(env);
    const out = await env.send(P_VIEWER, 'Hey BlueMurr, where are we staying in Paris?', GROUP);
    expect(env.chatCalls[0].message).toBe('where are we staying in Paris?');
    expect(out[0]).toBe('Answer to: where are we staying in Paris?');
  });

  it('a member removed from the trip loses access', async () => {
    const env = setup();
    await linkedGroup(env);
    env.members.delete(VIEWER);
    const out = await env.send(P_OWNER, 'BlueMurr hi', GROUP);
    expect(out[0]).toMatch(/•••0003 isn't verified/);
  });
});

describe('textbot: edits need confirmation', () => {
  const proposal = (): ChatResult => ({
    type: 'proposal',
    reply: "Here's your trip with London added at the end. Adds 1 night. Accept to apply it.",
    proposal: { kind: 'city_edit' },
  });

  it('asks for YES, does not apply on the request itself', async () => {
    const env = setup({ chat: proposal });
    await linkedGroup(env);
    const out = await env.send(P_VIEWER, 'BlueMurr add a night in London', GROUP);
    expect(out[0]).toMatch(/Reply YES to apply/);
    expect(out[0]).not.toMatch(/Accept to apply/);
    expect(env.applied).toHaveLength(0);
  });

  it('a viewer YES is refused; an editor YES applies once', async () => {
    const env = setup({ chat: proposal });
    await linkedGroup(env);
    await env.send(P_VIEWER, 'BlueMurr add a night in London', GROUP);
    expect((await env.send(P_VIEWER, 'yes', GROUP))[0]).toMatch(/Only the trip owner or an editor/);
    expect(env.applied).toHaveLength(0);
    const out = await env.send(P_EDITOR, 'Yes!', GROUP);
    expect(out[0]).toMatch(/^Done: Here's your trip with London added/);
    expect(env.applied).toEqual([{ tripId: TRIP, result: expect.objectContaining({ type: 'proposal' }), by: EDITOR }]);
    // A second YES does nothing: the pending edit is gone and "yes" alone isn't addressed.
    expect(await env.send(P_OWNER, 'yes', GROUP)).toEqual([]);
    expect(env.applied).toHaveLength(1);
  });

  it('NO drops it', async () => {
    const env = setup({ chat: proposal });
    await linkedGroup(env);
    await env.send(P_OWNER, 'BlueMurr add a night in London', GROUP);
    expect((await env.send(P_EDITOR, 'no', GROUP))[0]).toMatch(/dropped/);
    expect(await env.send(P_OWNER, 'yes', GROUP)).toEqual([]);
    expect(env.applied).toHaveLength(0);
  });

  it('an expired pending edit is not applied', async () => {
    const env = setup({ chat: proposal });
    await linkedGroup(env);
    await env.send(P_OWNER, 'BlueMurr add a night in London', GROUP);
    env.advance(11 * 60_000);
    expect(await env.send(P_OWNER, 'yes', GROUP)).toEqual([]);
    expect(env.applied).toHaveLength(0);
  });

  it('a failed apply says nothing changed', async () => {
    const env = setup({
      chat: proposal,
      applier: { apply: async () => ({ ok: false, reason: 'the trip changed on the website since' }) },
    });
    await linkedGroup(env);
    await env.send(P_OWNER, 'BlueMurr add a night in London', GROUP);
    expect((await env.send(P_OWNER, 'yes', GROUP))[0]).toBe(
      "I couldn't apply it: the trip changed on the website since. Nothing was changed.",
    );
  });

  it('without an applier, YES points to the website instead of pretending', async () => {
    const env = setup({ chat: proposal, applier: null });
    await linkedGroup(env);
    await env.send(P_OWNER, 'BlueMurr add a night in London', GROUP);
    expect((await env.send(P_OWNER, 'yes', GROUP))[0]).toMatch(/can't apply changes from texts yet.*\/trips\/trip-1/);
  });
});

describe('textbot: abuse and robustness', () => {
  it('drops a redelivered message id', async () => {
    const env = setup();
    await linkedGroup(env);
    await env.send(P_OWNER, 'BlueMurr hi', GROUP, 'g1', 'dup');
    expect(await env.send(P_OWNER, 'BlueMurr hi', GROUP, 'g1', 'dup')).toEqual([]);
    expect(env.chatCalls).toHaveLength(1);
  });

  it('rate-limits one person with a single notice, then silence', async () => {
    const env = setup();
    await linkedGroup(env);
    const outs: string[][] = [];
    for (let i = 0; i < 11; i++) outs.push(await env.send(P_VIEWER, `BlueMurr q${i}`, GROUP));
    // 1 verify + 7 questions fit in 8/min; then one notice; then silence.
    expect(env.chatCalls).toHaveLength(7);
    expect(outs[7][0]).toMatch(/faster than I can keep up/);
    expect(outs[8]).toEqual([]);
    env.advance(61_000);
    expect((await env.send(P_VIEWER, 'BlueMurr again', GROUP))[0]).toMatch(/Answer/);
  });

  it('caps AI turns per thread', async () => {
    const env = setup();
    await linkedGroup(env);
    let last: string[] = [];
    for (let i = 0; i < 31; i++) {
      last = await env.send([P_OWNER, P_EDITOR, P_VIEWER][i % 3], `BlueMurr q${i}`, GROUP);
      if (i % 3 === 2) env.advance(20_000);
    }
    expect(env.chatCalls).toHaveLength(30);
    expect(last[0]).toMatch(/hit my message limit/);
  });

  it('a chat engine failure gives a short apology, not a crash', async () => {
    const env = setup({ chat: () => { throw new Error('boom'); } });
    await linkedGroup(env);
    expect((await env.send(P_OWNER, 'BlueMurr hi', GROUP))[0]).toMatch(/something went wrong/);
  });

  it('unlink is editor+ only and forgets history', async () => {
    const env = setup();
    await linkedGroup(env);
    await env.send(P_OWNER, 'BlueMurr hi', GROUP);
    expect((await env.send(P_VIEWER, 'BlueMurr unlink', GROUP))[0]).toMatch(/Only the trip owner or an editor/);
    expect((await env.send(P_OWNER, 'BlueMurr unlink', GROUP))[0]).toMatch(/no longer linked/);
    expect(await env.store.getThread('simulator', 'g1')).toBeNull();
    expect(await env.store.history('simulator:g1')).toEqual([]);
  });

  it('passes recent history to the chat engine', async () => {
    const env = setup();
    await linkedGroup(env);
    await env.send(P_OWNER, 'BlueMurr first', GROUP);
    await env.send(P_OWNER, 'BlueMurr second', GROUP);
    expect(env.chatCalls[1].history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'Answer to: first' },
    ]);
  });
});
