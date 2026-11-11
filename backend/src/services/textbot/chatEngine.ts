import { env } from '../../config/env';
import type { ChatEngine, ChatResult, ChatTurn } from './types';

/**
 * The ONE seam between the text bot and the results page's "BlueMurr AI"
 * chat (POST /api/plan/chat in routes/plan.ts). Not a copy: until plan.ts
 * exports its handler as a function (requested from the BlueMurr work
 * session as `runPlanChat`), this calls the real route over loopback HTTP
 * on this same backend process, so every fix to the chat reaches the bot.
 * Swapping to the import is a one-line change here.
 */
export class LoopbackChatEngine implements ChatEngine {
  constructor(
    private url = process.env.TEXTBOT_CHAT_URL || `http://127.0.0.1:${env.PORT}/api/plan/chat`,
    private timeoutMs = 60_000,
  ) {}

  async run(input: { message: string; currentTrip: unknown; history: ChatTurn[] }): Promise<ChatResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`plan/chat HTTP ${res.status}`);
      const body = (await res.json()) as ChatResult;
      if (!body || typeof body.type !== 'string') throw new Error('plan/chat returned no type');
      return { ...body, reply: String(body.reply ?? '') };
    } finally {
      clearTimeout(timer);
    }
  }
}
