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

/**
 * Extract a JSON object/array from free-form AI output. Handles:
 * - Clean JSON (parses directly)
 * - Markdown-fenced JSON (```json ... ```)
 * - JSON followed by explanatory text (finds the balanced braces)
 * - JSON preceded by preamble
 *
 * Returns the parsed object or null if nothing parseable is found.
 */
function extractJson(raw: string): any | null {
  if (!raw) return null;
  const stripped = raw.trim();

  // Try direct parse first
  try { return JSON.parse(stripped); } catch {}

  // Try markdown-fenced block: ```json ... ``` (anywhere in the text)
  const fenceMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // Try finding the first balanced {...} or [...] block
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = stripped.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i++) {
      const c = stripped[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = stripped.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch {}
          break;
        }
      }
    }
  }

  return null;
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

Today's date is ${new Date().toISOString().split('T')[0]}. Use this to resolve relative phrases like "next week", "tomorrow", "in a month", "this summer" into absolute YYYY-MM-DD dates.

CRITICAL:
1. Only populate fields that the user EXPLICITLY mentioned. Never guess or assume. If the user didn't mention a field, set it to null. This lets the app ask follow-up questions instead of using a wrong default.
2. Respond with ONLY the JSON object, nothing else. No markdown fences, no explanation before or after. Just raw JSON.

Return JSON with:
- destinations (string[]) — specific city names ONLY the user mentioned (NOT country names, NOT inferred)
- countries (Array<{ country: string, cities: string[] }>) — if the user mentioned a country (e.g. "Japan"), include it here with 4-6 popular cities to visit. If the user mentioned a specific city, omit the country entry.
- dates ({ start, end } in YYYY-MM-DD) — resolve relative phrases using today's date above. Only return null if the user said nothing about timing.
- travelers (number or null) — the TOTAL group size including the person planning. "Me and 3 friends" → 4. "3 of us" → 3. "Just me" → 1. "Traveling with 3 people" is ambiguous — treat as 3 total (assume the number includes them). Return null if unstated.
- travelersAmbiguous (boolean) — true if the user's phrasing was ambiguous and could reasonably be interpreted as either "N total" OR "N + me = N+1 total" (e.g. "traveling with 3 people", "going with 3 friends"). Set false for unambiguous phrasing like "3 of us", "group of 4", "just me".
- budget (number or null) — ONLY if user mentioned a budget amount. If unstated, return null.
- budgetPerPerson (boolean or null) — true if user explicitly said "per person" / "each". false if user said "total" / "altogether" / "for the trip". null if budget unclear or not given.
- vibe (string or null) — ONLY if user mentioned a vibe/feeling (e.g. "beach", "adventure", "culture"). If unstated, return null. Do NOT infer from the destination.
- needsCitySelection (boolean) — true if any destination was a country name rather than a specific city`,
        messages: [
          {
            role: 'user',
            content: `Parse this trip request (user is in ${userLocation ?? 'unknown location'}): "${rawInput}"`,
          },
        ],
      });

      const rawText = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = extractJson(rawText);
      if (parsed) return res.json(parsed);
      return res.json({ raw: rawText });
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
          system: 'You rank travel destinations. Respond with ONLY a JSON array of { name, reason } sorted by best fit. No markdown fences, no explanation.',
          messages: [
            {
              role: 'user',
              content: `Rank these destinations for a ${vibe ?? 'general'} trip from ${userLocation ?? 'unknown'}: ${candidates.map((c) => c.name).join(', ')}`,
            },
          ],
        });

        const rawText = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
        const ranked = extractJson(rawText);
        try {
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
        system: `You are a travel trip editor. Given a trip and a user message, return a JSON patch to apply. Actions: add_city, remove_city, swap_hotel, change_dates, reorder, no_change. Format: { action, data, message }. Respond with ONLY the JSON object, no markdown fences, no explanation.`,
        messages: [
          {
            role: 'user',
            content: `Trip: ${JSON.stringify(currentTrip)}\n\nUser request: "${message}"`,
          },
        ],
      });

      const rawText = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = extractJson(rawText);
      if (parsed) return res.json(parsed);
      return res.json({ action: 'no_change', message: rawText });
    }

    // Mock
    return res.json({
      action: 'no_change',
      message: 'AI editing requires Anthropic API key',
      _mock: true,
    });
  }),
);

// ─── POST /api/plan/activities ───────────────────────────────
// AI-picks (Claude) returns 5 activity names + short reason per city.
// Later we'll enrich each with real POI data (Google Places / Foursquare).
const activitiesSchema = z.object({
  city: z.string().min(1),
  country: z.string().optional(),
  vibe: z.string().optional(),
  travelers: z.number().int().positive().optional(),
  nights: z.number().int().positive().optional(),
});

router.post(
  '/activities',
  asyncHandler(async (req, res) => {
    const { city, country, vibe, travelers, nights } = activitiesSchema.parse(req.body);
    const anthropic = getAnthropicSafe();

    if (anthropic) {
      const { DEFAULT_MODEL } = require('../services/anthropic');
      const n = Math.max(5, Math.min(8, (nights ?? 2) * 2 + 1));

      const vibeHint = vibe ? `The traveler's vibe is: ${vibe}. ` : '';
      const groupHint = travelers && travelers > 1 ? `They're traveling as a group of ${travelers}. ` : '';

      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: `You recommend things to do in a city. ${vibeHint}${groupHint}Pick ${n} diverse activities — a mix of must-see landmarks, cultural experiences, food, and a couple lesser-known picks. Avoid generic listicle fodder.

Respond with ONLY a JSON array, no markdown fences, no explanation. Each item:
{
  "name": "specific activity or place name (not a generic description)",
  "category": "landmark" | "museum" | "food" | "nature" | "nightlife" | "experience" | "shopping",
  "timeOfDay": "morning" | "afternoon" | "evening",
  "durationHours": number between 1 and 4,
  "reason": "one short sentence why"
}`,
        messages: [
          {
            role: 'user',
            content: `Activities in ${city}${country ? `, ${country}` : ''}.`,
          },
        ],
      });

      const rawText = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = extractJson(rawText);
      if (Array.isArray(parsed)) {
        return res.json({ activities: parsed });
      }
      // fall through to mock if parse failed
    }

    // Mock fallback
    return res.json({
      activities: [
        { name: `Explore ${city} old town`, category: 'landmark', timeOfDay: 'morning', durationHours: 2, reason: 'Classic starting point' },
        { name: `Local food tour in ${city}`, category: 'food', timeOfDay: 'afternoon', durationHours: 3, reason: 'Taste the local cuisine' },
        { name: `${city} main museum`, category: 'museum', timeOfDay: 'afternoon', durationHours: 2, reason: 'Cultural highlight' },
        { name: `Sunset walk`, category: 'experience', timeOfDay: 'evening', durationHours: 1, reason: 'Golden hour views' },
        { name: `Neighborhood wandering`, category: 'experience', timeOfDay: 'afternoon', durationHours: 2, reason: 'Discover local life' },
      ],
      _mock: true,
    });
  }),
);

// ─── POST /api/plan/restaurants ──────────────────────────────
// AI-picks (Claude) returns 5 restaurant recommendations per city.
// Later we'll enrich each with real POI data (Google Places / Foursquare).
const restaurantsSchema = z.object({
  city: z.string().min(1),
  country: z.string().optional(),
  vibe: z.string().optional(),
  travelers: z.number().int().positive().optional(),
  budget: z.number().int().positive().optional(),
});

router.post(
  '/restaurants',
  asyncHandler(async (req, res) => {
    const { city, country, vibe, travelers, budget } = restaurantsSchema.parse(req.body);
    const anthropic = getAnthropicSafe();

    if (anthropic) {
      const { DEFAULT_MODEL } = require('../services/anthropic');

      const vibeHint = vibe ? `The traveler's vibe is: ${vibe}. ` : '';
      const groupHint = travelers && travelers > 1 ? `Group of ${travelers}. ` : '';
      const budgetHint = budget
        ? `Their total trip budget is $${budget} — recommend a mix but skew toward mid-range.`
        : 'Mix a couple affordable spots, a couple mid-range, and one special splurge.';

      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: `You recommend restaurants in a city. ${vibeHint}${groupHint}Pick 5 diverse spots representing local specialties. Avoid generic chain restaurants and tourist traps. ${budgetHint}

Respond with ONLY a JSON array, no markdown fences, no explanation. Each item:
{
  "name": "specific restaurant name (real, well-known spot)",
  "cuisine": "short cuisine label, e.g. 'Roman pasta', 'Neapolitan pizza', 'izakaya', 'ramen'",
  "priceRange": "$" | "$$" | "$$$" | "$$$$",
  "mealType": "breakfast" | "lunch" | "dinner" | "any",
  "reason": "one short sentence why a traveler should go"
}`,
        messages: [
          {
            role: 'user',
            content: `Restaurants in ${city}${country ? `, ${country}` : ''}.`,
          },
        ],
      });

      const rawText = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = extractJson(rawText);
      if (Array.isArray(parsed)) {
        return res.json({ restaurants: parsed });
      }
      // fall through to mock
    }

    // Mock fallback
    return res.json({
      restaurants: [
        { name: `${city} neighborhood trattoria`, cuisine: 'local', priceRange: '$$', mealType: 'dinner', reason: 'Classic local spot' },
        { name: `${city} casual lunch cafe`, cuisine: 'cafe', priceRange: '$', mealType: 'lunch', reason: 'Quick casual bite' },
        { name: `${city} upscale restaurant`, cuisine: 'contemporary', priceRange: '$$$', mealType: 'dinner', reason: 'Special occasion' },
        { name: `${city} street food market`, cuisine: 'street food', priceRange: '$', mealType: 'any', reason: 'Local flavors' },
        { name: `${city} breakfast bakery`, cuisine: 'bakery', priceRange: '$', mealType: 'breakfast', reason: 'Great way to start the day' },
      ],
      _mock: true,
    });
  }),
);

export default router;
