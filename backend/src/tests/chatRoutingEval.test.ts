/**
 * The labelled eval set (fixtures/chat-routing-eval.json), deterministic part:
 * every tier-0 case gets its template with the right facts, and every case
 * labelled tier 2 is sent to tier 2 before any model sees it. The model-
 * dependent part (tier 1) is measured live, once, by src/scripts/evalChatRouting.ts.
 */
jest.mock('../config/env', () => ({
  env: { NODE_ENV: 'test', DUFFEL_ACCESS_TOKEN: 't', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', ANTHROPIC_API_KEY: 'k', DB_REST_BASE_URL: 'https://x', ALLABOARD_API_URL: 'https://x', CORS_ORIGIN: 'http://localhost:3000', FRONTEND_URL: 'http://localhost:3000', API_PUBLIC_URL: 'http://localhost:4000', EMAIL_FROM: 't <t@example.com>', LOCATION_RESOLVER_MODE: 'shadow', PORT: 4000 },
}));
import { prefilter, tier0 } from '../services/chatRouter';

const trip = require('./fixtures/chat-trip-nyc-paris-london.json');
const cases: any[] = require('./fixtures/chat-routing-eval.json').cases;
const GREETING = { role: 'assistant' as const, content: "You're working on a 2-city trip. Ask me anything — swap transports, shift dates." };

it('the eval set has 50 cases', () => expect(cases).toHaveLength(50));

describe.each(cases.map((c) => [c.expectedTier, c.q, c] as const))('tier %s: %s', (tier, _q, c) => {
  const history = [GREETING, ...(c.history ?? [])];
  if (tier === 0) {
    it('is answered by a template with the right facts', () => {
      const t = tier0(c.q, trip, history);
      expect(t).not.toBeNull();
      for (const s of c.mustContain) expect(t!.reply).toContain(s);
    });
  } else if (tier === 2) {
    it('never reaches tier 0 or 1', () => {
      expect(tier0(c.q, trip, history)).toBeNull();
      expect(prefilter(c.q, history)).not.toBeNull();
    });
  } else {
    it('gets no template (tier 1 decides)', () => expect(tier0(c.q, trip, history)).toBeNull());
  }
});
