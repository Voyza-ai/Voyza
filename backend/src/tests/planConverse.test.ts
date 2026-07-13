/**
 * Conversational planner — service + route contract.
 * The Anthropic client is mocked; we test the mapping and error taxonomy,
 * not the model.
 */
import express from 'express';
import request from 'supertest';

const mockCreate = jest.fn();
jest.mock('../services/anthropic', () => ({
  getAnthropicSafe: jest.fn(() => ({ messages: { create: mockCreate } })),
  getAnthropic: jest.fn(),
  DEFAULT_MODEL: 'claude-test',
}));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';
import { getAnthropicSafe } from '../services/anthropic';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plan', planRouter);
  app.use(errorHandler);
  return app;
}

const toolResponse = (input: any) => ({
  content: [{ type: 'tool_use', name: 'respond_to_traveler', input }],
});

describe('POST /api/plan/converse', () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
    (getAnthropicSafe as jest.Mock).mockReturnValue({ messages: { create: mockCreate } });
  });

  it('maps a multi-fact message into reply + updates + action', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({
        reply: 'Italy in October for two — lovely. Which cities are calling you?',
        updates: {
          countries: [{ country: 'Italy', cities: ['Rome', 'Florence', 'Venice', 'Milan'] }],
          dates: { start: '2026-10-01', end: '2026-10-15' },
          travelers: 2,
        },
        action: 'show_city_picker',
        quickReplies: ['Rome + Florence', 'Surprise me'],
      }),
    );

    const res = await request(app)
      .post('/api/plan/converse')
      .send({
        message: 'me and my girlfriend want 2 weeks in Italy in October',
        history: [],
        known: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('show_city_picker');
    expect(res.body.updates.travelers).toBe(2);
    expect(res.body.updates.countries[0].country).toBe('Italy');
    expect(res.body.quickReplies).toHaveLength(2);

    // The model got the conversation + known state, and the tool was forced
    const call = mockCreate.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'respond_to_traveler' });
    expect(call.system).toContain('WHAT YOU KNOW SO FAR');
  });

  it('passes known state so the model never re-asks', async () => {
    mockCreate.mockResolvedValue(
      toolResponse({ reply: 'And how many of you are going?', updates: {}, action: 'ask' }),
    );
    await request(app)
      .post('/api/plan/converse')
      .send({
        message: 'sounds good',
        history: [{ role: 'assistant', content: 'Rome it is!' }],
        known: { destinations: ['Rome'], travelers: null },
      });
    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toContain('"destinations"');
    expect(call.system).toContain('Rome');
    expect(call.messages[call.messages.length - 1].content).toBe('sounds good');
  });

  it('returns 503 assistant_unavailable when the AI call fails', async () => {
    mockCreate.mockRejectedValue(new Error('overloaded'));
    const res = await request(app)
      .post('/api/plan/converse')
      .send({ message: 'hello', history: [], known: {} });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain('assistant_unavailable');
  });

  it('returns 503 when the model output is malformed', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not a tool call' }] });
    const res = await request(app)
      .post('/api/plan/converse')
      .send({ message: 'hello', history: [], known: {} });
    expect(res.status).toBe(503);
  });

  it('rejects an empty message with 400', async () => {
    const res = await request(app)
      .post('/api/plan/converse')
      .send({ message: '', history: [], known: {} });
    expect(res.status).toBe(400);
  });
});
