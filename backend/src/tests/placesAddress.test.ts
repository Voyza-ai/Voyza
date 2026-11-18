/**
 * POI providers return a street address with the coordinates, for the
 * reservation card's "Address" (services/dinner.ts withRestaurantAddress).
 */
import { googlePlacesProvider, nominatimProvider, osmAddress } from '../services/places/providers';

const jsonRes = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;

it('Google asks for formattedAddress and returns it', async () => {
  const fetchImpl = jest.fn(async (_u: any, init: any) => {
    expect(init.headers['X-Goog-FieldMask']).toContain('places.formattedAddress');
    return jsonRes({ places: [{ id: 'abc', displayName: { text: 'Septime' }, location: { latitude: 48.85, longitude: 2.38 }, types: ['restaurant'], formattedAddress: '80 Rue de Charonne, 75011 Paris, France' }] });
  });
  const hit = await googlePlacesProvider('k', fetchImpl as any).search('Septime Paris', null);
  expect(hit).toMatchObject({ placeId: 'google:abc', address: '80 Rue de Charonne, 75011 Paris, France' });
});

it('OpenStreetMap: a short address from the parts, not the whole display_name', async () => {
  const row = {
    lat: '48.8566', lon: '2.3797', osm_id: 1, osm_type: 'node', category: 'amenity', name: 'Septime',
    display_name: 'Septime, 80, Rue de Charonne, Quartier Sainte-Marguerite, Paris 11e Arrondissement, Paris, Ile-de-France, Metropolitan France, 75011, France',
    address: { house_number: '80', road: 'Rue de Charonne', postcode: '75011', city: 'Paris' },
  };
  const fetchImpl = jest.fn(async (url: any) => {
    expect(String(url)).toContain('addressdetails=1');
    return jsonRes([row]);
  });
  const hit = await nominatimProvider({ fetchImpl: fetchImpl as any, throttle: { run: (f: any) => f() } as any }).search('Septime Paris', null);
  expect(hit?.address).toBe('80 Rue de Charonne, 75011 Paris');
  expect(osmAddress({ address: { postcode: '75011', city: 'Paris' } })).toBeNull();
});
