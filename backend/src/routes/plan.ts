import { keepOwnCity, otherStopsHint } from '../utils/cityPicks';
import { stripOriginFiller } from '../services/location/originPhrase';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { converse } from '../services/planConverse';
import { runTripChat } from '../services/tripChat';
import { reviseDestinations } from '../services/destinationRevision';
import { todayIso } from '../utils/dates';

import { getAnthropicSafe } from '../services/anthropic';
import {
  cachedPlacesAndPrefetch,
  providerName,
  resolvePlaces,
  type PlaceRequestItem,
  type ResolvedPlace,
} from '../services/places';
import { travelLegs } from '../services/places/travel';

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

// ─── POST /api/plan/converse ─────────────────────────────────
// The conversational planner: one AI turn per user message. Replies like
// a human agent, extracts any trip facts present (any order, several at
// once), and tells the UI what to render next (question / city picker /
// vibe picker / budget slider / ready recap). 503 'assistant_unavailable'
// on AI failure so the client can offer an honest Retry.
const converseSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(40)
    .default([]),
  known: z
    .object({
      destinations: z.array(z.string()).optional(),
      origin: z.string().nullable().optional(),
      dates: z
        .object({ start: z.string(), end: z.string() })
        .nullable()
        .optional(),
      travelers: z.number().nullable().optional(),
      budget: z.number().nullable().optional(),
      budgetPerPerson: z.boolean().nullable().optional(),
      vibe: z.string().nullable().optional(),
      returnToHome: z.boolean().nullable().optional(),
      notes: z.string().nullable().optional(),
    })
    .default({}),
  userLocation: z.string().optional(),
});

router.post(
  '/converse',
  asyncHandler(async (req, res) => {
    const input = converseSchema.parse(req.body);
    const result = await converse(input);
    res.json(result);
  }),
);

// ─── POST /api/plan/revise-destinations ──────────────────────
// Guided planner, after the destination step: a free-text correction
// ("actually Venice not Venezuela") edits ONLY the destination list — see
// services/destinationRevision.ts. 503 'assistant_unavailable' on AI failure.
const reviseDestinationsSchema = z.object({
  message: z.string().min(1).max(2000),
  destinations: z.array(z.string().min(1).max(200)).min(1).max(30),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .max(40)
    .default([]),
  currentQuestion: z.string().max(500).optional(),
});

router.post(
  '/revise-destinations',
  asyncHandler(async (req, res) => {
    const input = reviseDestinationsSchema.parse(req.body);
    res.json(await reviseDestinations(input));
  }),
);

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
      try {
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
- origin (string or null) — the city the user is flying FROM (their home or starting point). Parse phrases like "from NYC", "flying out of London", "I'm in Tokyo", "leaving from San Francisco". Return the plain city name (not the IATA code); a US state or region ("New Jersey", "Long Island", "Northern Virginia") is fine as written. Null if the user didn't mention where they're coming from.
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
      if (parsed) {
        // "from New Jersey" -> "New Jersey": the origin lookup reads this string.
        if (typeof parsed.origin === 'string') parsed.origin = stripOriginFiller(parsed.origin) || null;
        return res.json(parsed);
      }
      logger.warn('AI interpret returned unparseable output — using heuristic fallback');
      } catch (err: any) {
        // AI failed (e.g. depleted credits, rate limit, network). Fall through
        // to the heuristic below so country detection / city selection still
        // works instead of returning a 500 that the client can't act on.
        logger.warn('AI interpret failed — using heuristic fallback', {
          message: err?.message,
        });
      }
    }

    // Heuristic response (also the fallback when the AI call above fails) —
    // extract city/country names from the raw input
    const words = rawInput
      .split(/[,&+]|\band\b/i)
      .map((w) => w.trim())
      .filter(Boolean);

    const destinations: string[] = [];
    const countries: Array<{ country: string; cities: string[] }> = [];
    let needsCitySelection = false;

    const seenCountry = new Set<string>();
    for (const w of words) {
      const lower = w.toLowerCase();
      // Match either an exact country ("Greece") or a country name embedded in
      // a natural-language phrase ("I want to go to Greece").
      let matchedKey = COUNTRY_CITIES[lower] ? lower : undefined;
      if (!matchedKey) {
        matchedKey = Object.keys(COUNTRY_CITIES).find((key) =>
          new RegExp(`\\b${key}\\b`, 'i').test(lower),
        );
      }

      if (matchedKey) {
        // It's a country — flag for city selection (skip duplicates).
        if (!seenCountry.has(matchedKey)) {
          seenCountry.add(matchedKey);
          const citiesForCountry = COUNTRY_CITIES[matchedKey];
          destinations.push(citiesForCountry[0]);
          countries.push({
            country: matchedKey.charAt(0).toUpperCase() + matchedKey.slice(1),
            cities: citiesForCountry,
          });
          needsCitySelection = true;
        }
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
// The BlueMurr AI chat endpoint. Replaces the old /edit (which returned a
// freeform JSON patch that the frontend never actually applied). The turn
// itself — the model call, its tools, the searches and the checked
// proposals — is services/tripChat.ts `runTripChat`; see its header for the
// response shapes. Nothing here writes: Accept is applied on the client (the
// trip store on /results, canvas local state on /canvas).
//
// Constraints (pins, min stays, transport windows) are applied once, in the
// chat turn, and never again: the optimizer doesn't read them, and no trips
// write path (POST/PATCH /api/trips, canvas save) accepts them, so
// `trips.constraints` stays '{}'. They survive only on the results page's
// in-memory trip, where the next chat turn re-applies the date ones (see
// services/constraints.ts).
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
 * Compact a trip into what /chat-suggestions needs to write its chips.
 * (/chat itself is told more — every leg, home included: services/tripLegs.ts.)
 * Raw flight payloads, hotel rankings, etc. are left out.
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
    // The chat's core lives in services/tripChat.ts (runTripChat), shared
    // with other callers (e.g. a future iMessage bot; none in this repo yet).
    res.json(await runTripChat({ message, currentTrip, history }));
  }),
);

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

    // Which legs have any train in the trip. Rail can come back empty (the
    // demo triage found it empty in production: no ALLABOARD_API_KEY), and a chip
    // like "Can we take train Rome→Florence?" then leads straight to a
    // comparison card reading "Train — No options found" (D-07).
    const tripCities = currentTrip.cities ?? [];
    const legs = tripCities.slice(0, -1).map((c: any, i: number) => ({
      from: c.name,
      to: tripCities[i + 1].name,
      mode: c.transportOut?.mode ?? null,
      // A leg nothing was found for (no flight, and rail dark): Zurich →
      // Interlaken share ZRH, so it is never searched as a flight. A chip
      // like "Cheaper Zurich → Interlaken flight?" leads to "nothing found".
      optionFound: !c.transportOut?.unavailable,
      trainFound:
        c.transportOut?.mode === 'train' ||
        (c.transportOut?.alternatives ?? []).some((a: any) => a?.mode === 'train'),
    }));
    const anyTrain = legs.some((l: any) => l.trainFound);
    const namesNoOptionLeg = (s: string) =>
      legs.some((l: any) => {
        if (l.optionFound) return false;
        const text = s.toLowerCase();
        const from = text.indexOf(String(l.from).toLowerCase());
        const to = text.indexOf(String(l.to).toLowerCase());
        return from >= 0 && to > from;
      });

    try {
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 400,
        // The chat's tools are listed so suggestions stay inside them: the
        // old "one enhancement (activity/swap)" asked for things no tool
        // does — "Add Thames river activity in London?" got "I can't book
        // activities directly" (D-07).
        system: `You generate 4 short, specific, trip-tailored prompt suggestions that the user could click to start a conversation with BlueMurr AI about their itinerary.

Today is ${todayIso()} (UTC). Any date a suggestion mentions must be in the future.

Each suggestion:
- Is under 40 characters
- References a specific city, leg, or feature of THIS trip (not generic)
- Is a question or a request the user might realistically have
- Is something BlueMurr AI can actually do (below)

BlueMurr AI CAN: explain the trip (why this city order, why a price); lock a city to specific dates; give a city more nights; set a departure or arrival time limit on one leg; show cheaper or other flight/train options for one named leg; compare flight vs train for one named leg.
BlueMurr AI can NOT: book anything, add activities, tours or restaurants, change hotels, or add, remove or swap cities. Never suggest those.

Trains: mention a train only for a leg whose "trainFound" is true in "legs". If no leg has "trainFound": true, do not mention trains at all.
Never suggest anything about a leg whose "optionFound" is false: nothing was found for it.

Cover a mix: one "why" question (ordering/pricing), one cheaper-option request naming a specific leg, one dates or time-of-day request, and one more of any kind above.

Return ONLY a JSON array of 4 strings, no prose, no markdown fences.`,
        messages: [
          { role: 'user', content: `Trip:\n${JSON.stringify({ ...summary, legs }, null, 2)}` },
        ],
      });

      const text = response.content?.[0]?.type === 'text' ? (response.content[0] as any).text : '';
      const parsed = extractJson(text);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string') && parsed.length >= 3) {
        // The prompt asks; this enforces. Drop any suggestion for something
        // the chat can't do, any train suggestion when no leg has a train,
        // and any naming a leg with no option — then trim to 4 and pad with
        // fallback as before.
        const doable = parsed.filter(
          (s: string) =>
            !CANT_DO_SUGGESTION.test(s) && (anyTrain || !TRAIN_SUGGESTION.test(s)) && !namesNoOptionLeg(s),
        );
        const trimmed = doable.slice(0, 4).map((s: string) => s.slice(0, 60));
        while (trimmed.length < 4) trimmed.push(fallback[trimmed.length]);
        return res.json({ suggestions: trimmed });
      }
    } catch (err: any) {
      logger.warn('chat-suggestions Claude call failed', { message: err?.message });
    }

    return res.json({ suggestions: fallback });
  }),
);

/** Suggestions for things no chat tool does (booking, activities, …). */
const CANT_DO_SUGGESTION =
  /\b(activit(?:y|ies)|tours?|restaurants?|book(?:s|ed|ing)?|reserv\w*|tickets?)\b/i;
/** Suggestions about trains — dropped when no leg of the trip has one. */
const TRAIN_SUGGESTION = /\b(trains?|rail)\b/i;

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

// ─── Real coordinates for AI picks ───────────────────────────
//
// The model names places; a POI provider (services/places) says where they
// are. Anything coordinate-shaped in the model's own output is stripped, so
// a location can only ever come from the provider.

/** Keep well-formed picks, drop any model-supplied coordinates, attach cached real ones. */
function withCachedPlaces(parsed: any[], city: string, country?: string): any[] {
  const picks = parsed
    .filter((p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
    .map(({ lat: _lat, lng: _lng, lon: _lon, latitude: _la, longitude: _lo, placeId: _pid, ...rest }: any) => ({
      ...rest,
      placeQuery: typeof rest.placeQuery === 'string' && rest.placeQuery.trim() ? rest.placeQuery.trim() : undefined,
    }));
  const places = cachedPlacesAndPrefetch(
    city,
    country,
    picks.map((p): PlaceRequestItem => ({ name: p.name, placeQuery: p.placeQuery })),
  );
  return picks.map((p, i) => withPlace(p, places[i]));
}

const withPlace = <T extends object>(item: T, place: ResolvedPlace | undefined): T =>
  place && place.lat != null && place.lng != null && place.placeId
    ? { ...item, lat: place.lat, lng: place.lng, placeId: place.placeId }
    : item;

// ─── POST /api/plan/places ───────────────────────────────────
// Coordinates for a city's picks, from the configured POI provider, answered
// within `PLACES_DEADLINE_MS`. Items still queued (Nominatim, 1/s) come back
// `pending: true` and keep resolving into the cache. With a Google key the
// response also carries measured walk/transit times between the places.
const PLACES_DEADLINE_MS = 20_000;
const placesSchema = z.object({
  city: z.string().min(1).max(120),
  country: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        placeQuery: z.string().max(200).nullable().optional(),
        kind: z.enum(['activity', 'restaurant']).optional(),
      }),
    )
    .max(30),
  deadlineMs: z.number().int().min(0).max(PLACES_DEADLINE_MS).optional(),
});

router.post(
  '/places',
  asyncHandler(async (req, res) => {
    const { city, country, items, deadlineMs } = placesSchema.parse(req.body);
    const started = Date.now();
    const places = await resolvePlaces(city, country, items, {
      deadlineMs: deadlineMs ?? PLACES_DEADLINE_MS,
    });
    const points = places
      .filter((p) => p.lat != null && p.lng != null && p.placeId)
      .map((p) => ({ placeId: p.placeId!, lat: p.lat!, lng: p.lng! }));
    const legs = await travelLegs(points);
    logger.info('places resolved', {
      city,
      provider: providerName(),
      asked: items.length,
      resolved: points.length,
      pending: places.filter((p) => p.pending).length,
      ms: Date.now() - started,
    });
    res.json({
      provider: providerName(),
      places,
      ...(legs ? { travel: { source: 'google', legs } } : {}),
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
  /** The trip's other stops, so this city's picks stay in this city. */
  otherCities: z.array(z.string().max(120)).max(30).optional(),
});

router.post(
  '/activities',
  asyncHandler(async (req, res) => {
    const { city, country, vibe, travelers, nights, otherCities } = activitiesSchema.parse(req.body);
    const anthropic = getAnthropicSafe();

    if (anthropic) {
      const { DEFAULT_MODEL } = require('../services/anthropic');
      const n = Math.max(5, Math.min(8, (nights ?? 2) * 2 + 1));

      const vibeHint = vibe ? `The traveler's vibe is: ${vibe}. ` : '';
      const groupHint = travelers && travelers > 1 ? `They're traveling as a group of ${travelers}. ` : '';

      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: `You recommend things to do in a city. ${vibeHint}${groupHint}${otherStopsHint(city, otherCities)}Pick ${n} diverse activities — a mix of must-see landmarks, cultural experiences, food, and a couple lesser-known picks. Avoid generic listicle fodder.

Respond with ONLY a JSON array, no markdown fences, no explanation. Each item:
{
  "name": "specific activity or place name (not a generic description)",
  "category": "landmark" | "museum" | "food" | "nature" | "nightlife" | "experience" | "shopping",
  "timeOfDay": "morning" | "afternoon" | "evening",
  "durationHours": number between 1 and 4,
  "reason": "one short sentence why",
  "placeQuery": "the venue or landmark exactly as it is named on a map (e.g. \"Musée d'Orsay\"), or null when the activity has no single location"
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
        return res.json({ activities: withCachedPlaces(keepOwnCity(parsed, city, otherCities), city, country) });
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
  otherCities: z.array(z.string().max(120)).max(30).optional(),
});

router.post(
  '/restaurants',
  asyncHandler(async (req, res) => {
    const { city, country, vibe, travelers, budget, otherCities } = restaurantsSchema.parse(req.body);
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
        system: `You recommend restaurants in a city. ${vibeHint}${groupHint}${otherStopsHint(city, otherCities)}Pick 5 diverse spots representing local specialties. Avoid generic chain restaurants and tourist traps. ${budgetHint}

Respond with ONLY a JSON array, no markdown fences, no explanation. Each item:
{
  "name": "specific restaurant name (real, well-known spot)",
  "cuisine": "short cuisine label, e.g. 'Roman pasta', 'Neapolitan pizza', 'izakaya', 'ramen'",
  "priceRange": "$" | "$$" | "$$$" | "$$$$",
  "mealType": "breakfast" | "lunch" | "dinner" | "any",
  "reason": "one short sentence why a traveler should go",
  "placeQuery": "the restaurant's name as it appears on a map, with its street or neighbourhood if the name is common"
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
        return res.json({ restaurants: withCachedPlaces(keepOwnCity(parsed, city, otherCities), city, country) });
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
