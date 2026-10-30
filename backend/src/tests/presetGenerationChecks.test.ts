/**
 * Audit E16: the generator's validation let through what the shipped
 * generated.json shows — "Ferry + Transfer" stored as a flight, a hotel
 * called "Hotel A", and towns no airport serves. Each is now a problem that
 * rejects the generation (the script retries, then skips the combo).
 */
import {
  gatewayAirport,
  isGenericHotelName,
  operatorModeProblem,
  validateGenerated,
} from '../services/presetGeneration';
import curated from '../data/presets/curated.json';
import generated from '../data/presets/generated.json';

const city = (over: any = {}) => ({
  name: 'Rome',
  country: 'Italy',
  nights: 2,
  hotel: { name: 'Hotel Artemide', rating: 8.5, pricePerNight: 150, area: 'Centro' },
  activities: ['Colosseum', 'Vatican'],
  restaurants: [{ name: 'R', cuisine: 'Italian', priceRange: '$$' }],
  vibes: ['history'],
  ...over,
});
const combo = { vibe: 'history' as const, region: 'europe' as const, duration: 'weekend' as const, tier: '$$' as const };
const trip = (cities: any[]) => ({
  title: 'Italian Days',
  tagline: 't',
  description: 'd',
  searchTags: [],
  coverImageWikipediaTitle: 'Colosseum',
  budgetEstimateTotal: 900,
  cities,
});
const leg = (mode: string, operator: string) => ({ mode, operator, duration: '1h 30m', price: 45 });
const problemsOf = (cities: any[]) => validateGenerated(trip(cities), combo, 0).problems.join(' | ');

describe('operator must match the mode', () => {
  it('rejects the shipped "Ferry + Transfer" flight, a train-named flight, and an airline-named train', () => {
    expect(problemsOf([city({ transportOut: leg('flight', 'Ferry + Transfer') }), city({ name: 'Florence' })]))
      .toMatch(/operator "Ferry \+ Transfer" is not a flight/);
    expect(problemsOf([city({ transportOut: leg('flight', 'Trenitalia Frecciarossa') }), city({ name: 'Florence' })]))
      .toMatch(/is a train, not a flight/);
    expect(problemsOf([city({ transportOut: leg('train', 'ITA Airways') }), city({ name: 'Florence' })]))
      .toMatch(/is an airline, not a train/);
  });

  it('accepts every operator in the curated catalog, including airlines with no "air" in the name', () => {
    for (const p of curated as any[]) {
      for (const c of p.cities) {
        if (c.transportOut) expect([c.transportOut.operator, operatorModeProblem(c.transportOut.mode, c.transportOut.operator)]).toEqual([c.transportOut.operator, null]);
      }
    }
    expect(operatorModeProblem('flight', 'Sky Express')).toBeNull();
    expect(operatorModeProblem('flight', 'Scoot')).toBeNull();
    expect(operatorModeProblem('train', 'Vy (Bergen Railway)')).toBeNull();
  });
});

describe('hotel names must name a real property', () => {
  it('rejects "Hotel A" and other placeholders', () => {
    for (const n of ['Hotel A', 'The Hotel', 'Boutique Hotel 2', 'Beach Resort', 'Local guesthouse', '']) {
      expect([n, isGenericHotelName(n)]).toEqual([n, true]);
    }
    expect(problemsOf([city({ hotel: { ...city().hotel, name: 'Hotel A' } })])).toMatch(/generic hotel name "Hotel A"/);
  });

  it('accepts every hotel in the curated catalog (short names, letters and city names included)', () => {
    for (const p of curated as any[]) for (const c of p.cities) expect([c.hotel.name, isGenericHotelName(c.hotel.name)]).toEqual([c.hotel.name, false]);
    for (const n of ['Hotel V Nesplein', 'Hotel G Singapore', 'Hotel 7 Taichung', 'Krabi Resort', 'Hôtel Rossetti']) {
      expect(isGenericHotelName(n)).toBe(false);
    }
  });
});

describe('every city must have an airport', () => {
  it('finds the gateway for real preset cities, including towns flown to from a neighbour', () => {
    expect(gatewayAirport('Rome', 'Italy')?.iata).toBe('FCO');
    expect(gatewayAirport('Sintra', 'Portugal')?.iata).toBe('LIS');
    expect(gatewayAirport('Kyoto', 'Japan')?.iata).toBe('KIX');
  });

  // A made-up town, so this stays true when real towns (Mount Cook Village,
  // Monteverde — rejected today) get airports pinned in data/cityAirports.ts.
  it('rejects a city nothing serves', () => {
    expect(gatewayAirport('Zzyzxville', 'New Zealand')).toBeNull();
    expect(problemsOf([city({ name: 'Zzyzxville', country: 'New Zealand' })])).toMatch(
      /no airport within 150 km of Zzyzxville, New Zealand/,
    );
  });
});

describe('the shipped generated.json, through the new checks', () => {
  it('flags exactly the presets the audit found (reported, not deleted)', () => {
    const flagged: string[] = [];
    for (const p of generated as any[]) {
      for (const [i, c] of p.cities.entries()) {
        const last = i === p.cities.length - 1;
        if (!last && c.transportOut) {
          const m = operatorModeProblem(c.transportOut.mode, c.transportOut.operator);
          if (m) flagged.push(`${p.slug}: ${m}`);
        }
        if (isGenericHotelName(c.hotel.name)) flagged.push(`${p.slug}: hotel "${c.hotel.name}"`);
      }
    }
    expect(flagged).toEqual([
      expect.stringMatching(/Ferry \+ Transfer/),
      expect.stringMatching(/hotel "Hotel A"/),
    ]);
  });
});
