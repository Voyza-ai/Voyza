import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const router = Router();

// Lazy Anthropic client getter — returns null if key not set or placeholder
function getAnthropicSafe() {
  const key = env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_api_key' || key.startsWith('your_')) return null;
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

    // Popular cities per country — used by both AI and mock paths
    const COUNTRY_CITIES: Record<string, string[]> = {
      japan: ['Tokyo', 'Osaka', 'Kyoto', 'Hiroshima', 'Yokohama', 'Fukuoka'],
      china: ['Beijing', 'Shanghai', 'Guangzhou', 'Shenzhen', 'Chengdu', 'Xi\'an'],
      france: ['Paris', 'Lyon', 'Marseille', 'Nice', 'Bordeaux', 'Strasbourg'],
      italy: ['Rome', 'Florence', 'Milan', 'Venice', 'Naples', 'Amalfi'],
      spain: ['Barcelona', 'Madrid', 'Seville', 'Valencia', 'Granada', 'Bilbao'],
      germany: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Dresden'],
      uk: ['London', 'Edinburgh', 'Manchester', 'Oxford', 'Bath', 'Liverpool'],
      england: ['London', 'Manchester', 'Oxford', 'Bath', 'Liverpool', 'Bristol'],
      thailand: ['Bangkok', 'Chiang Mai', 'Phuket', 'Pattaya', 'Krabi', 'Koh Samui'],
      india: ['Delhi', 'Mumbai', 'Jaipur', 'Goa', 'Bangalore', 'Varanasi'],
      brazil: ['São Paulo', 'Rio de Janeiro', 'Salvador', 'Brasília', 'Florianópolis', 'Recife'],
      mexico: ['Mexico City', 'Cancún', 'Guadalajara', 'Oaxaca', 'Playa del Carmen', 'Mérida'],
      turkey: ['Istanbul', 'Cappadocia', 'Antalya', 'Izmir', 'Bodrum', 'Ankara'],
      greece: ['Athens', 'Santorini', 'Mykonos', 'Crete', 'Rhodes', 'Thessaloniki'],
      portugal: ['Lisbon', 'Porto', 'Faro', 'Sintra', 'Madeira', 'Évora'],
      netherlands: ['Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht', 'Eindhoven', 'Leiden'],
      austria: ['Vienna', 'Salzburg', 'Innsbruck', 'Graz', 'Hallstatt', 'Linz'],
      korea: ['Seoul', 'Busan', 'Jeju', 'Incheon', 'Gyeongju', 'Daegu'],
      australia: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Gold Coast', 'Cairns'],
      egypt: ['Cairo', 'Luxor', 'Aswan', 'Alexandria', 'Hurghada', 'Sharm El Sheikh'],
      morocco: ['Marrakech', 'Fez', 'Casablanca', 'Chefchaouen', 'Essaouira', 'Tangier'],
      croatia: ['Dubrovnik', 'Split', 'Zagreb', 'Hvar', 'Zadar', 'Plitvice'],
      czech: ['Prague', 'Český Krumlov', 'Brno', 'Karlovy Vary', 'Kutná Hora', 'Olomouc'],
      hungary: ['Budapest', 'Eger', 'Pécs', 'Debrecen', 'Szeged', 'Győr'],
      switzerland: ['Zurich', 'Geneva', 'Lucerne', 'Interlaken', 'Bern', 'Zermatt'],
      ireland: ['Dublin', 'Galway', 'Cork', 'Killarney', 'Limerick', 'Belfast'],
      scotland: ['Edinburgh', 'Glasgow', 'Inverness', 'Aberdeen', 'St Andrews', 'Isle of Skye'],
      vietnam: ['Hanoi', 'Ho Chi Minh City', 'Da Nang', 'Hoi An', 'Ha Long Bay', 'Nha Trang'],
      indonesia: ['Bali', 'Jakarta', 'Yogyakarta', 'Lombok', 'Komodo', 'Bandung'],
      philippines: ['Manila', 'Cebu', 'Palawan', 'Boracay', 'Siargao', 'Bohol'],
      colombia: ['Bogotá', 'Medellín', 'Cartagena', 'Cali', 'Santa Marta', 'San Andrés'],
      argentina: ['Buenos Aires', 'Mendoza', 'Bariloche', 'Ushuaia', 'Córdoba', 'Salta'],
      peru: ['Lima', 'Cusco', 'Machu Picchu', 'Arequipa', 'Lake Titicaca', 'Sacred Valley'],
      singapore: ['Singapore'],
      'south korea': ['Seoul', 'Busan', 'Jeju', 'Incheon', 'Gyeongju', 'Daegu'],
    };

    if (anthropic) {
      const { DEFAULT_MODEL } = require('../services/anthropic');
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: `You are a travel planning assistant. Parse the user's trip description into structured data.
Return JSON with:
- destinations (string[]) — specific city names, NOT country names
- countries (Array<{ country: string, cities: string[] }>) — if the user mentioned a country (e.g. "Japan"), include it here with 4-6 popular cities to visit. If the user mentioned a specific city, omit the country entry.
- dates ({ start, end } in YYYY-MM-DD) — infer from context or null
- travelers (number)
- budget (number or null)
- vibe (string)
- needsCitySelection (boolean) — true if any destination was a country name rather than a specific city`,
        messages: [
          {
            role: 'user',
            content: `Parse this trip request (user is in ${userLocation ?? 'unknown location'}): "${rawInput}"`,
          },
        ],
      });

      const rawText = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
      // Strip markdown code fences if present
      const text = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      try {
        const parsed = JSON.parse(text);
        return res.json(parsed);
      } catch {
        return res.json({ raw: rawText });
      }
    }

    // Mock response — extract city/country names from the raw input
    const words = rawInput
      .split(/[,&+]|\band\b/i)
      .map((w) => w.trim())
      .filter(Boolean);

    const destinations: string[] = [];
    const countries: Array<{ country: string; cities: string[] }> = [];
    let needsCitySelection = false;

    for (const w of words) {
      const lower = w.toLowerCase();
      const citiesForCountry = COUNTRY_CITIES[lower];
      if (citiesForCountry) {
        // It's a country — add default city but flag for selection
        destinations.push(citiesForCountry[0]);
        countries.push({ country: w.charAt(0).toUpperCase() + w.slice(1), cities: citiesForCountry });
        needsCitySelection = true;
      } else {
        // Assume it's already a city name
        destinations.push(w.charAt(0).toUpperCase() + w.slice(1));
      }
    }

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() + 30);
    const end = new Date(start);
    end.setDate(end.getDate() + destinations.length * 3);

    return res.json({
      destinations,
      countries,
      needsCitySelection,
      dates: {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0],
      },
      travelers: 2,
      budget: null,
      vibe: 'adventure',
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

        const rawText = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
        const text = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
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

      const rawText = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
      const text = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      try {
        return res.json(JSON.parse(text));
      } catch {
        return res.json({ action: 'no_change', message: rawText });
      }
    }

    // Mock
    return res.json({
      action: 'no_change',
      message: 'AI editing requires Anthropic API key',
      _mock: true,
    });
  }),
);

export default router;
