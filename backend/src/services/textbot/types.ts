/**
 * Group-text trip assistant — provider-independent types.
 *
 * A "thread" is one group conversation on a texting provider (a Sendblue
 * group_id, a Twilio Conversation SID, or a simulator id). The bot's core
 * (bot.ts) only ever sees these shapes; each provider adapter translates its
 * own webhook / poll payloads into InboundText and sends OutboundText.
 */

export type ProviderName = 'simulator' | 'sendblue' | 'twilio';

/** E.164 phone number, e.g. "+14155550123". Normalised by phone.ts. */
export type Phone = string;

export type InboundText = {
  provider: ProviderName;
  /** Provider's id for the group thread. A 1:1 chat uses the sender's number. */
  threadId: string;
  /** Who sent it. */
  from: Phone;
  /** Everyone in the thread as the provider reports it (bot excluded). */
  participants: Phone[];
  text: string;
  /** Provider message id — used to drop duplicate deliveries. */
  providerMessageId: string;
  receivedAt: string; // ISO
};

export type OutboundText = {
  provider: ProviderName;
  threadId: string;
  text: string;
};

/** A provider adapter. Real ones live in providers/; tests use the simulator. */
export interface TextProvider {
  readonly name: ProviderName;
  send(msg: OutboundText): Promise<void>;
}

/** What the trip-chat engine returns — the /api/plan/chat JSON union. */
export type ChatResult = {
  type: string; // 'answer' | 'proposal' | 'leg_refresh' | 'mode_comparison' | ...
  reply: string;
  [k: string]: unknown;
};

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

/** One function seam onto the results page's "BlueMurr AI" chat. */
export interface ChatEngine {
  run(input: { message: string; currentTrip: unknown; history: ChatTurn[] }): Promise<ChatResult>;
}

/** Loads a saved trip in the shape the chat expects (`currentTrip`). */
export interface TripLoader {
  load(tripId: string): Promise<{ trip: unknown; title: string } | null>;
  /** user ids allowed to see the trip: owner + accepted group members. */
  memberUserIds(tripId: string): Promise<string[]>;
}

/** Applies an accepted proposal to the saved trip. Null until wired. */
export interface ProposalApplier {
  apply(tripId: string, result: ChatResult, byUserId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}
