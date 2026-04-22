/**
 * Reconstruct the frontend Trip shape from its DB rows (trips + cities + transports).
 *
 * Background: the DB stores cities and transports in separate tables (one
 * city per row, one transport per row linking two cities). The frontend
 * expects each city to have its own `transportIn` and `transportOut`
 * embedded. Historically both GET /api/trips/:id and the canvas session
 * endpoint each implemented their own version of this reassembly, and the
 * two drifted apart (e.g. neither read the new hotels[] / alternatives
 * columns, silently dropping them).
 *
 * Centralizing it here so every read path returns the same Trip shape.
 */

type DbTrip = any;
type DbCity = any;
type DbTransport = any;

const emptyTransport = {
  mode: 'flight' as const,
  operator: '',
  duration: '',
  price: 0,
};

function formatDuration(minutes: number | null | undefined): string {
  if (!minutes || minutes < 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function buildTransport(t: DbTransport, fromName: string, toName: string) {
  return {
    mode: (t.mode ?? 'flight') as 'flight' | 'train',
    operator: t.operator ?? '',
    duration: formatDuration(t.duration_minutes ?? t.journey_time_minutes),
    price: Number(t.price ?? 0),
    from: fromName,
    to: toName,
    departTime: t.depart_time ?? undefined,
    arriveTime: t.arrive_time ?? undefined,
    departDate: t.depart_date ?? undefined,
    layovers: t.layovers ?? undefined,
    stops: t.stops ?? undefined,
    currency: t.currency ?? 'USD',
    carrierCode: t.carrier_code ?? undefined,
    flightNumber: t.flight_number ?? undefined,
    alternatives: Array.isArray(t.alternatives) ? t.alternatives : undefined,
    bookingUrl: t.booking_url ?? undefined,
  };
}

/**
 * Build a complete frontend Trip object from DB rows.
 * Caller is responsible for access control — this just reshapes data.
 */
export function buildTripFromDb(
  trip: DbTrip,
  cities: DbCity[],
  transports: DbTransport[],
): any {
  // Build cities in position order with empty transport defaults.
  const orderedCities = [...(cities ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );

  const frontendCities = orderedCities.map((c: DbCity) => {
    // Reconstruct hotels array. Prefer the new `hotels` column (full ranked
    // list). Fall back to wrapping the legacy single `hotel` JSONB if hotels
    // is empty, so trips saved before the migration still render.
    const hotelsArr: any[] = Array.isArray(c.hotels) && c.hotels.length > 0
      ? c.hotels
      : (c.hotel ? [c.hotel] : []);
    const selectedIdx = typeof c.selected_hotel_index === 'number'
      ? Math.max(0, Math.min(c.selected_hotel_index, Math.max(0, hotelsArr.length - 1)))
      : 0;

    return {
      name: c.name,
      country: c.country ?? '',
      dates: {
        arrival: c.arrival_date ?? '',
        departure: c.departure_date ?? '',
      },
      hotel: hotelsArr[selectedIdx] ?? c.hotel ?? { name: '', rating: 0, pricePerNight: 0, area: '' },
      hotels: hotelsArr,
      selectedHotelIndex: selectedIdx,
      customHotel: c.custom_hotel ?? undefined,
      activities: Array.isArray(c.activities) ? c.activities : [],
      restaurants: Array.isArray(c.restaurants) ? c.restaurants : [],
      schedule: c.schedule ?? {},
      vibes: Array.isArray(c.vibes) ? c.vibes : [],
      colorIndex: c.color_index ?? 0,
      transportIn: { ...emptyTransport },
      transportOut: { ...emptyTransport },
      _dbId: c.id, // internal: used to wire transports back onto cities
    };
  });

  // Index cities by their DB id so we can wire transports back onto them.
  const cityByDbId = new Map<string, any>();
  frontendCities.forEach((c) => cityByDbId.set(c._dbId, c));

  for (const t of transports ?? []) {
    const fromCity = cityByDbId.get(t.from_city_id);
    const toCity = cityByDbId.get(t.to_city_id);
    if (!fromCity || !toCity) continue;
    const transport = buildTransport(t, fromCity.name, toCity.name);
    fromCity.transportOut = transport;
    toCity.transportIn = transport;
  }

  // Strip the internal _dbId before sending to client.
  for (const c of frontendCities) delete c._dbId;

  return {
    id: trip.id,
    title: trip.title,
    status: trip.status ?? 'active',
    totalCost: Number(trip.total_cost ?? 0),
    savings: Number(trip.savings_vs_alternative ?? 0),
    travelers: trip.travelers ?? 1,
    budget: trip.budget != null ? Number(trip.budget) : undefined,
    budgetPerPerson: trip.budget_per_person ?? undefined,
    vibe: trip.vibe ?? undefined,
    startDate: trip.start_date ?? undefined,
    dateShiftSuggestion: trip.date_shift_suggestion ?? undefined,
    cities: frontendCities,
    savingsTips: [],
    createdAt: trip.created_at ?? undefined,
    ownerId: trip.user_id ?? undefined,
  };
}
