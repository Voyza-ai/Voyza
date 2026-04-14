import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const router = Router();

// Lazy Anthropic client getter — returns null if key not set
function getAnthropicSafe() {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const { getAnthropic } = require('../services/anthropic');
    return getAnthropic();
  } catch {
    return null;
  }
}

// ─── POST /api/plan/interpret ────────────────────────────────
const interpretSchema = z.object({
  rawInput: z.string().min(1),
  userLocation: z.string().optional(),
});

router.post(
  '/interpret',
  asyncHandler(async (req, res) => {
    const { rawInput, userLocation } = interpretSchema.parse(req.body);
    const anthropic = getAnthropicSafe();

    if (anthropic) {
      const { DEFAULT_MODEL } = require('../services/anthropic');
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: `You are a travel planning assistant. Parse the user's trip description into structured data. Return JSON with: destinations (string[]), dates ({ start, end } in YYYY-MM-DD), travelers (number), budget (number or null), vibe (string).`,
        messages: [
          {
            role: 'user',
            content: `Parse this trip request (user is in ${userLocation ?? 'unknown location'}): "${rawInput}"`,
          },
        ],
      });

      const text = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
      try {
        const parsed = JSON.parse(text);
        return res.json(parsed);
      } catch {
        return res.json({ raw: text });
      }
    }

    // Mock response
    res.json({
      destinations: ['Paris', 'Rome'],
      dates: { start: '2026-06-01', end: '2026-06-14' },
      travelers: 2,
      budget: 2000,
      vibe: 'city break',
      _mock: true,
    });
  }),
);

// ─── POST /api/plan/suggest-destinations ─────────────────────
const suggestSchema = z.object({
  budget: z.number().optional(),
  vibe: z.string().optional(),
  userLocation: z.string().optional(),
  currentCities: z.array(z.string()).optional(),
});

// Hardcoded popularity map for next-city suggestions
const POPULAR_NEXT: Record<string, string[]> = {
  Rome: ['Florence', 'Naples', 'Amalfi', 'Cinque Terre'],
  Florence: ['Rome', 'Venice', 'Siena', 'Pisa'],
  Barcelona: ['Madrid', 'Valencia', 'Lisbon', 'Seville'],
  Paris: ['London', 'Amsterdam', 'Brussels', 'Lyon'],
  London: ['Paris', 'Edinburgh', 'Amsterdam', 'Dublin'],
  Amsterdam: ['Brussels', 'Paris', 'Berlin', 'Cologne'],
  Berlin: ['Prague', 'Munich', 'Amsterdam', 'Vienna'],
  Prague: ['Vienna', 'Berlin', 'Budapest', 'Krakow'],
  Vienna: ['Prague', 'Budapest', 'Salzburg', 'Munich'],
  Lisbon: ['Porto', 'Seville', 'Barcelona', 'Madrid'],
  Madrid: ['Barcelona', 'Seville', 'Lisbon', 'Valencia'],
  Athens: ['Santorini', 'Mykonos', 'Istanbul', 'Crete'],
  Istanbul: ['Athens', 'Cappadocia', 'Antalya', 'Sofia'],
};

router.post(
  '/suggest-destinations',
  asyncHandler(async (req, res) => {
    const { budget, vibe, userLocation, currentCities } = suggestSchema.parse(req.body);

    let candidates: Array<{ name: string; estimatedCost: number; reason: string }> = [];

    // Find next destinations from current cities
    if (currentCities && currentCities.length > 0) {
      for (const city of currentCities) {
        const nextCities = POPULAR_NEXT[city] ?? [];
        for (const next of nextCities) {
          if (!currentCities.includes(next) && !candidates.find((c) => c.name === next)) {
            candidates.push({
              name: next,
              estimatedCost: 100 + Math.floor(Math.random() * 200),
              reason: `Popular next stop from ${city}`,
            });
          }
        }
      }
    }

    // Fill with budget-friendly defaults if needed
    if (candidates.length < 5) {
      const defaults = [
        { name: 'Porto', estimatedCost: 80, reason: 'Budget-friendly and charming' },
        { name: 'Krakow', estimatedCost: 65, reason: 'Great value for culture lovers' },
        { name: 'Budapest', estimatedCost: 75, reason: 'Stunning architecture on a budget' },
        { name: 'Split', estimatedCost: 90, reason: 'Beach meets history' },
        { name: 'Dubrovnik', estimatedCost: 110, reason: 'Iconic coastal city' },
      ];
      for (const d of defaults) {
        const alreadyHas = candidates.find((c) => c.name === d.name) ||
          currentCities?.includes(d.name);
        if (!alreadyHas) candidates.push(d);
      }
    }

    // Budget filter
    if (budget) {
      candidates = candidates.filter((c) => c.estimatedCost <= budget);
    }

    candidates = candidates.slice(0, 5);

    // If AI key present, enhance with Claude
    const anthropic = getAnthropicSafe();
    if (anthropic && candidates.length > 0) {
      try {
        const { DEFAULT_MODEL } = require('../services/anthropic');
        const response = await anthropic.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 512,
          system: 'You rank travel destinations. Return JSON array of { name, reason } sorted by best fit.',
          messages: [
            {
              role: 'user',
              content: `Rank these destinations for a ${vibe ?? 'general'} trip from ${userLocation ?? 'unknown'}: ${candidates.map((c) => c.name).join(', ')}`,
            },
          ],
        });

        const text = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
        try {
          const ranked = JSON.parse(text);
          if (Array.isArray(ranked)) {
            candidates = candidates.map((c) => {
              const match = ranked.find((r: any) => r.name === c.name);
              return match ? { ...c, reason: match.reason ?? c.reason } : c;
            });
          }
        } catch {
          // keep original reasons
        }
      } catch (err) {
        logger.warn('AI suggest-destinations failed, using defaults');
      }
    }

    res.json({ destinations: candidates });
  }),
);

// ─── POST /api/plan/edit ─────────────────────────────────────
const editSchema = z.object({
  message: z.string().min(1),
  currentTrip: z.any(),
});

router.post(
  '/edit',
  asyncHandler(async (req, res) => {
    const { message, currentTrip } = editSchema.parse(req.body);
    const anthropic = getAnthropicSafe();

    if (anthropic) {
      const { DEFAULT_MODEL } = require('../services/anthropic');
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 2048,
        system: `You are a travel trip editor. Given a trip and a user message, return a JSON patch to apply. Actions: add_city, remove_city, swap_hotel, change_dates, reorder, no_change. Format: { action, data, message }.`,
        messages: [
          {
            role: 'user',
            content: `Trip: ${JSON.stringify(currentTrip)}\n\nUser request: "${message}"`,
          },
        ],
      });

      const text = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
      try {
        return res.json(JSON.parse(text));
      } catch {
        return res.json({ action: 'no_change', message: text });
      }
    }

    // Mock
    res.json({
      action: 'no_change',
      message: 'AI editing requires Anthropic API key',
      _mock: true,
    });
  }),
);

export default router;
