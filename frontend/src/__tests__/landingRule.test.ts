/**
 * The first stay starts the day the outbound LANDS — on the client, for the
 * one change that needs no search: picking another of the outbound's listed
 * alternatives.
 *
 * Owner's trip: JFK 19:25 Jan 10 → Paris 12:10 Jan 11 gives Paris Jan 11–13.
 * Swapping that flight for a same-day one used to leave Paris on Jan 11 (a
 * night in Paris nobody paid for, header "Jan 10 – Jan 17" over a schedule
 * with a blank Jan 10), and the reverse kept a hotel night the traveller
 * spends on the plane.
 *
 * `firstStayArrival` must agree with the backend's rule (services/optimizer.ts
 * firstStayArrival, behind /home-legs' firstCityArrival). The first block is
 * the backend's own cases (backend/src/tests/homeLegsLandingDate.test.ts),
 * stated here so a drift on either side fails a test.
 */
import { firstStayArrival, outboundSearchDates } from '@/lib/tripSpan';
import { useTripStore } from '@/store/tripStore';
import { buildCity, buildTrip } from './fixtures';
import type { HomeLeg, Trip } from '@/lib/types';

describe('firstStayArrival — the backend rule', () => {
  it('starts the first stay the day an overnight outbound lands', () => {
    expect(firstStayArrival({ startDate: '2030-11-29', firstDeparture: '2030-12-02', landed: '2030-11-30' })).toBe('2030-11-30');
  });
  it('a same-day outbound keeps the start date', () => {
    expect(firstStayArrival({ startDate: '2030-11-22', firstDeparture: '2030-11-25', landed: '2030-11-22' })).toBe('2030-11-22');
  });
  it('keeps the first city at least one night', () => {
    expect(firstStayArrival({ startDate: '2030-11-29', firstDeparture: '2030-11-30', landed: '2030-11-30' })).toBe('2030-11-29');
    expect(firstStayArrival({ startDate: '2030-11-29', firstDeparture: '2030-12-01', landed: '2030-12-03' })).toBe('2030-11-30');
  });
  it('a landing that reads earlier than the start (westbound) keeps the start', () => {
    expect(firstStayArrival({ startDate: '2030-11-29', firstDeparture: '2030-12-02', landed: '2030-11-28' })).toBe('2030-11-29');
  });
  it('no landing date keeps the start date', () => {
    expect(firstStayArrival({ startDate: '2030-11-29', firstDeparture: '2030-12-02', landed: undefined })).toBe('2030-11-29');
  });
});

const leg = (over: Partial<HomeLeg>): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'PAR',
  price: 1337.4,
  currency: 'USD',
  durationMinutes: 645,
  operator: 'Icelandair',
  carrierCode: 'FI',
  departTime: '19:25',
  arriveTime: '12:10',
  departDate: '2027-01-10',
  arriveDate: '2027-01-11',
  stops: 1,
  bookingUrl: null,
  ...over,
});
const OVERNIGHT = leg({});
const SAME_DAY = leg({ operator: 'Delta', departTime: '07:15', arriveTime: '20:40', arriveDate: '2027-01-10', price: 1500 });

function ownerTrip(main: HomeLeg, alt: HomeLeg, parisArrival: string): Trip {
  return buildTrip({
    travelers: 6,
    cities: [
      buildCity({ name: 'Paris', dates: { arrival: parisArrival, departure: '2027-01-13' } }),
      buildCity({ name: 'Zurich', dates: { arrival: '2027-01-13', departure: '2027-01-15' } }),
      buildCity({ name: 'London', dates: { arrival: '2027-01-15', departure: '2027-01-17' } }),
    ],
    origin: { city: 'New York', airports: ['JFK'], outboundLeg: { ...main, alternatives: [alt] }, returnLeg: null },
  });
}

describe('setHomeLegAlternative — the first stay follows the chosen flight', () => {
  beforeEach(() => useTripStore.setState({ currentTrip: null }));

  it('overnight → same-day: Paris gains the Jan 10 night back', () => {
    useTripStore.setState({ currentTrip: ownerTrip(OVERNIGHT, SAME_DAY, '2027-01-11') });
    useTripStore.getState().setHomeLegAlternative('outbound', 0);
    const t = useTripStore.getState().currentTrip!;
    expect(t.origin?.outboundLeg?.operator).toBe('Delta');
    expect(t.cities[0].dates).toEqual({ arrival: '2027-01-10', departure: '2027-01-13' });
    // Nothing else moves.
    expect(t.cities[1].dates).toEqual({ arrival: '2027-01-13', departure: '2027-01-15' });
  });

  it('same-day → overnight: Paris starts the day the flight lands', () => {
    useTripStore.setState({ currentTrip: ownerTrip(SAME_DAY, OVERNIGHT, '2027-01-10') });
    useTripStore.getState().setHomeLegAlternative('outbound', 0);
    const t = useTripStore.getState().currentTrip!;
    expect(t.origin?.outboundLeg?.operator).toBe('Icelandair');
    expect(t.cities[0].dates).toEqual({ arrival: '2027-01-11', departure: '2027-01-13' });
  });

  it('an alternative landing the same day as the current flight changes no date', () => {
    const other = leg({ operator: 'Air France', departTime: '18:00', arriveTime: '07:30' });
    const before = ownerTrip(OVERNIGHT, other, '2027-01-11');
    useTripStore.setState({ currentTrip: before });
    useTripStore.getState().setHomeLegAlternative('outbound', 0);
    expect(useTripStore.getState().currentTrip!.cities).toBe(before.cities);
  });

  it('a return alternative never moves the first stay', () => {
    const trip = ownerTrip(OVERNIGHT, SAME_DAY, '2027-01-11');
    trip.origin!.returnLeg = { ...leg({ departDate: '2027-01-17', arriveDate: '2027-01-17' }), alternatives: [leg({ departDate: '2027-01-17', arriveDate: '2027-01-17', operator: 'BA' })] };
    useTripStore.setState({ currentTrip: trip });
    useTripStore.getState().setHomeLegAlternative('return', 0);
    expect(useTripStore.getState().currentTrip!.cities[0].dates.arrival).toBe('2027-01-11');
  });
});

describe('outboundSearchDates — what an outbound re-search sends', () => {
  it('searches from the trip start (the overnight departure day), not the landing day', () => {
    expect(outboundSearchDates(ownerTrip(OVERNIGHT, SAME_DAY, '2027-01-11'))).toEqual({
      startDate: '2027-01-10',
      firstCityDeparture: '2027-01-13',
    });
  });
});
