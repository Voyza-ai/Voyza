jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * ROADMAP bug: hotel `pricePerNight` could report the wrong basis when the
 * room occupancy Booking priced differs from the adults we asked for.
 *
 * The row shapes below are copied from a real Booking search (Rome, 3 nights,
 * 2026-11-04): `min_total_price` is the stay total and
 * `composite_price_breakdown.gross_amount_per_night` is a third of it.
 */

import { stayTotalFromRow, occupancyShortfall } from '../services/hotels';

const row = (total: number, perNight: number, blocks: string[] = ['27320623_185640551_3_2_0']) => ({
  hotel_id: 273206,
  hotel_name: 'Hotel Infinity San Pietro',
  min_total_price: total,
  currency_code: 'EUR',
  block_ids: blocks,
  composite_price_breakdown: {
    gross_amount: { value: total, currency: 'EUR' },
    gross_amount_per_night: { value: perNight, currency: 'EUR' },
  },
});

describe('stayTotalFromRow', () => {
  it('keeps a real stay total (the normal Booking row)', () => {
    expect(stayTotalFromRow(row(666.37, 222.1233), 3, 'EUR')).toBeCloseTo(666.37, 2);
  });

  it('rebuilds the total when the row quoted one night as the stay total', () => {
    // pricePerNight = total / nights; without this it would read 74.04, not 222.12.
    expect(stayTotalFromRow(row(222.12, 222.12), 3, 'EUR')).toBeCloseTo(666.36, 2);
  });

  it('falls back to the composite stay total when min_total_price is missing', () => {
    const r: any = row(666.37, 222.1233);
    delete r.min_total_price;
    expect(stayTotalFromRow(r, 3, 'EUR')).toBeCloseTo(666.37, 2);
  });

  it('does not second-guess a one-night stay or a different-currency per-night field', () => {
    expect(stayTotalFromRow(row(222.12, 222.12), 1, 'EUR')).toBeCloseTo(222.12, 2);
    const r: any = row(222.12, 222.12);
    r.composite_price_breakdown.gross_amount_per_night.currency = 'USD';
    expect(stayTotalFromRow(r, 3, 'EUR')).toBeCloseTo(222.12, 2);
  });

  it('returns 0 for a row with no price at all', () => {
    expect(stayTotalFromRow({}, 3)).toBe(0);
  });
});

describe('occupancyShortfall', () => {
  it('is false when the priced blocks sleep the party (real 3-adult rows)', () => {
    expect(occupancyShortfall(row(1, 1, ['27320623_185640551_3_2_0']), 3)).toBe(false);
    expect(occupancyShortfall(row(1, 1, ['27320601_185640551_2_2_0', '27320601_185640551_1_2_0']), 3)).toBe(false);
  });

  it('is true when the priced blocks sleep fewer guests than asked', () => {
    expect(occupancyShortfall(row(1, 1, ['27320601_185640551_2_2_0']), 3)).toBe(true);
  });

  it('cannot judge a block that does not state its guests', () => {
    expect(occupancyShortfall(row(1, 1, ['4470603_93697888_0_1_0']), 3)).toBe(false);
    expect(occupancyShortfall({}, 3)).toBe(false);
  });
});
