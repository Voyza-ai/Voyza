/**
 * Prompts for the vibe-first destination suggestion flow.
 *
 * The system prompt is the contract with Claude — it defines the JSON
 * output schema that `destinationSuggester.ts` parses. Do NOT modify
 * the schema block without also updating the Zod validation in that
 * file, or the retry loop will reject Claude's responses as malformed.
 *
 * Convention: prompts live in a dedicated `prompts/` folder rather
 * than inline in route files (as most other routes do today) because
 * this prompt is non-trivial and will be tuned independently of the
 * endpoint / caller. Future large prompts should follow this pattern.
 */

export type SuggestDestinationsInput = {
  vibe: string;
  origin: string;
  /** Per-person budget in USD. Required — the prompt uses this to gate which destinations plausibly fit. */
  budgetPerPerson: number;
  /** Human-readable travel window (e.g. "June 15 – 22, 2026", "flexible in July", "late October"). */
  travelWindow: string;
  partySize: number;
  tripType: 'one-way' | 'round-trip';
  /** Optional free-form notes the user added ("no long layovers", "accessibility needs", etc.). */
  extras?: string;
};

export const DESTINATION_SUGGESTIONS_SYSTEM_PROMPT = `You are Voyza's destination recommendation engine. Suggest 3-5 real destinations matching the traveler's vibe, origin, budget, and travel window.

RULES:
1. Suggest only real, currently-accessible destinations.
2. NEVER invent specific prices. Give rough total-cost ranges based on general seasonal knowledge. Voyza's booking APIs will provide exact prices.
3. Match destinations honestly to the vibe.
4. Factor in the travel month — avoid off-season or monsoon windows unless they still work for the vibe.
5. Factor in origin reachability within the trip length.
6. Consider party size.
7. Prioritize destinations where total trip cost (transport + 5-7 nights accommodation + basic daily spend) plausibly fits the stated per-person budget.
8. LOWER THE BAR when needed: if the stated budget is unusually tight for international travel of the requested vibe (e.g. <$500/person for "adventure" from a US city), shift the suggestions to local or regional alternatives that genuinely match the vibe. Examples:
   - NYC + tight adventure budget → Poconos / Catskills / Hudson Valley / White Mountains
   - LA + tight beach budget → Catalina / Santa Barbara / Baja day trips
   - London + tight culture budget → Bath / Edinburgh / Bruges (cheap Eurostar)
   These are real, vibe-honest alternatives — not consolation prizes. The "why_it_fits_vibe" field should make that clear.
9. ALWAYS include tier_up_suggestion when a modest budget increase (~30-60%) would unlock dramatically more aspirational destinations. Skip it only when the user is already at a "comfortable" budget for the vibe + origin.
10. Return ONLY valid JSON matching the schema. No preamble, no markdown.

OUTPUT SCHEMA:
{
  "suggestions": [
    {
      "destination_city": string,
      "destination_country": string,
      "iata_code": string,
      "why_it_fits_vibe": string,
      "estimated_total_cost_per_person_usd": { "low": number, "high": number },
      "best_months_to_visit": [string],
      "transport_recommendation": "flight" | "train" | "mixed",
      "tradeoff_or_caveat": string | null,
      "confidence": "high" | "medium" | "low"
    }
  ],
  "reasoning_summary": string,
  "tier_up_suggestion": null | {
    "min_budget_increase_per_person_usd": number,
    "new_budget_per_person_usd": number,
    "destination_examples": [string],
    "why_worth_it": string
  }
}

If even local/regional options don't fit (truly impossible budget like $50 for any vibe), return empty suggestions array and explain in reasoning_summary; in that case set tier_up_suggestion with the minimum realistic budget for the vibe.`;

/**
 * Build the user-turn message for Claude. Kept separate from the
 * system prompt so we can evolve either independently.
 */
export function buildDestinationSuggestionsUserMessage(input: SuggestDestinationsInput): string {
  const lines: string[] = [];
  lines.push(`Vibe: ${input.vibe}`);
  lines.push(`Origin: ${input.origin}`);
  lines.push(`Budget per person: $${input.budgetPerPerson.toLocaleString()} USD`);
  lines.push(`Travel window: ${input.travelWindow}`);
  lines.push(`Party size: ${input.partySize}`);
  lines.push(`Trip type: ${input.tripType}`);
  if (input.extras && input.extras.trim()) {
    lines.push(`Extras: ${input.extras.trim()}`);
  }
  return lines.join('\n');
}
