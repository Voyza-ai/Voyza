/**
 * A synthetic artifact at real scale, for the performance budgets.
 *
 * The measurements that chose the trigram index were taken at 50,000 terms, so
 * the budgets are asserted at 50,000 terms. Deterministic: a flaky performance
 * test gets deleted, and a performance test whose input changes per run is
 * measuring the generator.
 *
 * Shape only — this is not pretending to be geography. Name lengths are spread
 * across the range that matters (3 to 14 characters) because the fuzzy index
 * has two different code paths either side of 5.
 */

import type { LocationArtifact, Place } from '../types';

/** mulberry32: small, fast, and seeded, so every run sees the same artifact. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Three syllable pools rather than two, and the pools are large.
 *
 * The first version of this generator drew from 12 heads and 11 tails, which
 * put the trigram `ton` in a twelfth of the dictionary and made every fuzzy
 * query touch 20,000 postings. That is not what 50,000 real city names look
 * like, and benchmarking against it measures the generator. 24 x 20 x 18
 * gives ~8,600 stems, which is in the right neighbourhood for a real
 * gazetteer's trigram distribution.
 */
const HEADS = [
  'bar', 'kel', 'mor', 'san', 'lin', 'tro', 'ald', 'bri', 'cas', 'dun', 'esh', 'fal',
  'gor', 'hul', 'ips', 'jar', 'kir', 'lum', 'nov', 'oke', 'pru', 'qua', 'rho', 'syl',
];
const MIDS = [
  '', 'a', 'o', 'en', 'ir', 'ul', 'ash', 'emb', 'ond', 'ert', 'ins', 'ola',
  'uve', 'yzh', 'rab', 'sko', 'tiv', 'wen', 'xan', 'zel',
];
const TAILS = [
  'ton', 'field', 'burg', 'ville', 'ham', 'dale', 'port', 'mouth', 'ford', 'by',
  'na', 'stad', 'grad', 'pool', 'shire', 'wick', 'gen', 'heim',
];
const COUNTRIES = ['US', 'FR', 'DE', 'GB', 'IT', 'ES', 'BR', 'IN', 'JP', 'AU', 'CA', 'MX'];

export function syntheticArtifact(count: number, seed = 20_260_101): LocationArtifact {
  const random = rng(seed);
  const places: Place[] = [];
  const used = new Set<string>();

  for (let i = 0; i < count; i++) {
    const head = HEADS[Math.floor(random() * HEADS.length)];
    const mid = MIDS[Math.floor(random() * MIDS.length)];
    const tail = TAILS[Math.floor(random() * TAILS.length)];
    // A tenth of the names are short, which is where trigram recall drops and
    // the brute-force path takes over.
    let name = random() < 0.1 ? head : `${head}${mid}${tail}`;
    if (used.has(name)) name = `${name}${i.toString(36)}`;
    used.add(name);

    const country = COUNTRIES[Math.floor(random() * COUNTRIES.length)];
    places.push({
      id: `syn-${i}`,
      name: name[0].toUpperCase() + name.slice(1),
      aliases: random() < 0.3 ? [`${name} city`] : [],
      // Synthetic places are all dataset-grade: curation is hand work and the
      // real artifact has a couple of dozen entries, not 50,000.
      curatedAliases: [],
      kind: 'city',
      country,
      admin: `A${Math.floor(random() * 50)}`,
      lat: random() * 160 - 80,
      lon: random() * 360 - 180,
      population: Math.floor(random() * 2_000_000),
      airportRank: random() < 0.4 ? Math.floor(random() * 30_000_000) : null,
      metro: null,
      airports: [{ iata: iataFor(i), km: Math.round(random() * 180), servesPlace: true }],
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: { ourAirports: 'synthetic', geoNames: 'synthetic' },
    places,
  };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function iataFor(i: number): string {
  return (
    LETTERS[Math.floor(i / 676) % 26] + LETTERS[Math.floor(i / 26) % 26] + LETTERS[i % 26]
  );
}
