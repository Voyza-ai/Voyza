/**
 * Facts about one leg that let a traveller compare a train with a flight on
 * more than price: door-to-door time and CO₂. Pure and offline — airport
 * positions come from OurAirports (generated/airportCoords.json), city
 * centres from the location artifact, both via location/hub.ts.
 *
 * Everything here that is not a provider's number is labelled an estimate
 * where it is shown, and every constant says where it comes from.
 */
import { airportCoords, hubFor } from './location/hub';
import { haversineKm } from './location/geo';

// ─── Door to door ────────────────────────────────────────────────

/**
 * Time at the departure airport before the flight leaves: bag drop or
 * check-in, security, walking to the gate and boarding. 90 minutes is the
 * short end of what European carriers advise for short-haul (most say 90 to
 * 120 minutes before departure), so a flight is never made to look slower
 * than the airlines themselves say it is.
 */
export const DEPARTURE_AIRPORT_MINUTES = 90;

/**
 * Airport ↔ city centre transfer, from the straight-line distance between
 * the airport (OurAirports) and the city centre (location artifact). The
 * SAME estimate the day schedule draws for "Arrive at the airport → first
 * stop" (frontend/lib/geoSchedule.ts `estimateHubTravel`): routes run ~30%
 * longer than the straight line, ~40 km/h door to door by airport train or
 * taxi, plus 15 minutes to get out of (or into) the terminal. Rounded up to
 * 5 minutes.
 */
const TRANSFER_DETOUR = 1.3;
const TRANSFER_KMH = 40;
const TRANSFER_TERMINAL_MIN = 15;

export function airportTransferMinutes(km: number): number {
  const m = TRANSFER_TERMINAL_MIN + ((km * TRANSFER_DETOUR) / TRANSFER_KMH) * 60;
  return Math.max(5, Math.ceil(m / 5) * 5);
}

export type DoorToDoorPart = {
  kind: 'transfer' | 'airport' | 'flight' | 'train';
  /** What the traveller is doing, e.g. "City centre → MUC". */
  label: string;
  minutes: number;
};

export type DoorToDoor = {
  totalMinutes: number;
  /** "city centre to city centre" — what the total spans. */
  basis: string;
  parts: DoorToDoorPart[];
};

type CityRef = { city: string; country?: string };

function cityCentre(c: CityRef): { lat: number; lon: number } | null {
  const hub = hubFor({ city: c.city, country: c.country, mode: 'train' });
  return hub ? { lat: hub.lat, lon: hub.lng } : null;
}

/**
 * A flight's door-to-door time: city centre → departure airport, time at
 * the departure airport, the flight, arrival airport → city centre. Null
 * when the flight's length or either end's position is unknown — no total
 * is better than one built on a guess.
 */
export function flightDoorToDoor(input: {
  from: CityRef;
  to: CityRef;
  originAirport?: string | null;
  destinationAirport?: string | null;
  flightMinutes: number | null | undefined;
}): DoorToDoor | null {
  const fm = input.flightMinutes;
  if (typeof fm !== 'number' || !Number.isFinite(fm) || fm <= 0) return null;
  const dep = input.originAirport?.trim().toUpperCase();
  const arr = input.destinationAirport?.trim().toUpperCase();
  if (!dep || !arr) return null;
  const depAt = airportCoords(dep);
  const arrAt = airportCoords(arr);
  const fromC = cityCentre(input.from);
  const toC = cityCentre(input.to);
  if (!depAt || !arrAt || !fromC || !toC) return null;

  const toAirport = airportTransferMinutes(haversineKm(fromC, { lat: depAt.lat, lon: depAt.lng }));
  const fromAirport = airportTransferMinutes(haversineKm({ lat: arrAt.lat, lon: arrAt.lng }, toC));
  const parts: DoorToDoorPart[] = [
    { kind: 'transfer', label: `City centre → ${dep}`, minutes: toAirport },
    { kind: 'airport', label: 'Check-in, security & boarding', minutes: DEPARTURE_AIRPORT_MINUTES },
    { kind: 'flight', label: 'Flight', minutes: Math.round(fm) },
    { kind: 'transfer', label: `${arr} → city centre`, minutes: fromAirport },
  ];
  return {
    totalMinutes: parts.reduce((s, p) => s + p.minutes, 0),
    basis: 'city centre to city centre',
    parts,
  };
}

/**
 * A train's door-to-door time is its own journey time: the main stations
 * the rail providers route between are in the city centre (the same
 * assumption location/hub.ts makes), so nothing is added.
 */
export function trainDoorToDoor(trainMinutes: number | null | undefined): DoorToDoor | null {
  if (typeof trainMinutes !== 'number' || !Number.isFinite(trainMinutes) || trainMinutes <= 0) return null;
  const m = Math.round(trainMinutes);
  return {
    totalMinutes: m,
    basis: 'city centre to city centre',
    parts: [{ kind: 'train', label: 'Train, station to station', minutes: m }],
  };
}

// ─── CO₂ ─────────────────────────────────────────────────────────

export type Co2Figure = {
  /** Kilograms for the whole party, like every price. */
  kg: number;
  /**
   * 'duffel' — the airline-itinerary estimate Duffel puts on the offer
   *            (`total_emissions_kg`, all passengers on the offer).
   * 'estimate' — ours, from distance × the factor below.
   * Both are estimates; the UI says so.
   */
  source: 'duffel' | 'estimate';
  /** For 'estimate': the rail distance the figure assumes. */
  distanceKm?: number;
  /** For 'estimate': grams CO₂e per passenger-km used. */
  gramsPerPassengerKm?: number;
};

/**
 * Rail emissions factor, grams CO₂e per passenger-km: UK DESNZ (formerly
 * BEIS) Greenhouse gas reporting conversion factors 2023, "Business travel –
 * land", National rail = 0.03546 kg CO₂e/passenger.km. It is an average
 * over a mixed diesel/electric network, so for the electrified long-distance
 * lines in Germany, Austria and Switzerland it overstates — the safe
 * direction: a train is never made to look cleaner than the factor allows.
 */
export const RAIL_G_CO2E_PER_PKM = 35.46;

/**
 * Rail lines are longer than the straight line between city centres:
 * Berlin–Hamburg is 255 km straight and ~286 km by rail (×1.12),
 * Munich–Berlin ~505 km straight and ~600 km via Erfurt (×1.19). 1.2 sits at
 * the top of that range, again erring towards more train CO₂, not less.
 */
export const RAIL_DETOUR = 1.2;

export function trainCo2(from: CityRef, to: CityRef, travelers: number): Co2Figure | null {
  const a = cityCentre(from);
  const b = cityCentre(to);
  if (!a || !b) return null;
  const straight = haversineKm(a, b);
  if (!Number.isFinite(straight) || straight <= 0) return null;
  const distanceKm = Math.round(straight * RAIL_DETOUR);
  const party = Math.max(1, Math.floor(travelers) || 1);
  const kg = Math.round(((distanceKm * RAIL_G_CO2E_PER_PKM) / 1000) * party * 10) / 10;
  return { kg, source: 'estimate', distanceKm, gramsPerPassengerKm: RAIL_G_CO2E_PER_PKM };
}

/**
 * Duffel's `total_emissions_kg` from a raw offer — a decimal string covering
 * every passenger on the offer, which is the party (we ask for one adult
 * per traveller). Null when absent or not a positive number.
 */
export function flightCo2FromOffer(raw: unknown): Co2Figure | null {
  const v = (raw as { total_emissions_kg?: unknown } | null | undefined)?.total_emissions_kg;
  const kg = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(kg) || kg <= 0) return null;
  return { kg, source: 'duffel' };
}
