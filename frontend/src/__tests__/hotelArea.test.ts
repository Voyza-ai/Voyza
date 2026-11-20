import { cleanAreaName, pickArea } from '@/lib/hotelArea';
import { hotelFromResult } from '@/lib/hotelShape';

/**
 * The neighbourhood on the hotel card. The values below are the real answers
 * measured for hotels in London, Paris, Rome, Lisbon, Porto, Ljubljana and
 * Kraków (2026-11-19); the rules keep the names a traveller would know and
 * refuse the administrative labels.
 */

describe('cleanAreaName', () => {
  it('keeps the names travellers know', () => {
    for (const n of ['Spitalfields', 'Bloomsbury', "Earl's Court", 'Monti', 'Prati', 'Kazimierz', 'Massarelos', 'Trnovo']) {
      expect(cleanAreaName(n, 'Anywhere')).toBe(n);
    }
  });

  it('refuses administrative labels', () => {
    for (const n of [
      '16th Arrondissement',
      'Municipio Roma I',
      'Westminster Borough',
      'Historic Centre of Porto',
      'Historic Zone of Porto',
      'Conjunto Urbano da Ribeira',
      'União de Freguesias do Centro',
      'Cedofeita, Santo Ildefonso, Sé, Miragaia, São Nicolau e Vitória',
    ]) {
      expect(cleanAreaName(n, 'Porto')).toBeNull();
    }
  });

  it('strips the wrapper off a real name', () => {
    expect(cleanAreaName('Quartier des Épinettes', 'Paris')).toBe('Épinettes');
    expect(cleanAreaName('Quartier de la Sorbonne', 'Paris')).toBe('Sorbonne');
    expect(cleanAreaName('Četrtna skupnost Trnovo', 'Ljubljana')).toBe('Trnovo');
  });

  it('refuses the city’s own name, whatever its accents or case', () => {
    expect(cleanAreaName('Paris', 'Paris')).toBeNull();
    expect(cleanAreaName('krakow', 'Kraków')).toBeNull();
  });

  it('refuses blanks and non-strings', () => {
    expect(cleanAreaName('', 'London')).toBeNull();
    expect(cleanAreaName(undefined, 'London')).toBeNull();
    expect(cleanAreaName(42, 'London')).toBeNull();
  });
});

describe('pickArea', () => {
  it('London: Nominatim quarter wins over its finer, obscurer names', () => {
    expect(
      pickArea({ nominatim: { quarter: 'Spitalfields', suburb: 'Whitechapel', neighbourhood: 'Banglatown' } }, 'London'),
    ).toBe('Spitalfields');
  });

  it('falls to suburb when there is no quarter', () => {
    expect(pickArea({ nominatim: { suburb: 'Bloomsbury', neighbourhood: 'St Giles' } }, 'London')).toBe('Bloomsbury');
  });

  it('Paris: Nominatim gives only the arrondissement, so Photon’s quartier is used', () => {
    expect(
      pickArea({ nominatim: { suburb: '17th Arrondissement' }, photon: { locality: 'Quartier des Épinettes', district: 'Paris' } }, 'Paris'),
    ).toBe('Épinettes');
  });

  it('Ljubljana: the district wrapper is stripped off Nominatim’s suburb', () => {
    expect(pickArea({ nominatim: { suburb: 'Četrtna skupnost Trnovo' } }, 'Ljubljana')).toBe('Trnovo');
  });

  it('Photon’s district when nothing before it is usable', () => {
    expect(pickArea({ nominatim: { suburb: 'Ljubljana' }, photon: { district: 'Šiška' } }, 'Ljubljana')).toBe('Šiška');
  });

  it('Booking’s district is the last resort, and only when it is a real name', () => {
    expect(pickArea({ nominatim: {}, photon: {}, bookingDistrict: 'Camden' }, 'London')).toBe('Camden');
    expect(pickArea({ nominatim: {}, photon: {}, bookingDistrict: 'Westminster Borough' }, 'London')).toBeNull();
  });

  it('nothing usable anywhere: no area, rather than a wrong one', () => {
    expect(pickArea({ nominatim: { suburb: 'Historic Centre of Porto' }, photon: { district: 'Porto' } }, 'Porto')).toBeNull();
  });
});

describe('hotelFromResult carries Booking’s district and address', () => {
  const r: any = { id: '1', name: 'hub', rating: 8, pricePerNight: 90, price: 270, currency: 'USD', reviewCount: 1, stars: 3, thumbnail: '', bookingUrl: '', amenities: [] };
  it('when Booking has them', () => {
    const h = hotelFromResult({ ...r, district: 'Tower Hamlets', address: '86 Brick Lane' });
    expect(h.district).toBe('Tower Hamlets');
    expect(h.address).toBe('86 Brick Lane');
    // Not in `area`, which the flowchart card and the Map tab show.
    expect(h.area).toBe('');
  });
  it('and leaves them off when it does not', () => {
    const h = hotelFromResult(r);
    expect(h.district).toBeUndefined();
    expect(h.address).toBeUndefined();
  });
});
