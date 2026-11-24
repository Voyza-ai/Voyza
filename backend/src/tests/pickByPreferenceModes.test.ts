/**
 * The chat's city edits pick each re-searched leg with pickByPreference. A
 * long journey is judged against the fastest option of its OWN mode, as
 * compareLeg and orderLegOptions do — never a train against a flight.
 *
 * Fixture: Salzburg → Prague, 2027-03-21, 2 travellers, as searchLegOptions
 * returned it (All Aboard test gateway + Duffel test mode), with the via-Vienna
 * train at its full two-ticket fare.
 */
import { pickByPreference } from '../services/legPreference';

type Opt = { mode: 'flight' | 'train'; operator: string; departTime: string; arriveTime: string; durationMinutes: number; price: number };

const salzburgPrague: Opt[] = [
  { mode: 'train', operator: 'ÖBB', departTime: '00:13', arriveTime: '09:23', durationMinutes: 550, price: 381.99 },
  { mode: 'train', operator: 'ÖBB', departTime: '19:07', arriveTime: '03:09', durationMinutes: 482, price: 387.87 },
  { mode: 'train', operator: 'ÖBB + ZSSK', departTime: '11:11', arriveTime: '18:23', durationMinutes: 432, price: 408.17 },
  { mode: 'flight', operator: 'Eurowings', departTime: '17:50', arriveTime: '21:30', durationMinutes: 220, price: 420.4 },
  { mode: 'train', operator: 'ÖBB + České dráhy', departTime: '06:11', arriveTime: '12:12', durationMinutes: 361, price: 0 },
];

describe('pickByPreference: long journeys are judged within a mode', () => {
  it('does not call a train long next to a much faster flight', () => {
    // Across modes the 3h 40m flight set the limit at 7h 20m, both cheaper
    // trains were "long", and the $408.17 train was picked. Against the
    // fastest TRAIN (6h 01m, limit 12h 02m) all three are sensible.
    const { ordered } = pickByPreference(salzburgPrague, null, 'Salzburg → Prague', 'Mar 21');
    expect(ordered[0]).toMatchObject({ mode: 'train', price: 381.99 });
  });

  it('still buries a long flight behind a sensible one', () => {
    const flights: Opt[] = [
      { mode: 'flight', operator: 'TAP', departTime: '21:25', arriveTime: '19:55', durationMinutes: 1830, price: 300 },
      { mode: 'flight', operator: 'BA', departTime: '10:00', arriveTime: '13:00', durationMinutes: 480, price: 700 },
    ];
    const { ordered } = pickByPreference(flights, null, 'London → New York', 'Jan 17');
    expect(ordered[0].operator).toBe('BA');
  });

  it('still buries a long train behind a sensible train', () => {
    // Munich → Prague: a 39h 12m connection against the 5h 37m train.
    const trains: Opt[] = [
      { mode: 'train', operator: 'Länderbahn', departTime: '23:09', arriveTime: '14:21', durationMinutes: 2352, price: 76.6 },
      { mode: 'train', operator: 'Die Länderbahn', departTime: '08:00', arriveTime: '13:37', durationMinutes: 337, price: 120 },
    ];
    const { ordered } = pickByPreference(trains, null, 'Munich → Prague', 'Mar 19');
    expect(ordered[0].durationMinutes).toBe(337);
  });

  it('home-leg rows without a mode are judged together, as before', () => {
    const rows = [
      { operator: 'TAP', departTime: '21:25', arriveTime: '19:55', durationMinutes: 1830, price: 300 },
      { operator: 'BA', departTime: '10:00', arriveTime: '13:00', durationMinutes: 480, price: 700 },
    ];
    const { ordered } = pickByPreference(rows, null, 'your flight home', 'Jan 17');
    expect(ordered[0].operator).toBe('BA');
  });
});
