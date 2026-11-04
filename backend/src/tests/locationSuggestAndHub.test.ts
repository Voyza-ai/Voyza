/**
 * Settings type-ahead (GET /api/locations/suggest) and the schedule's
 * arrival / departure hubs (GET /api/locations/hub). Both are offline — built
 * from the generated location artifact and airportCoords.json.
 */
import express from 'express';
import request from 'supertest';

import locations from '../routes/locations';
import { errorHandler } from '../middleware/error';
import { suggestAirports, suggestCities } from '../services/location/suggest';
import { hubFor } from '../services/location/hub';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/locations', locations);
  app.use(errorHandler);
  return app;
}

describe('suggestCities', () => {
  it('puts the big city first for a prefix', () => {
    expect(suggestCities('new y')[0]).toMatchObject({ name: 'New York City', country: 'US' });
    expect(suggestCities('par')[0].label).toBe('Paris, France');
    expect(suggestCities('lon')[0].label).toBe('London, United Kingdom');
  });

  it('folds accents and caps the list', () => {
    expect(suggestCities('sao p')[0].name).toBe('São Paulo');
    expect(suggestCities('san').length).toBeLessThanOrEqual(6);
    expect(suggestCities('   ')).toEqual([]);
  });
});

describe('suggestAirports', () => {
  it('an exact code comes first', () => {
    expect(suggestAirports('jfk')[0]).toMatchObject({ iata: 'JFK', city: 'New York City' });
    expect(suggestAirports('LAX')[0].iata).toBe('LAX');
  });

  it('finds airports by any word of their name, or by their city', () => {
    expect(suggestAirports('heath')[0].iata).toBe('LHR');
    expect(suggestAirports('newark')[0].iata).toBe('EWR');
    expect(suggestAirports('new york').slice(0, 3).map((a) => a.iata).sort()).toEqual(['EWR', 'JFK', 'LGA']);
    expect(suggestAirports('san fr')[0].iata).toBe('SFO');
    expect(suggestAirports('par').slice(0, 2).map((a) => a.iata).sort()).toEqual(['CDG', 'ORY']);
  });

  it('names an airport after the big city it serves, not a suburb', () => {
    expect(suggestAirports('sfo')[0].label).toBe('SFO · San Francisco Intl.');
    expect(suggestAirports('cdg')[0].city).toBe('Paris');
  });
});

describe('hubFor', () => {
  it("a flight's own airport code wins", () => {
    expect(hubFor({ city: 'Paris', mode: 'flight', code: 'ORY' })).toMatchObject({ kind: 'airport', code: 'ORY', approximate: false });
  });

  it("otherwise the city's primary airport, even for an ambiguous name", () => {
    const rome = hubFor({ city: 'Rome', mode: 'flight' });
    expect(rome).toMatchObject({ kind: 'airport', code: 'FCO' });
    expect(rome!.lat).toBeCloseTo(41.80, 1);
    expect(rome!.lng).toBeCloseTo(12.25, 1);
    expect(hubFor({ city: 'Paris', mode: 'flight' })?.code).toBe('CDG');
  });

  it('a train arrives at the city centre, marked approximate', () => {
    const f = hubFor({ city: 'Florence', mode: 'train' });
    expect(f).toMatchObject({ kind: 'station', approximate: true });
    expect(f!.lat).toBeCloseTo(43.78, 1);
  });

  it('an unknown city has no hub', () => {
    expect(hubFor({ city: 'Qqqzzx', mode: 'flight' })).toBeNull();
  });
});

describe('routes', () => {
  const app = makeApp();

  it('GET /suggest', async () => {
    const res = await request(app).get('/api/locations/suggest').query({ kind: 'airport', q: 'jfk' });
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0].iata).toBe('JFK');
    expect((await request(app).get('/api/locations/suggest').query({ kind: 'nope', q: 'x' })).status).toBe(400);
  });

  it('GET /hub', async () => {
    const res = await request(app).get('/api/locations/hub').query({ city: 'Rome', country: 'Italy', mode: 'flight' });
    expect(res.status).toBe(200);
    expect(res.body.hub.code).toBe('FCO');
    expect((await request(app).get('/api/locations/hub').query({ city: 'Rome' })).status).toBe(400);
  });
});
