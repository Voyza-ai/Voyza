/**
 * services/aiUsage: every Claude call reports model, tokens and time to
 * PostHog (AI observability) — never the prompt or the reply — and the call
 * itself is unchanged.
 */
import { aiGenerationEvent, createMessage } from '../services/aiUsage';

const response = {
  model: 'claude-sonnet-4-5',
  stop_reason: 'tool_use',
  usage: { input_tokens: 7200, output_tokens: 310, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  content: [{ type: 'text', text: 'a reply about Paris' }],
};
const params = { model: 'claude-sonnet-4-5', max_tokens: 1024, system: 'You are BlueMurr AI… TRIP CONTEXT {"title":"Paris"}', messages: [{ role: 'user', content: 'add a dinner in Paris' }] };

it('the event carries the feature, model, token counts and latency — and nothing of the prompt or reply', () => {
  const e = aiGenerationEvent('chat', params, response, 2345);
  expect(e.event).toBe('$ai_generation');
  expect(e.properties).toMatchObject({
    $ai_span_name: 'chat', feature: 'chat', $ai_provider: 'anthropic', $ai_model: 'claude-sonnet-4-5',
    $ai_input_tokens: 7200, $ai_output_tokens: 310, $ai_latency: 2.345, $ai_is_error: false, $ai_http_status: 200,
  });
  const json = JSON.stringify(e);
  expect(json).not.toMatch(/Paris|dinner|BlueMurr AI|TRIP CONTEXT|a reply/);
});

it('createMessage returns the same response and passes the same params', async () => {
  const create = jest.fn().mockResolvedValue(response);
  await expect(createMessage({ messages: { create } }, 'activities', params)).resolves.toBe(response);
  expect(create).toHaveBeenCalledWith(params);
});

it('createMessage rethrows the same error, and records the failure', async () => {
  const err = Object.assign(new Error('overloaded'), { status: 529 });
  const create = jest.fn().mockRejectedValue(err);
  await expect(createMessage({ messages: { create } }, 'chat', params)).rejects.toBe(err);
  expect(aiGenerationEvent('chat', params, null, 10, err).properties).toMatchObject({ $ai_is_error: true, $ai_http_status: 529, $ai_model: 'claude-sonnet-4-5' });
});

it('sends to PostHog only with POSTHOG_KEY set, outside tests', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue(new Response('{}') as any);
  const env = { ...process.env };
  const create = jest.fn().mockResolvedValue(response);
  delete process.env.POSTHOG_KEY;
  process.env.NODE_ENV = 'development';
  await createMessage({ messages: { create } }, 'chat', params);
  expect(fetchSpy).not.toHaveBeenCalled();
  process.env.POSTHOG_KEY = 'phc_test';
  await createMessage({ messages: { create } }, 'chat', params);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as any;
  expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
  expect(JSON.parse(init.body)).toMatchObject({ api_key: 'phc_test', event: '$ai_generation' });
  process.env = env;
  fetchSpy.mockRestore();
});
