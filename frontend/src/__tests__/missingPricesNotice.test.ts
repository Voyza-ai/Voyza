import { missingPriceParts } from '@/components/results/MissingPricesNotice';

/**
 * Website audit (2026-11-13): a destination nothing flies to (Tristan da
 * Cunha) came back as a normal-looking result with "TOTAL TRIP $0" and no word
 * of explanation. The notice names what the search could not price.
 */
describe('missing prices notice (M2)', () => {
  const city = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, hotel: { name: 'H' }, hotels: [{ name: 'H' }], ...extra }) as any;

  it('names the home flights and hotel a no-route trip could not price', () => {
    expect(
      missingPriceParts({
        cities: [city('Tristan da Cunha', { hotel: { name: '' }, hotels: [] })],
        origin: { city: 'New York', airports: ['JFK'], outboundLeg: null, returnLeg: null },
        returnToHome: true,
      } as any),
    ).toEqual([
      'flights from New York to Tristan da Cunha',
      'flights from Tristan da Cunha back to New York',
      'a hotel in Tristan da Cunha',
    ]);
  });

  it('says nothing for a fully priced trip, and skips the return on a one-way trip', () => {
    const leg = { price: 100 } as any;
    expect(
      missingPriceParts({
        cities: [city('Rome')],
        origin: { city: 'New York', airports: ['JFK'], outboundLeg: leg, returnLeg: leg },
        returnToHome: true,
      } as any),
    ).toEqual([]);
    expect(
      missingPriceParts({
        cities: [city('Rome')],
        origin: { city: 'New York', airports: ['JFK'], outboundLeg: leg, returnLeg: null },
        returnToHome: false,
      } as any),
    ).toEqual([]);
  });

  it('names an inter-city leg nothing was found for', () => {
    expect(
      missingPriceParts({
        cities: [city('Lisbon', { transportOut: { unavailable: true } }), city('Sintra')],
      } as any),
    ).toEqual(['a way from Lisbon to Sintra']);
  });

  it('a hop with no sensible flight is "a sensible flight", not "a way" (it has a train-or-bus estimate)', () => {
    expect(
      missingPriceParts({
        cities: [
          city('Prague', { transportOut: { unavailable: true, noSensibleFlight: { fastestMinutes: 1370, stops: 2, groundHours: [4, 5] } } }),
          city('Vienna'),
        ],
      } as any),
    ).toEqual(['a sensible flight from Prague to Vienna']);
  });

  it('two cities without a hotel read as "London or Paris", not one place', () => {
    expect(missingPriceParts({ cities: [city('London', { hotel: { name: '' }, hotels: [] }), city('Paris', { hotel: { name: '' }, hotels: [] })] } as any)).toEqual([
      'a hotel in London or Paris',
    ]);
  });
});
