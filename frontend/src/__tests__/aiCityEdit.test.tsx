import './mocks';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AIChatPanel from '@/components/results/AIChatPanel';
import { buildTrip } from './fixtures';
import { useTripStore } from '@/store/tripStore';
import { planChat, searchActivities } from '@/lib/api';
import { applyCityEdit, cityEditDiff } from '@/lib/cityEdit';
import { liveTripTotal } from '@/lib/tripTotals';
import type { CityEditProposal, HotelResult, LegOption } from '@/lib/api';
import type { HomeLeg, Trip } from '@/lib/types';

/**
 * AI chat city edits (add_city / remove_city / replace_city): the backend's
 * priced proposal → a diff card → Accept applies it, Reject changes nothing.
 */

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;

const hotel = (name: string, ppn: number): HotelResult =>
  ({ id: name, name, price: ppn * 2, pricePerNight: ppn, currency: 'USD', rating: 8.6, reviewCount: 400, stars: 4, thumbnail: '', bookingUrl: 'https://b.test', amenities: [] }) as any;
const opt = (price: number, mode: 'flight' | 'train' = 'train', operator = 'Italo'): LegOption => ({
  mode, operator, price, currency: 'USD', departTime: '09:00', arriveTime: '11:00', duration: '2h', durationMinutes: 120, priceDelta: 0,
});
const home = (dest: string, date: string, price: number): HomeLeg => ({
  originAirport: 'JFK', destAirport: dest, price, currency: 'USD', durationMinutes: 500, operator: 'Delta', carrierCode: 'DL',
  departTime: '18:00', arriveTime: '08:00', departDate: date, stops: 0, bookingUrl: null,
});

/** Rome (Jun 15–18) → Florence (Jun 18–20), from New York and back. */
function trip(): Trip {
  const t = buildTrip({ title: 'Rome → Florence' });
  t.cities[0].colorIndex = 0;
  t.cities[1].colorIndex = 1;
  t.origin = { city: 'New York', airports: ['JFK'], outboundLeg: home('FCO', '2026-06-14', 800), returnLeg: home('FLR', '2026-06-20', 700) } as any;
  t.returnToHome = true;
  return t;
}

const addVenice = (): CityEditProposal => ({
  kind: 'city_edit',
  toolName: 'add_city',
  op: { kind: 'add', city: 'Venice', afterCity: null, nights: null },
  before: [
    { name: 'Rome', arrival: '2026-06-15', departure: '2026-06-18' },
    { name: 'Florence', arrival: '2026-06-18', departure: '2026-06-20' },
  ],
  after: [
    { name: 'Rome', arrival: '2026-06-15', departure: '2026-06-18', status: 'kept' },
    { name: 'Florence', arrival: '2026-06-18', departure: '2026-06-20', status: 'kept' },
    { name: 'Venice', arrival: '2026-06-20', departure: '2026-06-22', status: 'added', hotels: [hotel('Ca Venezia', 150), hotel('Lido Inn', 110)] },
  ],
  removed: [],
  legs: [{ index: 1, from: 'Florence', to: 'Venice', date: '2026-06-20', options: [opt(40), opt(95, 'flight', 'ITA')] }],
  returnLeg: home('VCE', '2026-06-22', 650),
  note: 'Venice adds 2 nights at the end, so you fly home 2 days later.',
});

const removeRome = (): CityEditProposal => ({
  kind: 'city_edit',
  toolName: 'remove_city',
  op: { kind: 'remove', city: 'Rome' },
  before: addVenice().before,
  after: [{ name: 'Florence', arrival: '2026-06-15', departure: '2026-06-20', status: 'moved', hotels: [hotel('Hotel Firenze', 80), hotel('Arno Rooms', 70)] }],
  removed: ['Rome'],
  legs: [],
  outboundLeg: home('FLR', '2026-06-14', 900),
  note: "Florence keeps Rome's 3 nights, so your trip dates don't change.",
});

const replaceFlorence = (): CityEditProposal => ({
  kind: 'city_edit',
  toolName: 'replace_city',
  op: { kind: 'replace', oldCity: 'Florence', newCity: 'Bologna' },
  before: addVenice().before,
  after: [
    { name: 'Rome', arrival: '2026-06-15', departure: '2026-06-18', status: 'kept' },
    { name: 'Bologna', arrival: '2026-06-18', departure: '2026-06-20', status: 'replaced', replaces: 'Florence', hotels: [hotel('Bologna Centrale', 100)] },
  ],
  removed: ['Florence'],
  legs: [{ index: 0, from: 'Rome', to: 'Bologna', date: '2026-06-18', options: [opt(30)] }],
  returnLeg: home('BLQ', '2026-06-20', 720),
  note: "Bologna takes Florence's dates, so nothing else moves.",
});

describe('applyCityEdit', () => {
  it('add: keeps untouched cities as they are and adds the new one with its hotel, leg and return', () => {
    const t = trip();
    const next = applyCityEdit(t, addVenice());
    expect(next.cities.map((c) => c.name)).toEqual(['Rome', 'Florence', 'Venice']);
    expect(next.cities[0]).toEqual(t.cities[0]);
    const venice = next.cities[2];
    expect(venice.hotel.name).toBe('Ca Venezia');
    expect(venice.hotels).toHaveLength(2);
    expect(venice.dates).toEqual({ arrival: '2026-06-20', departure: '2026-06-22' });
    expect(venice.country).toBe('Italy');
    expect(venice.colorIndex).toBe(2);
    expect(venice.activities).toEqual([]);
    expect(next.cities[1].transportOut).toMatchObject({ mode: 'train', operator: 'Italo', price: 40, from: 'Florence', to: 'Venice', departDate: '2026-06-20' });
    expect(next.cities[1].transportOut.alternatives).toHaveLength(1);
    expect(venice.transportIn).toMatchObject({ price: 40, from: 'Florence' });
    expect(venice.transportIn.alternatives).toBeUndefined();
    expect(next.origin?.returnLeg?.destAirport).toBe('VCE');
    expect(next.origin?.outboundLeg?.destAirport).toBe('FCO');
    expect(next.title).toBe('Rome → Florence → Venice');
    // The routing saving described the old city list.
    expect(next.savings).toBe(0);
    expect(next.totalCost).toBe(liveTripTotal(next));
  });

  it('remove: the absorbing city gets the dates and its re-searched hotels, keeping the pick by name', () => {
    const t = trip();
    t.cities[1].hotels = [{ name: 'Arno Rooms', rating: 4, pricePerNight: 75, area: '' }, { name: 'Hotel Firenze', rating: 4.2, pricePerNight: 80, area: '' }];
    t.cities[1].selectedHotelIndex = 0;
    const next = applyCityEdit(t, removeRome());
    expect(next.cities.map((c) => c.name)).toEqual(['Florence']);
    expect(next.cities[0].dates).toEqual({ arrival: '2026-06-15', departure: '2026-06-20' });
    expect(next.cities[0].hotels[next.cities[0].selectedHotelIndex].name).toBe('Arno Rooms');
    expect(next.cities[0].activities).toEqual(['Uffizi Gallery']);
    // The first city no longer arrives from Rome.
    expect(next.cities[0].transportIn.from).toBe('');
    expect(next.origin?.outboundLeg?.destAirport).toBe('FLR');
    expect(next.origin?.returnLeg?.destAirport).toBe('FLR');
  });

  it('replace: the new city takes the old dates, the priced leg and the new return', () => {
    const t = trip();
    const next = applyCityEdit(t, replaceFlorence());
    expect(next.cities.map((c) => c.name)).toEqual(['Rome', 'Bologna']);
    expect(next.cities[1].dates).toEqual(t.cities[1].dates);
    expect(next.cities[0].transportOut).toMatchObject({ to: 'Bologna', price: 30 });
    expect(next.cities[1].transportIn).toMatchObject({ from: 'Rome', price: 30 });
    expect(next.cities[1].transportOut.to).toBe('');
    expect(next.origin?.returnLeg?.destAirport).toBe('BLQ');
  });

  it('a leg with no options becomes the "no option found" card, not a $0 leg', () => {
    const p = replaceFlorence();
    p.legs[0].options = [];
    const next = applyCityEdit(trip(), p);
    expect(next.cities[0].transportOut).toMatchObject({ unavailable: true, price: 0 });
  });

  it('gives a new city its own colour and keeps the others\' colours (trip without colour slots)', () => {
    const t = trip();
    delete t.cities[0].colorIndex;
    delete t.cities[1].colorIndex;
    const p = addVenice();
    p.after = [p.after[0], p.after[2], p.after[1]];
    p.after[1] = { ...p.after[1], arrival: '2026-06-18', departure: '2026-06-20' };
    p.after[2] = { ...p.after[2], status: 'moved', arrival: '2026-06-20', departure: '2026-06-22' };
    p.legs = [];
    const next = applyCityEdit(t, p);
    expect(next.cities.map((c) => [c.name, c.colorIndex])).toEqual([['Rome', 0], ['Venice', 2], ['Florence', 1]]);
  });

  it('keeps a custom title', () => {
    const t = trip();
    t.title = 'Honeymoon';
    expect(applyCityEdit(t, addVenice()).title).toBe('Honeymoon');
  });
});

describe('cityEditDiff', () => {
  it('lists each city and the removed one where it was', () => {
    const d = cityEditDiff(trip(), removeRome());
    expect(d.rows.map((r) => [r.kind, r.name])).toEqual([
      ['removed', 'Rome'],
      ['moved', 'Florence'],
    ]);
    expect(d.before).toBe(liveTripTotal(trip()));
    expect(d.after).toBe(d.preview.totalCost);
  });
});

describe('AIChatPanel — city edit card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTripStore.setState({ currentTrip: trip(), tripPicks: null, priceMode: 'total' });
  });

  async function propose(p: CityEditProposal) {
    mockedPlanChat.mockResolvedValueOnce({ type: 'proposal', reply: 'Here is your trip with Venice added at the end.', proposal: p });
    render(<AIChatPanel trip={useTripStore.getState().currentTrip!} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'add Venice' } });
    fireEvent.submit(input.closest('form')!);
    return screen.findByTestId('city-edit-card');
  }

  it('shows the diff with the new city, its hotel, the new leg and the total', async () => {
    const card = await propose(addVenice());
    expect(within(card).getByText('Add a city')).toBeInTheDocument();
    expect(within(card).getByText('Venice')).toBeInTheDocument();
    expect(within(card).getByText('New')).toBeInTheDocument();
    expect(within(card).getByText(/Ca Venezia · \$150\/night/)).toBeInTheDocument();
    expect(within(card).getByText('Florence → Venice')).toBeInTheDocument();
    const before = liveTripTotal(trip());
    const after = applyCityEdit(trip(), addVenice()).totalCost;
    expect(within(card).getByTestId('city-edit-total').textContent).toContain(`$${Math.round(before).toLocaleString()}`);
    expect(within(card).getByTestId('city-edit-total').textContent).toContain(`$${Math.round(after).toLocaleString()}`);
  });

  it('Accept puts the edited trip in the store and asks for the new city\'s picks', async () => {
    const card = await propose(addVenice());
    fireEvent.click(within(card).getByText('Accept'));
    const t = useTripStore.getState().currentTrip!;
    expect(t.cities.map((c) => c.name)).toEqual(['Rome', 'Florence', 'Venice']);
    expect(within(card).getByText('✓ Applied to your trip')).toBeInTheDocument();
    expect(useTripStore.getState().tripPicks?.pending.map((r) => r.city)).toEqual(['Venice']);
    await waitFor(() => expect(searchActivities).toHaveBeenCalledWith(expect.objectContaining({ city: 'Venice', nights: 2 })));
  });

  it('Reject leaves the trip exactly as it was', async () => {
    const before = useTripStore.getState().currentTrip;
    const card = await propose(replaceFlorence());
    expect(within(card).getByText('Instead of Florence')).toBeInTheDocument();
    fireEvent.click(within(card).getByText('Reject'));
    expect(useTripStore.getState().currentTrip).toBe(before);
    expect(within(card).getByText(/Dismissed — your trip is unchanged/)).toBeInTheDocument();
    expect(within(card).queryByText('Accept')).not.toBeInTheDocument();
  });

  it('tells the model what happened to the proposal on the next turn', async () => {
    const card = await propose(replaceFlorence());
    fireEvent.click(within(card).getByText('Reject'));
    mockedPlanChat.mockResolvedValueOnce({ type: 'answer', reply: 'ok' });
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'replace Florence with Qwxz' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('ok');
    const history = mockedPlanChat.mock.calls[1][0].history!;
    const proposalTurn = history.find((h) => h.content.includes('Here is your trip with Venice'));
    expect(proposalTurn?.role).toBe('assistant');
    expect(proposalTurn?.content).toContain('The user REJECTED this change; the trip is unchanged.');
  });

  it('remove shows the removed city struck through and its nights going to the next', async () => {
    const card = await propose(removeRome());
    expect(within(card).getByTestId('diff-row-removed')).toHaveTextContent('Rome');
    expect(within(card).getByTestId('diff-row-moved')).toHaveTextContent('Florence');
    fireEvent.click(within(card).getByText('Accept'));
    expect(useTripStore.getState().currentTrip!.cities.map((c) => c.name)).toEqual(['Florence']);
  });

  it('on the canvas, Accept goes to the host and asks for no picks', async () => {
    const onTripUpdate = jest.fn();
    mockedPlanChat.mockResolvedValueOnce({ type: 'proposal', reply: 'x', proposal: addVenice() });
    const t = trip();
    render(<AIChatPanel trip={t} onTripUpdate={onTripUpdate} getLatestTrip={() => t} />);
    const input = screen.getByPlaceholderText('Ask about your trip...');
    fireEvent.change(input, { target: { value: 'add Venice' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.click(within(await screen.findByTestId('city-edit-card')).getByText('Accept'));
    expect(onTripUpdate).toHaveBeenCalledTimes(1);
    expect(onTripUpdate.mock.calls[0][0].cities.map((c: any) => c.name)).toEqual(['Rome', 'Florence', 'Venice']);
    expect(useTripStore.getState().tripPicks).toBeNull();
  });
});

