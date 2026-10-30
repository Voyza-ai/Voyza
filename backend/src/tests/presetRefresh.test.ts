jest.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
}));

const mockCompareLeg = jest.fn();
jest.mock('../services/compareLeg', () => ({ compareLeg: (p: any) => mockCompareLeg(p) }));
const mockSearchHotels = jest.fn();
jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: (p: any) => mockSearchHotels(p),
}));

// preset_trips read returns `rows`; every update is recorded in order.
let rows: any[] = [];
const updates: Array<{ slug: string; patch: any }> = [];
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: () => {
      let patch: any = null;
      const chain: any = {};
      chain.select = jest.fn(() => chain);
      chain.update = jest.fn((p: any) => {
        patch = p;
        return chain;
      });
      chain.eq = jest.fn((col: string, val: any) => {
        if (patch && col === 'slug') updates.push({ slug: val, patch });
        return chain;
      });
      chain.then = (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej);
      return chain;
    },
  }),
}));

import { refreshPresetPrices, presetRefreshDue, runScheduledPresetRefresh, isSameHotel, isPlausibleRefresh } from '../services/presets';

const preset = () => ({
  slug: 'two-city',
  title: 'T',
  tagline: '',
  description: '',
  coverGradient: '',
  flags: '',
  scope: '',
  travelers: 2,
  cities: [
    {
      name: 'Rome',
      country: 'Italy',
      nights: 2,
      hotel: { name: 'H', rating: 8, pricePerNight: 100, area: '' },
      activities: [],
      restaurants: [],
      vibes: ['history'],
      transportOut: { mode: 'train', operator: 'Old Rail', duration: '2h 0m', price: 40 },
    },
    {
      name: 'Florence',
      country: 'Italy',
      nights: 2,
      hotel: { name: 'H', rating: 8, pricePerNight: 100, area: '' },
      activities: [],
      restaurants: [],
      vibes: ['art'],
    },
  ],
});

beforeEach(() => {
  rows = [{ slug: 'two-city', data: preset(), source: 'curated' }];
  updates.length = 0;
  mockCompareLeg.mockReset();
  mockSearchHotels.mockReset();
  mockSearchHotels.mockResolvedValue([]);
});

const finalUpdate = () => updates.filter((u) => 'refresh_status' in u.patch).pop()!.patch;
// The preset's data after the run: the last data written, or — when nothing
// came back live and so nothing was written — what was there before.
const finalData = () => updates.filter((u) => 'data' in u.patch).pop()?.patch.data ?? rows[0].data;

describe('refreshPresetPrices (weekly job)', () => {
  it('re-prices legs per person with live search and recomputes cost', async () => {
    mockCompareLeg.mockResolvedValue({
      recommendation: 'train',
      trainOption: { price: 25, durationMinutes: 95, operator: 'Trenitalia' },
      flightOption: null,
    });
    const r = await refreshPresetPrices(new Date('2026-10-10T00:00:00Z'));
    expect(r).toEqual({ refreshed: 1, failed: 0 });

    // Priced for ONE traveler (preset transport prices are per person), on
    // the day the leg departs: Rome's 2-night stay from 11-09 ends 11-11.
    expect(mockCompareLeg).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'Rome', destination: 'Florence', travelers: 1, date: '2026-11-11' }),
    );
    const patch = finalUpdate();
    expect(patch.refresh_status).toBe('fresh');
    // The fare is live; the operator stays the curated one (a refresh
    // re-prices the route, it never renames it — presetRefreshGate.test.ts).
    expect(patch.data.cities[0].transportOut).toEqual({
      mode: 'train',
      operator: 'Old Rail',
      duration: '1h 35m',
      price: 25,
    });
    // hotels (100*2 + 100*2) * 1 room + 25 * 2 travelers = 450
    expect(patch.est_cost).toBe(450);
  });

  it('keeps the previous fare when the live search finds nothing — and does not call that fresh', async () => {
    mockCompareLeg.mockResolvedValue({ recommendation: 'unavailable', trainOption: null, flightOption: null });
    await refreshPresetPrices();
    expect(finalData().cities[0].transportOut.price).toBe(40);
    expect(finalData().cities[0].transportOut.operator).toBe('Old Rail');
    // Nothing was re-priced live (presetRefreshHonest.test.ts).
    expect(finalUpdate()).toEqual({ refresh_status: 'failed' });
  });

  it('never swaps a train leg for a flight (the Lisbon → Sintra live bug)', async () => {
    // No rail data → search falls back to a $468 "flight" to a town with
    // no airport. The curated $40 train must survive.
    mockCompareLeg.mockResolvedValue({
      recommendation: 'flight',
      flightOption: { price: 468, durationMinutes: 60, carrier: 'Duffel Airways' },
      trainOption: null,
    });
    await refreshPresetPrices();
    expect(finalData().cities[0].transportOut).toEqual({
      mode: 'train',
      operator: 'Old Rail',
      duration: '2h 0m',
      price: 40,
    });
  });

  it('rejects an implausible same-mode jump (> 3× either way)', async () => {
    mockCompareLeg.mockResolvedValue({
      recommendation: 'train',
      trainOption: { price: 400, durationMinutes: 95, operator: 'X' },
      flightOption: null,
    });
    await refreshPresetPrices();
    expect(finalData().cities[0].transportOut.price).toBe(40);
  });

  it('isPlausibleRefresh: same mode within 3× only', () => {
    expect(isPlausibleRefresh({ mode: 'train', price: 40 }, 'train', 25)).toBe(true);
    expect(isPlausibleRefresh({ mode: 'train', price: 40 }, 'train', 120)).toBe(true);
    expect(isPlausibleRefresh({ mode: 'train', price: 40 }, 'train', 121)).toBe(false);
    expect(isPlausibleRefresh({ mode: 'train', price: 40 }, 'flight', 41)).toBe(false);
    expect(isPlausibleRefresh(undefined, 'flight', 99)).toBe(true);
  });

  it('marks a preset failed (and keeps going) when search throws', async () => {
    mockCompareLeg.mockRejectedValue(new Error('upstream down'));
    const r = await refreshPresetPrices();
    expect(r).toEqual({ refreshed: 0, failed: 1 });
    expect(updates.pop()!.patch).toEqual({ refresh_status: 'failed' });
  });

  it('re-prices each hotel from a live search of the SAME hotel', async () => {
    mockCompareLeg.mockResolvedValue({ recommendation: 'unavailable', trainOption: null, flightOption: null });
    // Rome: the same hotel is found (name matching ignores case/punctuation);
    // Florence: only other hotels come back → its rate is kept.
    mockSearchHotels.mockImplementation(async ({ city }: any) =>
      city === 'Rome'
        ? [{ name: 'Some Other Hotel', pricePerNight: 50 }, { name: 'h', pricePerNight: 130.4 }]
        : [{ name: 'Different Place', pricePerNight: 40 }],
    );
    await refreshPresetPrices(new Date('2026-10-10T00:00:00Z'));
    // Stays chain from the same start date: Rome 11-09→11-11, Florence 11-11→11-13.
    expect(mockSearchHotels).toHaveBeenCalledWith(
      expect.objectContaining({ city: 'Rome', hotelName: 'H', checkin: '2026-11-09', checkout: '2026-11-11', adults: 2, rooms: 1 }),
    );
    expect(mockSearchHotels).toHaveBeenCalledWith(
      expect.objectContaining({ city: 'Florence', checkin: '2026-11-11', checkout: '2026-11-13' }),
    );
    const patch = finalUpdate();
    expect(patch.data.cities[0].hotel.pricePerNight).toBe(130);
    expect(patch.data.cities[1].hotel.pricePerNight).toBe(100); // kept
    // (130*2 + 100*2) * 1 room + 40 * 2 travelers = 540
    expect(patch.est_cost).toBe(540);
  });

  it('ignores an implausible hotel rate (> 3× the previous)', async () => {
    mockCompareLeg.mockResolvedValue({ recommendation: 'unavailable', trainOption: null, flightOption: null });
    mockSearchHotels.mockResolvedValue([{ name: 'h', pricePerNight: 900 }]);
    await refreshPresetPrices();
    expect(finalData().cities[0].hotel.pricePerNight).toBe(100);
  });

  it('keeps hotel rates when the hotel search throws (and reports the preset failed)', async () => {
    mockCompareLeg.mockResolvedValue({ recommendation: 'unavailable', trainOption: null, flightOption: null });
    mockSearchHotels.mockRejectedValue(new Error('quota'));
    const r = await refreshPresetPrices();
    expect(r).toEqual({ refreshed: 0, failed: 1 });
    expect(finalData().cities.map((c: any) => c.hotel.pricePerNight)).toEqual([100, 100]);
  });
});

describe('weekly schedule', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  it('is due when a preset was never refreshed or the oldest refresh is over a week old', async () => {
    rows = [{ refreshed_at: daysAgo(2) }, { refreshed_at: null }];
    expect(await presetRefreshDue(now)).toBe(true);
    rows = [{ refreshed_at: daysAgo(2) }, { refreshed_at: daysAgo(8) }];
    expect(await presetRefreshDue(now)).toBe(true);
  });

  it('is not due when everything was refreshed within the week', async () => {
    rows = [{ refreshed_at: daysAgo(1) }, { refreshed_at: daysAgo(6) }];
    expect(await presetRefreshDue(now)).toBe(false);
  });

  it('a scheduler tick skips the refresh when not due', async () => {
    rows = [{ refreshed_at: daysAgo(1), slug: 'x', data: {}, source: 'curated' }];
    expect(await runScheduledPresetRefresh(now)).toBe('skipped');
    expect(mockCompareLeg).not.toHaveBeenCalled();
  });
});

describe('isSameHotel', () => {
  it('matches the same hotel across naming variations', () => {
    expect(isSameHotel('Hotel Gracery Shinjuku', 'Hotel Gracery Shinjuku Tokyo')).toBe(true);
    expect(isSameHotel('Sofitel Winter Palace Luxor', 'Sofitel Winter Palace Luxor')).toBe(true);
    expect(isSameHotel('Hôtel Le Marais', 'hotel le marais')).toBe(true);
  });

  it('never pairs a hotel with an unrelated one that shares letters or generic words', () => {
    expect(isSameHotel('H', 'Some Other Hotel')).toBe(false);
    expect(isSameHotel('Hotel Arts Barcelona', 'Arts Hotel Porto')).toBe(false);
    expect(isSameHotel('The Hotel', 'The Grand Hotel')).toBe(false); // nothing distinctive
  });
});
