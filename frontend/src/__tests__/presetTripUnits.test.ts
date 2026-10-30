import {
  PRESET_ITINERARIES,
  buildPresetTrip,
  presetCostFor,
  presetRooms,
} from '@/data/presetItineraries';
import { liveTripTotal } from '@/lib/tripTotals';

/**
 * A saved preset must cost what /browse quoted for the same party (audit A2).
 * Presets store transport PER PERSON and hotels PER ROOM; a Trip holds party
 * totals. Before the conversion in buildPresetTrip the saved trip's header
 * was 0.90× the quote at 2 travelers, 0.45× at 4 and 0.30× at 6.
 */
describe('buildPresetTrip prices the whole party (A2)', () => {
  const PARTIES = [1, 2, 3, 4, 5, 6];

  it('saved-trip total equals the /browse quote for every bundled preset and party size', () => {
    for (const p of PRESET_ITINERARIES) {
      for (const t of PARTIES) {
        expect({ slug: p.slug, t, total: liveTripTotal(buildPresetTrip(p, t)) }).toEqual({
          slug: p.slug,
          t,
          total: presetCostFor(p, t),
        });
      }
    }
  });

  it('inter-city transport (and any alternatives) is the party fare: per-person × travelers', () => {
    const p = PRESET_ITINERARIES.find((x) => x.cities.filter((c) => c.transportOut).length >= 2)!;
    const withAlt = {
      ...p,
      cities: p.cities.map((c, i) =>
        i === 0 && c.transportOut
          ? { ...c, transportOut: { ...c.transportOut, alternatives: [{ ...c.transportOut, price: 50 }] } }
          : c,
      ),
    };
    const trip = buildPresetTrip(withAlt, 4);
    trip.cities.forEach((c, i) => {
      const stored = withAlt.cities[i].transportOut;
      if (stored) expect(c.transportOut.price).toBe(stored.price * 4);
      const prev = withAlt.cities[i - 1]?.transportOut;
      if (prev) expect(c.transportIn.price).toBe(prev.price * 4);
    });
    expect(trip.cities[0].transportOut.alternatives?.[0].price).toBe(200);
  });

  it('a hotel night is the bill for ceil(travelers/2) rooms, with no multiplier left for tripTotals', () => {
    const p = PRESET_ITINERARIES[0];
    for (const t of PARTIES) {
      const trip = buildPresetTrip(p, t);
      trip.cities.forEach((c, i) => {
        expect(c.hotel.pricePerNight).toBe(p.cities[i].hotel.pricePerNight * presetRooms(t));
        expect(c.hotels[c.selectedHotelIndex].pricePerNight).toBe(c.hotel.pricePerNight);
        // No per-room capacity on the row: the price already covers every room,
        // so nothing downstream may multiply it again.
        expect(c.hotel.maxGuests).toBeUndefined();
      });
    }
  });

  it('does not mutate the catalog it was built from', () => {
    const p = PRESET_ITINERARIES[0];
    const before = JSON.stringify(p);
    buildPresetTrip(p, 6);
    expect(JSON.stringify(p)).toBe(before);
  });
});
