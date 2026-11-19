/**
 * orderLegOptions — the order a leg card's options come in (legOptions.ts).
 *
 * Production, 2026-11-17: the optimizer priced Vienna → Munich on the 4h03m
 * ÖBB train ($56), but the card showed a $364 Austrian flight. The options
 * list judged "long" across both modes: against a 1h flight the limit was
 * 4h00m, so the train sorted behind four flights, fell off the top 4, and
 * options[0] — what a new plan's card shows — was a flight. The leg also got
 * a "no train data" note, since no train was left in the list.
 */
// orderLegOptions is pure; these keep legOptions' imports from needing env or network.
jest.mock('../services/flights', () => ({ searchFlights: jest.fn(), getIataCode: jest.fn() }));
jest.mock('../services/trains', () => ({ searchTrains: jest.fn() }));

import { orderLegOptions, type LegOption } from '../services/legOptions';

const opt = (mode: 'flight' | 'train', price: number, durationMinutes: number, operator: string = mode): LegOption => ({
  mode,
  operator,
  price,
  currency: 'USD',
  departTime: '10:00',
  arriveTime: '12:00',
  duration: `${durationMinutes}m`,
  durationMinutes,
  priceDelta: 0,
});

describe('orderLegOptions', () => {
  it('Vienna → Munich: the 4h03m $56 train leads four 1h $364 flights', () => {
    const flights = [0, 1, 2, 3, 4].map(() => opt('flight', 363.59, 60, 'Austrian'));
    const train = opt('train', 56.05, 243, 'ÖBB');
    const out = orderLegOptions([...flights, train], 4);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(train);
  });

  it('still buries a 22h 50m connecting flight behind the 55m nonstop', () => {
    const nonstop = opt('flight', 368, 55, 'Austrian');
    const overnight = opt('flight', 301, 22 * 60 + 50, 'Duffel Airways');
    const out = orderLegOptions([overnight, nonstop], 4);
    expect(out.map((o) => o.operator)).toEqual(['Austrian', 'Duffel Airways']);
  });

  it('a train is never long, even next to a much faster flight', () => {
    const flight = opt('flight', 120, 60);
    const slowTrain = opt('train', 90, 9 * 60);
    expect(orderLegOptions([flight, slowTrain], 4)[0]).toBe(slowTrain);
  });

  it('keeps the best train on the card when four cheaper flights would fill it', () => {
    const flights = [80, 85, 90, 95, 99].map((p) => opt('flight', p, 75));
    const trains = [opt('train', 150, 200, 'Eurostar'), opt('train', 140, 230, 'SNCF')];
    const out = orderLegOptions([...flights, ...trains], 4);
    expect(out).toHaveLength(4);
    expect(out.slice(0, 3).map((o) => o.price)).toEqual([80, 85, 90]);
    expect(out[3].operator).toBe('SNCF'); // the cheaper train
  });

  it('keeps the best flight on the card when trains would fill it', () => {
    const trains = [30, 35, 40, 45].map((p) => opt('train', p, 120));
    const flight = opt('flight', 200, 60);
    const out = orderLegOptions([...trains, flight], 4);
    expect(out[3]).toBe(flight);
    expect(out.slice(0, 3).every((o) => o.mode === 'train')).toBe(true);
  });

  it('does not reserve a slot for an unpriced train (no fare is not an option to switch to)', () => {
    const flights = [80, 85, 90, 95].map((p) => opt('flight', p, 75));
    const unpriced = opt('train', 0, 200);
    const out = orderLegOptions([...flights, unpriced], 4);
    expect(out.every((o) => o.mode === 'flight')).toBe(true);
  });

  it('respects a limit of 1 (no reserved slot) and returns fewer when there are fewer', () => {
    const flight = opt('flight', 80, 60);
    const train = opt('train', 100, 120);
    expect(orderLegOptions([flight, train], 1)).toEqual([flight]);
    expect(orderLegOptions([flight], 4)).toEqual([flight]);
    expect(orderLegOptions([], 4)).toEqual([]);
  });
});
