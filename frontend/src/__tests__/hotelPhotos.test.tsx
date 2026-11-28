import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import HotelHero from '@/components/results/HotelHero';
import { hotelFromResult, largePhoto } from '@/lib/hotelShape';
import { fetchHotelPhotos } from '@/lib/api';
import type { Hotel } from '@/lib/types';

/**
 * The city guide's photo strip: the search's one photo straight away, the
 * hotel's Booking gallery once it is in, and the strip changing with the
 * chosen hotel.
 */

const mockPhotos = fetchHotelPhotos as jest.Mock;
const img = (id: number, size = 'max1280x900') => `https://cf.bstatic.com/xdata/images/hotel/${size}/${id}.jpg?k=a`;
const accent = { bg: '#fff', text: '#8b2e1a', border: '#e8eaef' };
const hotel = (name: string, extra: Partial<Hotel> = {}): Hotel => ({
  name,
  rating: 8.3,
  pricePerNight: 92,
  area: '',
  ...extra,
});
const shown = () => screen.getAllByRole('img').map((i) => i.getAttribute('src'));

beforeEach(() => mockPhotos.mockReset().mockResolvedValue([]));

describe('largePhoto', () => {
  it('asks for the big size of the same Booking photo', () => {
    expect(largePhoto(img(1, 'square60'))).toBe(img(1, 'max1024x768'));
    expect(largePhoto(img(1, 'max500'))).toBe(img(1, 'max1024x768'));
    expect(largePhoto('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });
});

describe('hotelFromResult keeps the photo and the Booking id', () => {
  const r: any = { id: '15248006', name: 'hub', rating: 8, pricePerNight: 90, price: 270, currency: 'USD', reviewCount: 1, stars: 3, thumbnail: img(5, 'square60'), bookingUrl: '', amenities: [] };
  it('as a large photo and a numeric id', () => {
    const h = hotelFromResult(r);
    expect(h.photos).toEqual([img(5, 'max1024x768')]);
    expect(h.providerId).toBe('15248006');
  });
  it('and leaves both off when the search had none', () => {
    const h = hotelFromResult({ ...r, id: '', thumbnail: '' });
    expect(h.photos).toBeUndefined();
    expect(h.providerId).toBeUndefined();
  });
});

describe('HotelHero', () => {
  it('shows the search photo at once, then the gallery, without repeating the first', async () => {
    mockPhotos.mockResolvedValueOnce([img(5), img(6), img(7)]);
    render(<HotelHero hotel={hotel('hub', { photos: [img(5, 'max1024x768')], providerId: '11' })} total={275} perNight={92} nights={3} accent={accent} />);
    expect(shown()).toEqual([img(5, 'max1024x768')]);
    await waitFor(() => expect(shown()).toEqual([img(5, 'max1024x768'), img(6), img(7)]));
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    expect(mockPhotos).toHaveBeenCalledWith('11');
  });

  it('asks for a hotel’s gallery once, however often it is chosen', async () => {
    mockPhotos.mockResolvedValue([img(8), img(9)]);
    const h = hotel('Once', { photos: [img(8, 'max1024x768')], providerId: '22' });
    const { rerender } = render(<HotelHero hotel={h} total={1} perNight={1} nights={1} accent={accent} />);
    await waitFor(() => expect(shown()).toHaveLength(2));
    rerender(<HotelHero hotel={hotel('Other')} total={1} perNight={1} nights={1} accent={accent} />);
    rerender(<HotelHero hotel={h} total={1} perNight={1} nights={1} accent={accent} />);
    await waitFor(() => expect(screen.getAllByText('Once').length).toBeGreaterThan(0));
    expect(mockPhotos.mock.calls.filter((c) => c[0] === '22')).toHaveLength(1);
  });

  it('a hotel without a Booking id keeps its one photo and asks nobody', () => {
    render(<HotelHero hotel={hotel('Saved', { photos: [img(3, 'max1024x768')] })} total={1} perNight={1} nights={1} accent={accent} />);
    expect(shown()).toEqual([img(3, 'max1024x768')]);
    expect(mockPhotos).not.toHaveBeenCalled();
  });

  it('a photo that fails to load is dropped from the strip', async () => {
    mockPhotos.mockResolvedValueOnce([img(30), img(31)]);
    render(<HotelHero hotel={hotel('Broken', { providerId: '33' })} total={1} perNight={1} nights={1} accent={accent} />);
    await waitFor(() => expect(shown()).toHaveLength(2));
    act(() => {
      fireEvent.error(screen.getAllByRole('img')[0]);
    });
    expect(shown()).toEqual([img(31)]);
  });

  it('no photos at all: a quiet placeholder, never a broken image', () => {
    render(<HotelHero hotel={hotel('Bare')} total={1} perNight={1} nights={1} accent={accent} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('No photos for this hotel yet')).toBeInTheDocument();
  });

  it('the traveller’s own stay shows its name and total, and asks for no photos', () => {
    render(<HotelHero hotel={hotel('Booked', { providerId: '44' })} customName="Airbnb in Soho" total={600} perNight={200} nights={3} accent={accent} />);
    expect(screen.getByText('Airbnb in Soho')).toBeInTheDocument();
    expect(screen.getByText('$600')).toBeInTheDocument();
    expect(screen.queryByText('Booked')).toBeNull();
    expect(mockPhotos).not.toHaveBeenCalled();
  });
});
