/**
 * reorder_cities on the results page: the card's total is exactly what
 * Accept gives, the order changes, and a leg with no sensible flight is
 * flagged on the card (backend services/cityEdit.ts, services/routeGeo.ts).
 */
import './mocks';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { useTripStore } from '@/store/tripStore';
import { planChat } from '@/lib/api';
import { applyCityEdit, cityEditDiff } from '@/lib/cityEdit';
import { liveTripTotal } from '@/lib/tripTotals';
import type { Trip } from '@/lib/types';
import tripJson from './chatTripNycParisLondon.json';

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;
const trip = (): Trip => JSON.parse(JSON.stringify(tripJson));

const opt = (operator: string, price: number, extra: any = {}) => ({
  mode: 'flight', operator, price, currency: 'USD', departTime: '09:00', arriveTime: '10:20', duration: '1h 20m', durationMinutes: 80, priceDelta: 0, ...extra,
});

/** Paris (Jan 12–15) → London (Jan 15–17) as London (Jan 12–14) → Paris (Jan 14–17), priced. */
function swapProposal(t: Trip, flag = false): any {
  const ret = { ...t.origin!.returnLeg!, originAirport: 'PAR', departTime: '13:00', arriveTime: '15:30', price: 470 };
  const out = { ...t.origin!.outboundLeg!, destAirport: 'LON', price: 455 };
  return {
    kind: 'city_edit',
    toolName: 'reorder_cities',
    op: { kind: 'reorder', order: ['London', 'Paris'] },
    before: t.cities.map((c) => ({ name: c.name, arrival: c.dates.arrival, departure: c.dates.departure })),
    after: [
      { name: 'London', arrival: '2027-01-12', departure: '2027-01-14', status: 'moved' },
      { name: 'Paris', arrival: '2027-01-14', departure: '2027-01-17', status: 'moved' },
    ],
    removed: [],
    legs: [{
      index: 0, from: 'London', to: 'Paris', date: '2027-01-14',
      options: [flag ? opt('LOT', 174, { departTime: '10:25', arriveTime: '08:55', duration: '22h 30m', durationMinutes: 1350, stops: 2 }) : opt('Air France', 95)],
      ...(flag ? { flag: { fastestMinutes: 1350, stops: 2, groundHours: [4, 6] } } : {}),
    }],
    outboundLeg: out,
    returnLeg: ret,
    note: 'New order: London (2 nights) → Paris (3 nights).',
  };
}

describe('reorder_cities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTripStore.setState({ currentTrip: trip(), tripPicks: null, priceMode: 'total' });
  });

  it('applying it gives exactly the card\'s total, in the new order', () => {
    const t = trip();
    const p = swapProposal(t);
    const diff = cityEditDiff(t, p);
    const next = applyCityEdit(t, p);
    expect(next.cities.map((c) => c.name)).toEqual(['London', 'Paris']);
    expect(next.cities.map((c) => [c.dates.arrival, c.dates.departure])).toEqual([['2027-01-12', '2027-01-14'], ['2027-01-14', '2027-01-17']]);
    expect(next.cities[0].transportOut).toMatchObject({ operator: 'Air France', price: 95 });
    expect(next.origin!.returnLeg).toMatchObject({ originAirport: 'PAR', price: 470 });
    expect(liveTripTotal(next)).toBe(diff.after);
  });

  it('the card is titled "Reorder cities", flags a leg with no sensible flight, and Accept moves the header by exactly its total', async () => {
    const t = useTripStore.getState().currentTrip!;
    const p = swapProposal(t, true);
    mockedPlanChat.mockResolvedValueOnce({ type: 'proposal', reply: 'Here’s your trip as London → Paris.', proposal: p } as any);
    render(<AIChatPanel trip={t} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'swap London and Paris' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText('Reorder cities')).toBeInTheDocument();
    expect(screen.getByTestId('leg-flag')).toHaveTextContent('22h 30m, 2 stops — no sensible flight · ground ≈ 4–6h (estimate)');
    const shown = cityEditDiff(t, p).after;
    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });
    const after = useTripStore.getState().currentTrip!;
    expect(after.cities.map((c) => c.name)).toEqual(['London', 'Paris']);
    expect(liveTripTotal(after)).toBe(shown);
  });
});
