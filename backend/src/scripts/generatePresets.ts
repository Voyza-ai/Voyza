/**
 * Bulk-generate preset trips with Claude across the taxonomy combinations
 * in services/presetGeneration.ts, validate them, attach a real landmark
 * photo (Wikipedia), and append them to src/data/presets/generated.json.
 *
 * The output is a reviewable file in the repo — nothing goes live until
 * it's committed and seeded (npx tsx src/scripts/seedPresets.ts).
 *
 *   npx tsx src/scripts/generatePresets.ts            # all missing combos
 *   npx tsx src/scripts/generatePresets.ts --limit 3  # just a few
 *   npx tsx src/scripts/generatePresets.ts --all      # every taxonomy combination
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { getAnthropic, DEFAULT_MODEL } from '../services/anthropic';
import { presetFacts, type PresetData } from '../services/presetTaxonomy';
import {
  GENERATION_COMBOS,
  allTaxonomyCombos,
  PRESET_TOOL,
  generationPrompt,
  validateGenerated,
  coverImageFor,
  type GenerationCombo,
} from '../services/presetGeneration';

const DIR = path.join(__dirname, '..', 'data', 'presets');
const curated: PresetData[] = JSON.parse(readFileSync(path.join(DIR, 'curated.json'), 'utf8'));
const genPath = path.join(DIR, 'generated.json');
let generated: PresetData[] = JSON.parse(readFileSync(genPath, 'utf8'));

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const comboKey = (c: GenerationCombo) => `${c.vibe}|${c.region}|${c.duration}|${c.tier}`;


async function generateOne(combo: GenerationCombo, index: number, avoid: string[]) {
  const anthropic = getAnthropic();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 4000,
      tools: [PRESET_TOOL as any],
      tool_choice: { type: 'tool', name: PRESET_TOOL.name },
      messages: [{ role: 'user', content: generationPrompt(combo, avoid) }],
    });
    const tool = res.content.find((c: any) => c.type === 'tool_use') as any;
    const { preset, problems, warnings } = validateGenerated(tool?.input, combo, index);
    for (const w of warnings) console.log(`   ⚠ ${comboKey(combo)}: ${w} — review this trip`);
    if (preset) {
      preset.coverImage = await coverImageFor([tool.input.coverImageWikipediaTitle, preset.cities[0].name]);
      return preset;
    }
    console.log(`   ↻ ${comboKey(combo)} attempt ${attempt} rejected: ${problems.slice(0, 3).join('; ')}`);
  }
  return null;
}

(async () => {
  // A combo counts as done once a generated preset covers it (tracked by
  // a hidden tag), so re-running the script only fills gaps.
  const done = new Set(generated.flatMap((p) => (p.searchTags ?? []).filter((t) => t.startsWith('combo:'))));
  // Default: the curated priority list. --all: every taxonomy combination.
  const combos = process.argv.includes('--all') ? allTaxonomyCombos() : GENERATION_COMBOS;
  const todo = combos.filter((c) => !done.has(`combo:${comboKey(c)}`)).slice(0, limit);
  console.log(`${todo.length} combos to generate (${generated.length} already generated)`);

  const taken = new Set([...curated, ...generated].map((p) => p.slug));
  let ok = 0;
  for (const [i, combo] of todo.entries()) {
    const avoid = [...curated, ...generated].flatMap((p) => p.cities.map((c) => c.name));
    try {
      const preset = await generateOne(combo, generated.length + i, Array.from(new Set(avoid)));
      if (!preset) {
        console.log(` ✗ ${comboKey(combo)} — skipped after 2 attempts`);
        continue;
      }
      if (taken.has(preset.slug)) preset.slug = `${preset.slug}-${generated.length + 1}`;
      preset.searchTags = [...(preset.searchTags ?? []), `combo:${comboKey(combo)}`];
      taken.add(preset.slug);
      generated.push(preset);
      writeFileSync(genPath, JSON.stringify(generated, null, 2) + '\n'); // save as we go
      const f = presetFacts(preset);
      ok++;
      console.log(
        ` ✓ ${preset.title} — ${preset.cities.map((c) => c.name).join(' → ')} · ${f.nights}n · ~$${f.estCost} · ${preset.coverImage ? '📷' : 'no photo'}`,
      );
    } catch (err: any) {
      console.log(` ✗ ${comboKey(combo)} — ${err?.message}`);
    }
  }
  console.log(`done: ${ok} generated, catalog now ${curated.length + generated.length} presets`);
  process.exit(0);
})();
