import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  applyDateConstraints,
  mergeConstraints,
  TripConstraints,
} from '../services/constraints';
import { searchLegOptions, LegOption } from '../services/legOptions';
import { compareLeg } from '../services/compareLeg';
import { getCityCountry } from '../data/cityCountries';

import { getAnthropicSafe } from '../services/anthropic';

const router = Router();

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
- origin (string or null) — the city the user is flying FROM (their home or starting point). Parse phrases like "from NYC", "flying out of London", "I'm in Tokyo", "leaving from San Francisco". Return the plain city name (not the IATA code). Null if the user didn't mention where they're coming from.
- returnToHome (boolean or null) — true if the user said "round-trip", "return trip", "RT", or mentioned coming back. false if they said "one-way", "just going there", or implied not returning. Null if they didn't mention it.
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

// ─── POST /api/plan/suggest-for-vibe ─────────────────────────
//
// Vibe-first flow: user picks "I'm chasing a vibe" on the opening
// question, the planner collects vibe + origin + budget + window +
// party size, and THIS endpoint returns 3-5 real destinations that fit.
//
// Thin HTTP wrapper over `services/destinationSuggester.ts`. The
// service owns caching, retry, fallback, and structured logging — we
// just validate the incoming shape and pass it through.
const suggestForVibeSchema = z.object({
  vibe: z.string().min(1),
  origin: z.string().min(1),
  budgetPerPerson: z.number().positive(),
  travelWindow: z.string().min(1),
  partySize: z.number().int().positive(),
  tripType: z.enum(['one-way', 'round-trip']),
  extras: z.string().optional(),
});

router.post(
  '/suggest-for-vibe',
  asyncHandler(async (req, res) => {
    const input = suggestForVibeSchema.parse(req.body);
    const { suggestDestinationsForVibe } = await import(
      '../services/destinationSuggester'
    );
    const result = await suggestDestinationsForVibe(input);
    res.json(result);
  }),
);

// ─── POST /api/plan/suggest-destinations ─────────────────────
// Legacy heuristic + Claude-reranker used by the destination-first
// flow when the user's text is vague. Kept for backward compat;
// vibe-first paths should call /suggest-for-vibe instead.
const suggestSchema = z.object({
  budget: z.number().optional(),
  vibe: z.string().optional(),
  userLocation: z.string().optional(),
  currentCities: z.array(z.string()).optional(),
});

// Hardcoded popularity map for next-city suggestions
const POPULAR_NEXT: Record<string, string[]> = {
  // Europe
  Rome: ['Florence', 'Naples', 'Amalfi', 'Cinque Terre', 'Venice'],
  Florence: ['Rome', 'Venice', 'Siena', 'Pisa', 'Bologna'],
  Venice: ['Florence', 'Rome', 'Milan', 'Ljubljana', 'Verona'],
  Milan: ['Venice', 'Florence', 'Lake Como', 'Turin', 'Genoa'],
  Naples: ['Rome', 'Amalfi', 'Pompeii', 'Capri', 'Sorrento'],
  Barcelona: ['Madrid', 'Valencia', 'Lisbon', 'Seville', 'Mallorca'],
  Paris: ['London', 'Amsterdam', 'Brussels', 'Lyon', 'Nice'],
  London: ['Paris', 'Edinburgh', 'Amsterdam', 'Dublin', 'Bath'],
  Amsterdam: ['Brussels', 'Paris', 'Berlin', 'Cologne', 'Rotterdam'],
  Berlin: ['Prague', 'Munich', 'Amsterdam', 'Vienna', 'Dresden'],
  Prague: ['Vienna', 'Berlin', 'Budapest', 'Krakow', 'Cesky Krumlov'],
  Vienna: ['Prague', 'Budapest', 'Salzburg', 'Munich', 'Bratislava'],
  Lisbon: ['Porto', 'Seville', 'Barcelona', 'Madrid', 'Sintra'],
  Madrid: ['Barcelona', 'Seville', 'Lisbon', 'Valencia', 'Toledo'],
  Athens: ['Santorini', 'Mykonos', 'Istanbul', 'Crete', 'Rhodes'],
  Istanbul: ['Athens', 'Cappadocia', 'Antalya', 'Sofia', 'Tbilisi'],
  Budapest: ['Prague', 'Vienna', 'Krakow', 'Belgrade', 'Zagreb'],
  Dublin: ['London', 'Edinburgh', 'Galway', 'Belfast', 'Cork'],
  Edinburgh: ['London', 'Dublin', 'Glasgow', 'York', 'Inverness'],
  Zurich: ['Lucerne', 'Interlaken', 'Munich', 'Milan', 'Geneva'],
  // Japan
  Tokyo: ['Kyoto', 'Osaka', 'Hakone', 'Nikko', 'Kamakura'],
  Kyoto: ['Osaka', 'Nara', 'Tokyo', 'Hiroshima', 'Kobe'],
  Osaka: ['Kyoto', 'Nara', 'Hiroshima', 'Kobe', 'Tokyo'],
  Hiroshima: ['Osaka', 'Kyoto', 'Miyajima', 'Fukuoka', 'Kobe'],
  Fukuoka: ['Hiroshima', 'Nagasaki', 'Osaka', 'Beppu', 'Kumamoto'],
  // Southeast Asia
  Bangkok: ['Chiang Mai', 'Phuket', 'Siem Reap', 'Hanoi', 'Krabi'],
  'Chiang Mai': ['Bangkok', 'Pai', 'Luang Prabang', 'Chiang Rai', 'Sukhothai'],
  Hanoi: ['Ha Long Bay', 'Hoi An', 'Sapa', 'Ninh Binh', 'Bangkok'],
  'Ho Chi Minh City': ['Hoi An', 'Da Nang', 'Phnom Penh', 'Hanoi', 'Nha Trang'],
  Bali: ['Lombok', 'Yogyakarta', 'Singapore', 'Kuala Lumpur', 'Bangkok'],
  Singapore: ['Kuala Lumpur', 'Bali', 'Bangkok', 'Penang', 'Jakarta'],
  // South Korea
  Seoul: ['Busan', 'Jeju', 'Gyeongju', 'Incheon', 'Tokyo'],
  Busan: ['Seoul', 'Gyeongju', 'Jeju', 'Fukuoka', 'Osaka'],
  // Americas
  'New York': ['Boston', 'Washington DC', 'Philadelphia', 'Montreal', 'Chicago'],
  'Los Angeles': ['San Francisco', 'San Diego', 'Las Vegas', 'Santa Barbara', 'Joshua Tree'],
  'San Francisco': ['Los Angeles', 'Napa Valley', 'Yosemite', 'Portland', 'Seattle'],
  Miami: ['Key West', 'Orlando', 'Havana', 'Nassau', 'Fort Lauderdale'],
  'Mexico City': ['Oaxaca', 'Puebla', 'Cancun', 'Guanajuato', 'San Miguel de Allende'],
  Cancun: ['Tulum', 'Playa del Carmen', 'Merida', 'Cozumel', 'Valladolid'],
  Lima: ['Cusco', 'Arequipa', 'Bogota', 'La Paz', 'Huacachina'],
  Cusco: ['Lima', 'Machu Picchu', 'Lake Titicaca', 'La Paz', 'Arequipa'],
  'Buenos Aires': ['Montevideo', 'Mendoza', 'Santiago', 'Iguazu Falls', 'Bariloche'],
  'Rio de Janeiro': ['Sao Paulo', 'Salvador', 'Buzios', 'Paraty', 'Florianopolis'],
  // Middle East
  Dubai: ['Abu Dhabi', 'Muscat', 'Doha', 'Istanbul', 'Amman'],
  Marrakech: ['Fes', 'Casablanca', 'Chefchaouen', 'Essaouira', 'Merzouga'],
  // Australia / NZ
  Sydney: ['Melbourne', 'Byron Bay', 'Blue Mountains', 'Gold Coast', 'Canberra'],
  Melbourne: ['Sydney', 'Great Ocean Road', 'Adelaide', 'Tasmania', 'Philip Island'],
  Auckland: ['Queenstown', 'Rotorua', 'Wellington', 'Hobbiton', 'Bay of Islands'],
};

router.post(
  '/suggest-destinations',
  asyncHandler(async (req, res) => {
    const { budget, vibe, userLocation, currentCities } = suggestSchema.parse(req.body);

    let candidates: Array<{ name: string; estimatedCost: number; reason: string }> = [];

    // Find next destinations from current cities (case-insensitive lookup)
    if (currentCities && currentCities.length > 0) {
      // Build case-insensitive index
      const popularKeys = Object.keys(POPULAR_NEXT);
      const currentLower = currentCities.map((c) => c.toLowerCase());

      for (const city of currentCities) {
        // Find matching key case-insensitively
        const key = popularKeys.find((k) => k.toLowerCase() === city.toLowerCase());
        const nextCities = key ? POPULAR_NEXT[key] : [];
        for (const next of nextCities) {
          if (
            !currentLower.includes(next.toLowerCase()) &&
            !candidates.find((c) => c.name.toLowerCase() === next.toLowerCase())
          ) {
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

// ─── POST /api/plan/chat ─────────────────────────────────────
//
// The Voyza AI chat endpoint. Replaces the old /edit (which returned a
// freeform JSON patch that the frontend never actually applied).
//
// Claude gets the full trip + existing constraints + conversation
// history, and picks ONE tool to call:
//   - answer_only(text) → plain Q&A, no trip mutation
//   - pin_city_dates(city, arrival, departure) → lock a city
//   - set_min_days(city, minNights) → guarantee minimum stay
//   - set_transport_window(from, to, earliest/latest depart/arrive) →
//     constrain when a leg can run
//
// For the three constraint tools we build a "proposal":
//   - Merge the new constraint onto trip.constraints
//   - Apply date-bearing constraints (pin + min_days) to recompute city
//     dates — this is what produces the Accept-or-Reject diff card
//   - Return { type: 'proposal', reply, proposal: {...} } — nothing is
//     persisted until the user clicks Accept and the frontend calls
//     PATCH /api/trips/:id (or leaves it in memory until Save)
//
// transport_windows are stored on Accept but not yet applied (would
// require compareLeg to accept time filters — tracked in ROADMAP).
const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const chatSchema = z.object({
  message: z.string().min(1),
  currentTrip: z.any(),
  /**
   * Prior conversation for multi-turn context ("Make Barcelona cheaper" →
   * AI gives 2 options → "do the first one" needs history). Last item in
   * the array must NOT be the current message; that goes in `message`.
   */
  history: z.array(historyMessageSchema).optional(),
});

/**
 * Claude tool definitions. The `input_schema` fields here double as
 * validation — we trust that Claude's structured tool-use output matches
 * the declared shape. Tool names are snake_case to match Anthropic's
 * naming convention in examples.
 */
const CHAT_TOOLS = [
  {
    name: 'answer_only',
    description:
      'Use when the user is asking a question, seeking an explanation, or making small talk — NOT requesting a change to the trip. Examples: "Why is this trip cheaper?", "Why this order of cities?", "What\'s the weather like in Rome in March?".',
    input_schema: {
      type: 'object' as const,
      properties: {
        answer: {
          type: 'string',
          description:
            'The direct answer to the user, written in the voice of a helpful travel planner. 2-4 sentences, concrete, references specific cities/prices/legs from the trip when relevant.',
        },
      },
      required: ['answer'],
    },
  },
  {
    name: 'pin_city_dates',
    description:
      'Lock a city to specific dates. Use when the user says things like "I need to be in Rome March 5-10", "keep me in Tokyo for April 2-7", "schedule Paris for the 15th to 18th". Other cities will be shifted around the pin.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'Exact city name as it appears in the trip.' },
        arrival: { type: 'string', description: 'YYYY-MM-DD arrival date.' },
        departure: { type: 'string', description: 'YYYY-MM-DD departure date.' },
        explanation: {
          type: 'string',
          description: 'One-sentence explanation for the user about what you\'re pinning and why.',
        },
      },
      required: ['city', 'arrival', 'departure', 'explanation'],
    },
  },
  {
    name: 'set_min_days',
    description:
      'Guarantee a minimum number of nights in a city. Use when user says "at least 3 days in Tokyo", "give me 4 nights in Rome minimum", "don\'t rush Florence".',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'Exact city name as it appears in the trip.' },
        minNights: { type: 'number', description: 'Minimum number of nights required.' },
        explanation: {
          type: 'string',
          description: 'One-sentence explanation for the user.',
        },
      },
      required: ['city', 'minNights', 'explanation'],
    },
  },
  {
    name: 'set_transport_window',
    description:
      'Constrain the departure/arrival time of a specific leg between two cities. Use ONLY when the user specifies a time bound: "no flights before 5pm", "need to land by 3pm", "don\'t leave before noon". Pass null for any bound the user didn\'t specify. Do NOT use this for "show me more flights" or "what are my options" — use show_transport_options for those.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Origin city (must match a city in the trip).' },
        to: { type: 'string', description: 'Destination city (must match a city in the trip).' },
        earliestDepart: {
          type: ['string', 'null'],
          description: 'HH:MM 24-hour earliest departure, or null.',
        },
        latestDepart: {
          type: ['string', 'null'],
          description: 'HH:MM 24-hour latest departure, or null.',
        },
        earliestArrive: {
          type: ['string', 'null'],
          description: 'HH:MM 24-hour earliest arrival, or null.',
        },
        latestArrive: {
          type: ['string', 'null'],
          description: 'HH:MM 24-hour latest arrival, or null.',
        },
        explanation: {
          type: 'string',
          description: 'One-sentence explanation for the user.',
        },
      },
      required: ['from', 'to', 'explanation'],
    },
  },
  {
    name: 'show_transport_options',
    description:
      'Refresh the transport card for a specific leg with the top 4 cheapest flight/train options — no time constraint. Use when the user asks "are there more flights?", "show me trains from X to Y", "what are my options from A to B", "can I take a train instead?", "find me cheaper options". REQUIRES both `from` and `to` to be specified. If the user is vague about which leg (e.g. "are there more flights?" in a multi-leg trip), DO NOT call this tool — use answer_only to ask which leg first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Origin city (must match a city in the trip).' },
        to: { type: 'string', description: 'Destination city (must match a city in the trip).' },
        explanation: {
          type: 'string',
          description: 'One-sentence explanation like "Here are the cheapest options for Rome → Florence".',
        },
      },
      required: ['from', 'to', 'explanation'],
    },
  },
  {
    name: 'compare_modes',
    description:
      'Surface a side-by-side flight-vs-train comparison for a specific leg. Use when the user is curious about the OTHER mode without committing to a card change yet — "are there any flights?" (when the leg currently uses train), "what about trains?" (when leg uses flight), "is it cheaper to fly or take the train?", "compare flight and train". Returns BOTH cheapest flight AND cheapest train side-by-side so the user can decide. Use this BEFORE show_transport_options when the user is exploring; use show_transport_options when they explicitly want to switch.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Origin city (must match a city in the trip).' },
        to: { type: 'string', description: 'Destination city (must match a city in the trip).' },
        explanation: {
          type: 'string',
          description: 'One-sentence framing like "Here\'s flight vs train for Rome → Florence — flights save 4 hours but cost $80 more."',
        },
      },
      required: ['from', 'to', 'explanation'],
    },
  },
];

/**
 * Compact a trip into the minimum context Claude needs to reason about
 * edits. We strip raw flight payloads, hotel rankings, etc. — Claude
 * doesn't need them for pin/min-days/window decisions and including
 * them burns a lot of tokens.
 */
function summarizeTripForChat(trip: any): any {
  const cities = (trip.cities ?? []).map((c: any, idx: number) => ({
    position: idx,
    name: c.name,
    country: c.country ?? null,
    arrival: c.dates?.arrival ?? c.arrival_date ?? null,
    departure: c.dates?.departure ?? c.departure_date ?? null,
    hotel: c.hotel?.name ?? null,
    hotelNightly: c.hotel?.pricePerNight ?? null,
    transportOut: c.transportOut
      ? {
          mode: c.transportOut.mode,
          operator: c.transportOut.operator,
          price: c.transportOut.price,
          duration: c.transportOut.duration,
          departTime: c.transportOut.departTime ?? null,
          arriveTime: c.transportOut.arriveTime ?? null,
        }
      : null,
  }));
  return {
    title: trip.title,
    travelers: trip.travelers,
    totalCost: trip.totalCost ?? trip.total_cost,
    vibe: trip.vibe ?? null,
    budget: trip.budget ?? null,
    cities,
    existingConstraints: trip.constraints ?? {},
  };
}

router.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const { message, currentTrip, history } = chatSchema.parse(req.body);
    const anthropic = getAnthropicSafe();

    if (!anthropic) {
      return res.json({
        type: 'answer',
        reply:
          "I'm offline right now — the Anthropic API key isn't configured on the server. Ask your admin to set ANTHROPIC_API_KEY.",
      });
    }

    const { DEFAULT_MODEL } = require('../services/anthropic');

    const tripSummary = summarizeTripForChat(currentTrip);

    // Build the messages array: prior history, then the new user message.
    // We don't prepend the trip — it goes in the system prompt so Claude
    // sees it as persistent context rather than a turn in the conversation.
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const turn of history ?? []) {
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: 'user', content: message });

    const systemPrompt = `You are Voyza AI, a travel-planning assistant embedded in the user's itinerary page. You help travelers refine their trip in plain English.

You have six tools:
1. answer_only — for plain questions, explanations, small talk, AND for clarifying questions when the user's request is ambiguous about which leg.
2. pin_city_dates — when the user wants a city locked to specific dates.
3. set_min_days — when the user wants a minimum stay in a city.
4. set_transport_window — when the user gives a TIME BOUND on a specific leg ("no flights before 5pm", "arrive by 3pm").
5. show_transport_options — when the user wants to SWAP transport for a specific leg ("show me cheaper flights", "find me other options"). Updates the card with top-4 mixed-mode options.
6. compare_modes — when the user is CURIOUS about the OTHER mode without committing yet ("are there any flights?" when the leg uses train, "what about trains?" when leg uses flight, "is it cheaper to fly?"). Returns flight + train side-by-side so the user can decide.

ALWAYS pick exactly one tool per turn.

CRITICAL: Many trips have multiple legs (e.g. City A → City B → City C has TWO legs). When the user asks about flights/trains/transport without specifying WHICH leg:
  - If there's only ONE leg in the trip, just use that one.
  - If there are MULTIPLE legs and the user didn't specify, use answer_only to ask which leg (e.g. "Which leg — Venice → Rome or Rome → Florence?"). Do NOT guess.
  - If the user names the from/to cities directly ("Rome to Florence"), use the matching tool.

Decision guide:
- User asks about times/bounds → set_transport_window
- User is curious about the OTHER mode (flight vs train) for the same leg → compare_modes
- User wants to swap to alternatives / more options / cheaper → show_transport_options
- User asks a general question, wants explanation, or their request is ambiguous → answer_only
- User wants to lock a city to specific dates → pin_city_dates
- User wants more time in a city → set_min_days

If the user references a city that isn't in the trip, answer_only and ask them to clarify — do NOT invent a pin or window.

Be concise. Reference concrete numbers (prices, durations, dates) from the trip when you have them.

TRIP CONTEXT (read-only):
${JSON.stringify(tripSummary, null, 2)}
`;

    let response;
    try {
      response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: CHAT_TOOLS as any,
        messages,
      });
    } catch (err: any) {
      logger.warn('plan/chat Claude call failed', { message: err?.message });
      return res.json({
        type: 'answer',
        reply:
          "Sorry — I hit an error reaching the AI. Please try again in a moment. If it keeps happening, let us know.",
      });
    }

    // Find the tool_use block in Claude's response.
    const toolUse = response.content.find((b: any) => b.type === 'tool_use') as any;
    if (!toolUse) {
      // Claude decided to respond as text instead of calling a tool. Use the
      // text block as the answer so the user still gets something.
      const textBlock = response.content.find((b: any) => b.type === 'text') as any;
      return res.json({
        type: 'answer',
        reply: textBlock?.text ?? "I'm not sure how to help with that — could you rephrase?",
      });
    }

    const toolName = toolUse.name as string;
    const toolInput = toolUse.input as any;

    // --- answer_only: plain text response
    if (toolName === 'answer_only') {
      return res.json({
        type: 'answer',
        reply: toolInput.answer,
      });
    }

    // --- Constraint tools: build a proposal the frontend can preview.
    const existingConstraints: TripConstraints = currentTrip.constraints ?? {};
    let constraintUpdate: TripConstraints = {};
    let replyText = toolInput.explanation ?? 'I have a proposed change for you.';

    // --- compare_modes: side-by-side flight vs train for one leg.
    //     Informational only — does NOT mutate the trip. Frontend renders
    //     a small comparison card inline in chat. The user can then ask
    //     to switch (which routes through show_transport_options) or
    //     accept the current pick.
    if (toolName === 'compare_modes') {
      const fromLower = String(toolInput.from).toLowerCase();
      const toLower = String(toolInput.to).toLowerCase();
      const fromCity = (currentTrip.cities ?? []).find(
        (c: any) => c.name.toLowerCase() === fromLower,
      );
      const toCity = (currentTrip.cities ?? []).find(
        (c: any) => c.name.toLowerCase() === toLower,
      );
      if (!fromCity || !toCity) {
        return res.json({
          type: 'answer',
          reply: `I couldn\'t find a ${toolInput.from} → ${toolInput.to} leg in your trip.`,
        });
      }

      const travelDate =
        fromCity.dates?.departure ?? fromCity.departure_date ?? null;
      if (!travelDate) {
        return res.json({
          type: 'answer',
          reply: `I need a departure date for ${fromCity.name} before I can compare options.`,
        });
      }

      const cmp = await compareLeg({
        origin: fromCity.name,
        destination: toCity.name,
        date: travelDate,
        travelers: currentTrip.travelers ?? 1,
        originCountry: fromCity.country ?? getCityCountry(fromCity.name),
        destinationCountry: toCity.country ?? getCityCountry(toCity.name),
      }).catch(() => null);

      if (!cmp || (!cmp.flightOption && !cmp.trainOption)) {
        return res.json({
          type: 'answer',
          reply: `I couldn\'t find any flight or train options for ${fromCity.name} → ${toCity.name} on ${travelDate}.`,
        });
      }

      const fmtDuration = (mins: number) => {
        if (!mins || !Number.isFinite(mins)) return '—';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
      };

      const flightSummary = cmp.flightOption
        ? {
            mode: 'flight' as const,
            operator: cmp.flightOption.carrier,
            price: cmp.flightOption.price,
            currency: cmp.flightOption.currency,
            duration: fmtDuration(cmp.flightOption.durationMinutes),
            durationMinutes: cmp.flightOption.durationMinutes,
            stops: cmp.flightOption.stops,
            bookingUrl: cmp.flightOption.bookingUrl ?? null,
          }
        : null;

      const trainSummary = cmp.trainOption
        ? {
            mode: 'train' as const,
            operator: cmp.trainOption.operator,
            price: cmp.trainOption.price ?? 0,
            currency: cmp.trainOption.currency ?? 'USD',
            duration: fmtDuration(cmp.trainOption.durationMinutes),
            durationMinutes: cmp.trainOption.durationMinutes,
            bookingUrl: cmp.trainOption.bookingUrl ?? null,
          }
        : null;

      return res.json({
        type: 'mode_comparison',
        reply: toolInput.explanation ?? `Here\'s flight vs train for ${fromCity.name} → ${toCity.name}.`,
        comparison: {
          fromCity: fromCity.name,
          toCity: toCity.name,
          date: travelDate,
          flight: flightSummary,
          train: trainSummary,
          cheapest: cmp.cheapest,
          fastest: cmp.fastest,
          recommendation: cmp.recommendation,
          priceDifference: cmp.priceDifference,
          timeDifference: cmp.timeDifference,
        },
      });
    }

    // --- Leg-refresh tools: set_transport_window (with time bounds) and
    //     show_transport_options (no bounds). Both re-search the specified
    //     leg and return a leg_refresh response. The frontend uses that
    //     response to overwrite the matching transport's `alternatives`
    //     directly on the flowchart — no inline card in chat. Chat just
    //     shows a one-line summary ("Found 12, showing top 4").
    //
    //     set_transport_window ALSO persists the constraint so future
    //     re-optimizations honor the time bound.
    if (toolName === 'set_transport_window' || toolName === 'show_transport_options') {
      const fromLower = String(toolInput.from).toLowerCase();
      const toLower = String(toolInput.to).toLowerCase();
      const fromCity = (currentTrip.cities ?? []).find(
        (c: any) => c.name.toLowerCase() === fromLower,
      );
      const toCity = (currentTrip.cities ?? []).find(
        (c: any) => c.name.toLowerCase() === toLower,
      );
      if (!fromCity || !toCity) {
        return res.json({
          type: 'answer',
          reply: `I couldn\'t find a ${toolInput.from} → ${toolInput.to} flight or train in your trip.`,
        });
      }

      const travelDate =
        fromCity.dates?.departure ?? fromCity.departure_date ?? null;
      if (!travelDate) {
        return res.json({
          type: 'answer',
          reply: `I need a departure date for ${fromCity.name} before I can find matching options.`,
        });
      }

      const currentTransport = fromCity.transportOut ?? null;
      const currentPrice = currentTransport?.price ?? 0;

      // Only set_transport_window has a window; show_transport_options
      // passes no bounds (we still use the same search path).
      const window =
        toolName === 'set_transport_window'
          ? {
              earliestDepart: toolInput.earliestDepart ?? null,
              latestDepart: toolInput.latestDepart ?? null,
              earliestArrive: toolInput.earliestArrive ?? null,
              latestArrive: toolInput.latestArrive ?? null,
            }
          : undefined;

      const legSearch = await searchLegOptions({
        from: fromCity.name,
        to: toCity.name,
        date: travelDate,
        travelers: currentTrip.travelers ?? 1,
        fromCountry: fromCity.country ?? getCityCountry(fromCity.name),
        toCountry: toCity.country ?? getCityCountry(toCity.name),
        window,
        currentPrice,
        // Top 4 for the card; we also return totalFound so the summary
        // can say "found 12, showing top 4".
        limit: 4,
      });

      // Count the total matches (pre-limit) so the chat summary can be
      // honest about "found 12, showing top 4". We re-run without a limit
      // only when a window is present (otherwise it's not useful).
      let totalFound = legSearch.options.length;
      if (window) {
        const unlimited = await searchLegOptions({
          from: fromCity.name,
          to: toCity.name,
          date: travelDate,
          travelers: currentTrip.travelers ?? 1,
          fromCountry: fromCity.country ?? getCityCountry(fromCity.name),
          toCountry: toCity.country ?? getCityCountry(toCity.name),
          window,
          currentPrice,
          limit: 100,
        }).catch(() => null);
        if (unlimited) totalFound = unlimited.options.length;
      }

      // No matches → answer_only with context.
      if (!legSearch.hasMatches) {
        const bounds = window ? describeWindow(window) : '';
        const conflict =
          window && legSearch.windowFilteredAll
            ? `No flights or trains from ${fromCity.name} to ${toCity.name} match ${bounds}. Want me to relax the window, or pick a different departure date?`
            : `I couldn\'t find any flights or trains from ${fromCity.name} to ${toCity.name} on ${travelDate}. Try another date.`;
        return res.json({ type: 'answer', reply: conflict });
      }

      // Build a one-line summary for the chat bubble.
      const shownCount = legSearch.options.length;
      const cheapest = legSearch.options[0];
      const summaryBits: string[] = [];
      const foundCountPhrase =
        totalFound > shownCount
          ? `Found ${totalFound}, showing the top ${shownCount}`
          : `Found ${shownCount} option${shownCount === 1 ? '' : 's'}`;
      summaryBits.push(`${foundCountPhrase} for ${fromCity.name} → ${toCity.name}`);
      if (window) {
        const windowPhrase = describeWindow(window);
        if (windowPhrase) summaryBits.push(windowPhrase);
      }
      const delta = cheapest.priceDelta;
      if (currentPrice > 0 && delta < 0) {
        summaryBits.push(`cheapest saves $${Math.abs(delta).toFixed(0)}`);
      } else if (currentPrice > 0 && delta > 0) {
        summaryBits.push(`cheapest is +$${delta.toFixed(0)}`);
      }
      const summary =
        summaryBits.join(' — ') + '. Pick one on the transport card to use it.';

      // If this was set_transport_window, persist the intent on the trip
      // so future re-optimizations honor the bound.
      let updatedConstraints = existingConstraints;
      if (toolName === 'set_transport_window' && window) {
        const constraintUpdate: TripConstraints = {
          transport_windows: [
            {
              from: fromCity.name,
              to: toCity.name,
              earliestDepart: window.earliestDepart,
              latestDepart: window.latestDepart,
              earliestArrive: window.earliestArrive,
              latestArrive: window.latestArrive,
            },
          ],
        };
        updatedConstraints = mergeConstraints(existingConstraints, constraintUpdate);
      }

      return res.json({
        type: 'leg_refresh',
        reply: summary,
        refresh: {
          fromCity: fromCity.name,
          toCity: toCity.name,
          date: travelDate,
          options: legSearch.options,
          totalFound,
          updatedConstraints,
        },
      });
    }

    // --- Date-bearing tools: pin_city_dates, set_min_days. These
    //     compute a new set of city dates + a visual diff.
    if (toolName === 'pin_city_dates') {
      const match = (currentTrip.cities ?? []).find(
        (c: any) => c.name.toLowerCase() === String(toolInput.city).toLowerCase(),
      );
      if (!match) {
        return res.json({
          type: 'answer',
          reply: `I couldn\'t find "${toolInput.city}" in your trip. Did you mean one of: ${(currentTrip.cities ?? [])
            .map((c: any) => c.name)
            .join(', ')}?`,
        });
      }
      constraintUpdate = {
        pinned_cities: [
          { city: match.name, arrival: toolInput.arrival, departure: toolInput.departure },
        ],
      };
    } else if (toolName === 'set_min_days') {
      const match = (currentTrip.cities ?? []).find(
        (c: any) => c.name.toLowerCase() === String(toolInput.city).toLowerCase(),
      );
      if (!match) {
        return res.json({
          type: 'answer',
          reply: `I couldn\'t find "${toolInput.city}" in your trip.`,
        });
      }
      constraintUpdate = {
        min_days: [{ city: match.name, minNights: Number(toolInput.minNights) }],
      };
    }

    const proposedConstraints = mergeConstraints(existingConstraints, constraintUpdate);

    const dbShapeCities = (currentTrip.cities ?? []).map((c: any) => ({
      name: c.name,
      arrival_date: c.dates?.arrival ?? c.arrival_date ?? null,
      departure_date: c.dates?.departure ?? c.departure_date ?? null,
    }));
    const { cities: newCities, diff } = applyDateConstraints(dbShapeCities, proposedConstraints);

    const proposedTrip = {
      ...currentTrip,
      constraints: proposedConstraints,
      cities: (currentTrip.cities ?? []).map((c: any, i: number) => ({
        ...c,
        dates: {
          arrival: newCities[i].arrival_date,
          departure: newCities[i].departure_date,
        },
      })),
    };

    return res.json({
      type: 'proposal',
      reply: replyText,
      proposal: {
        kind: 'date_shift',
        toolName,
        toolInput,
        diff,
        proposedConstraints,
        proposedTrip,
      },
    });
  }),
);

/**
 * Human-readable phrase describing a time window, e.g.
 * "arriving before 14:00" or "departing between 17:00 and 22:00".
 * Returns an empty string if the window has no active bounds.
 */
function describeWindow(w: {
  earliestDepart?: string | null;
  latestDepart?: string | null;
  earliestArrive?: string | null;
  latestArrive?: string | null;
}): string {
  const bits: string[] = [];
  if (w.earliestDepart && w.latestDepart)
    bits.push(`departing between ${w.earliestDepart} and ${w.latestDepart}`);
  else if (w.earliestDepart) bits.push(`departing after ${w.earliestDepart}`);
  else if (w.latestDepart) bits.push(`departing before ${w.latestDepart}`);

  if (w.earliestArrive && w.latestArrive)
    bits.push(`arriving between ${w.earliestArrive} and ${w.latestArrive}`);
  else if (w.earliestArrive) bits.push(`arriving after ${w.earliestArrive}`);
  else if (w.latestArrive) bits.push(`arriving before ${w.latestArrive}`);

  return bits.join(', ');
}

// ─── POST /api/plan/chat-suggestions ─────────────────────────
// Returns 4 trip-specific suggested prompts for the chat UI. Called once
// on panel mount. Uses a single small Claude call (~300 tokens) so the
// prompts feel tailored to THIS trip rather than generic placeholders.
const chatSuggestionsSchema = z.object({ currentTrip: z.any() });

router.post(
  '/chat-suggestions',
  asyncHandler(async (req, res) => {
    const { currentTrip } = chatSuggestionsSchema.parse(req.body);
    const anthropic = getAnthropicSafe();

    // Fallback list if AI is unavailable — still trip-aware via simple
    // heuristics so the chip set never feels empty.
    const fallback = buildFallbackSuggestions(currentTrip);

    if (!anthropic) {
      return res.json({ suggestions: fallback });
    }

    const { DEFAULT_MODEL } = require('../services/anthropic');
    const summary = summarizeTripForChat(currentTrip);

    try {
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 400,
        system: `You generate 4 short, specific, trip-tailored prompt suggestions that the user could click to start a conversation with Voyza AI about their itinerary. Each suggestion:
- Is under 40 characters
- References a specific city, leg, or feature of THIS trip (not generic)
- Is a question or a request the user might realistically have
- Covers a mix: one "why" question (ordering/pricing), one cost-cutting request, one constraint/timing request, one enhancement (activity/swap)

Return ONLY a JSON array of 4 strings, no prose, no markdown fences.`,
        messages: [
          { role: 'user', content: `Trip:\n${JSON.stringify(summary, null, 2)}` },
        ],
      });

      const text = response.content?.[0]?.type === 'text' ? (response.content[0] as any).text : '';
      const parsed = extractJson(text);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string') && parsed.length >= 3) {
        // Trim to 4, pad with fallback if fewer than 4.
        const trimmed = parsed.slice(0, 4).map((s: string) => s.slice(0, 60));
        while (trimmed.length < 4) trimmed.push(fallback[trimmed.length]);
        return res.json({ suggestions: trimmed });
      }
    } catch (err: any) {
      logger.warn('chat-suggestions Claude call failed', { message: err?.message });
    }

    return res.json({ suggestions: fallback });
  }),
);

/**
 * Rule-based fallback for dynamic prompts when the AI call fails or
 * no API key is configured. Still trip-aware — picks cities/legs out
 * of the trip so it doesn't feel hardcoded.
 */
function buildFallbackSuggestions(trip: any): string[] {
  const cities = (trip.cities ?? []).map((c: any) => c.name);
  if (cities.length === 0) {
    return [
      'Why this trip order?',
      'How can I save money?',
      'Add a rest day',
      'Swap a city',
    ];
  }
  // Most expensive city by hotel nightly rate (cheap heuristic).
  let expensiveCity = cities[0];
  let maxRate = 0;
  for (const c of trip.cities ?? []) {
    const rate = c.hotel?.pricePerNight ?? 0;
    if (rate > maxRate) {
      maxRate = rate;
      expensiveCity = c.name;
    }
  }
  const firstCity = cities[0];
  return [
    `Why this order of cities?`,
    `Make ${expensiveCity} cheaper`,
    `Pin ${firstCity} to specific dates`,
    `Add a day in ${cities[cities.length - 1]}`,
  ].slice(0, 4);
}

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
