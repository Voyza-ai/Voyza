/**
 * In-app booking checkout: the passenger form is shaped by the offer, the
 * fare-rules checkbox gates payment, a price change from the server stops
 * and re-asks, and a successful card payment ends with the booking reference.
 * The Stripe card fields are replaced by stub buttons (they are iframes).
 */
import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import BookingModal from '@/components/booking/BookingModal';
import PassengerForm, { emptyPassenger, fareAges, validatePassengerForm } from '@/components/booking/PassengerForm';
import { ApiError, confirmBooking, getBookingQuote, startBookingPayment, type BookingQuote } from '@/lib/api';
import { mockTransportFlight } from './fixtures';

jest.mock('@/components/booking/CardPaymentForm', () => {
  // Stands in for the Stripe card fields (iframes): same props, two buttons.
  return function MockCardPaymentForm(props: any) {
    return (
      <div data-testid="card-form" data-token={props.clientToken}>
        <button onClick={() => props.onPaid()}>Mock card pay</button>
        <button onClick={() => props.onFailed('Your card was declined.')}>Mock card decline</button>
      </div>
    );
  };
});

const mQuote = getBookingQuote as jest.MockedFunction<typeof getBookingQuote>;
const mStart = startBookingPayment as jest.MockedFunction<typeof startBookingPayment>;
const mConfirm = confirmBooking as jest.MockedFunction<typeof confirmBooking>;

function quote(over: Partial<BookingQuote> = {}): BookingQuote {
  return {
    offerId: 'off_1',
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    liveMode: false,
    totalAmount: '226.15',
    totalCurrency: 'USD',
    baseAmount: '191.65',
    taxAmount: '34.50',
    match: 'exact',
    priceChange: null,
    airline: { name: 'British Airways', iataCode: 'BA', conditionsOfCarriageUrl: 'https://ba.example/coc', logoUrl: null },
    slices: [
      {
        origin: 'FCO',
        originName: 'Rome',
        destination: 'BCN',
        destinationName: 'Barcelona',
        departingAt: '2026-06-20T09:15:00',
        arrivingAt: '2026-06-20T11:30:00',
        duration: 'PT2H15M',
        fareBrandName: 'Basic',
        segments: [
          {
            flightNumber: 'BA1516',
            carrier: 'British Airways',
            origin: 'FCO',
            destination: 'BCN',
            departingAt: '2026-06-20T09:15:00',
            arrivingAt: '2026-06-20T11:30:00',
            aircraft: null,
            cabinClass: 'Economy',
            baggages: [],
          },
        ],
      },
    ],
    passengers: [{ id: 'pas_1', type: 'adult', age: null }],
    requirements: { identityDocumentsRequired: false, supportedDocumentTypes: ['passport'], requiresInstantPayment: true },
    conditions: {
      refundBeforeDeparture: { allowed: false, penaltyAmount: null, penaltyCurrency: null },
      changeBeforeDeparture: { allowed: true, penaltyAmount: '40.00', penaltyCurrency: 'USD' },
    },
    ...over,
  };
}

const renderModal = () =>
  render(<BookingModal transport={mockTransportFlight} date="2026-06-20" travelers={1} tripId={null} onClose={jest.fn()} />);

async function fillTraveller() {
  fireEvent.change(screen.getByLabelText('Title (optional)'), { target: { value: 'ms' } });
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Testa' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Booker' } });
  fireEvent.change(screen.getByLabelText('Date of birth month'), { target: { value: '4' } });
  fireEvent.change(screen.getByLabelText('Date of birth day'), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('Date of birth year'), { target: { value: '1990' } });
  fireEvent.change(screen.getByLabelText('Gender (as on passport)'), { target: { value: 'f' } });
  fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+14155550123' } });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PassengerForm', () => {
  it('shows passport fields only when the airline requires identity documents', () => {
    const base = quote();
    const { rerender } = render(
      <PassengerForm quote={base} passengers={[emptyPassenger(false)]} contact={{ email: '', phone_number: '' }} errors={{}} onChange={jest.fn()} />,
    );
    expect(screen.queryByLabelText('Passport number')).not.toBeInTheDocument();
    const docs = quote({ requirements: { ...base.requirements, identityDocumentsRequired: true } });
    rerender(
      <PassengerForm quote={docs} passengers={[emptyPassenger(true)]} contact={{ email: '', phone_number: '' }} errors={{}} onChange={jest.fn()} />,
    );
    expect(screen.getByLabelText('Passport number')).toBeInTheDocument();
    expect(screen.getByLabelText('Passport expiry')).toBeInTheDocument();
  });

  it('renders one block per passenger on the fare', () => {
    const q = quote({ passengers: [{ id: 'a', type: 'adult', age: null }, { id: 'b', type: 'adult', age: null }] });
    render(
      <PassengerForm quote={q} passengers={[emptyPassenger(false), emptyPassenger(false)]} contact={{ email: '', phone_number: '' }} errors={{}} onChange={jest.fn()} />,
    );
    expect(screen.getByText('Traveller 1')).toBeInTheDocument();
    expect(screen.getByText('Traveller 2')).toBeInTheDocument();
  });

  it('validatePassengerForm: adult age, passport expiry vs travel dates, phone format', () => {
    const q = quote({ requirements: { identityDocumentsRequired: true, supportedDocumentTypes: ['passport'], requiresInstantPayment: true } });
    const errs = validatePassengerForm(
      q,
      [{ title: 'ms', given_name: 'Testa', family_name: 'Booker', gender: 'f', born_on: '2012-01-01', passport: { number: 'X1234567', issuing_country_code: 'US', expires_on: '2026-06-01' } }],
      { email: 'a@b.co', phone_number: '415 555' },
    );
    expect(errs['passengers.0.born_on']).toMatch(/18 or over/);
    expect(errs['passengers.0.passport.expires_on']).toMatch(/beyond the travel dates/);
    expect(errs['contact.phone_number']).toBeDefined();
    expect(errs['contact.email']).toBeUndefined();
  });
});

describe('BookingModal checkout', () => {
  it('quote → travellers → fare rules (checkbox gates payment) → card → booking reference', async () => {
    mQuote.mockResolvedValue({ quote: quote({ priceChange: { previous: 223.52, current: 226.15, currency: 'USD', difference: 2.63 } }) });
    mStart.mockResolvedValue({ paymentIntentId: 'pit_1', clientToken: 'ct_1', amount: '226.15', currency: 'USD', liveMode: false });
    mConfirm.mockResolvedValue({
      orderId: 'ord_1', bookingReference: 'XYZ789', status: 'confirmed', totalAmount: '226.15', totalCurrency: 'USD',
      liveMode: false, emailSent: true, emailTo: 'test@test.com', persisted: true,
    });
    renderModal();

    // Fresh quote requested for this exact leg, with the card's price for comparison.
    await screen.findByTestId('booking-total');
    expect(mQuote).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'Rome', destination: 'Barcelona', date: '2026-06-20', operator: 'Ryanair', departTime: '09:15', previousPrice: 89,
    }));
    expect(screen.getByText(/price went up since this trip was planned: \$223\.52 → \$226\.15/)).toBeInTheDocument();
    expect(screen.getByText('TEST MODE')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Empty form is stopped client-side.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('First name as on the passport (Latin letters).')).toBeInTheDocument();
    expect(screen.queryByText('Choose a title.')).not.toBeInTheDocument(); // title is optional
    expect(screen.getByLabelText('Email')).toHaveValue('test@test.com'); // prefilled from the account
    await fillTraveller();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Fare rules + airline T&Cs, payment disabled until accepted.
    expect(screen.getByText('Refund before departure: not allowed')).toBeInTheDocument();
    expect(screen.getByText('Change before departure: allowed, fee $40.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /British Airways conditions of carriage/ })).toHaveAttribute('href', 'https://ba.example/coc');
    const pay = screen.getByRole('button', { name: /Continue to payment/ });
    expect(pay).toBeDisabled();
    fireEvent.click(pay);
    expect(mStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(pay).toBeEnabled();
    fireEvent.click(pay);

    await screen.findByTestId('card-form');
    expect(mStart).toHaveBeenCalledWith(expect.objectContaining({
      offerId: 'off_1', expectedAmount: '226.15', expectedCurrency: 'USD', termsAccepted: true,
      passengers: [expect.objectContaining({ given_name: 'Testa', family_name: 'Booker', born_on: '1990-04-12', passport: null })],
      contact: { email: 'test@test.com', phone_number: '+14155550123' },
    }));
    expect(screen.getByTestId('card-form')).toHaveAttribute('data-token', 'ct_1');

    fireEvent.click(screen.getByText('Mock card pay'));
    expect(await screen.findByTestId('booking-reference')).toHaveTextContent('XYZ789');
    expect(mConfirm).toHaveBeenCalledWith('pit_1');
    expect(screen.getByText(/Confirmation and itinerary sent to test@test.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View itinerary/ })).toBeInTheDocument();
  });

  it('a server-side price change stops before payment, shows the new price and requires re-accepting', async () => {
    mQuote.mockResolvedValue({ quote: quote() });
    const newQuote = quote({ totalAmount: '240.00' });
    mStart.mockRejectedValueOnce(new (ApiError as any)(409, 'The price changed', { reason: 'price_changed', quote: newQuote }));
    renderModal();
    await screen.findByTestId('booking-total');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await fillTraveller();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Continue to payment/ }));

    expect(await screen.findByText(/airline changed the price: \$226\.15 → \$240\.00/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Continue to payment · \$240\.00/ })).toBeDisabled();
    expect(screen.queryByTestId('card-form')).not.toBeInTheDocument();
  });

  it('a failed order after payment shows the server message and returns to fare rules', async () => {
    mQuote.mockResolvedValue({ quote: quote() });
    mStart.mockResolvedValue({ paymentIntentId: 'pit_1', clientToken: 'ct_1', amount: '226.15', currency: 'USD', liveMode: false });
    mConfirm.mockRejectedValue(new (ApiError as any)(502, 'The airline could not confirm this booking. Your payment has been refunded.'));
    renderModal();
    await screen.findByTestId('booking-total');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await fillTraveller();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Continue to payment/ }));
    fireEvent.click(await screen.findByText('Mock card pay'));

    const alert = await screen.findByText(/Your payment has been refunded/);
    expect(alert).toBeInTheDocument();
    expect(screen.queryByTestId('booking-reference')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('a declined card keeps the user on the payment step with the reason', async () => {
    mQuote.mockResolvedValue({ quote: quote() });
    mStart.mockResolvedValue({ paymentIntentId: 'pit_1', clientToken: 'ct_1', amount: '226.15', currency: 'USD', liveMode: false });
    renderModal();
    await screen.findByTestId('booking-total');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await fillTraveller();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Continue to payment/ }));
    fireEvent.click(await screen.findByText('Mock card decline'));
    expect(await screen.findByText('Your card was declined.')).toBeInTheDocument();
    expect(screen.getByTestId('card-form')).toBeInTheDocument();
    expect(mConfirm).not.toHaveBeenCalled();
  });

  it('says so when the exact flight is gone and a different one is quoted', async () => {
    mQuote.mockResolvedValue({ quote: quote({ match: 'cheapest' }) });
    renderModal();
    expect(await screen.findByText(/no longer on sale — this is the cheapest available/)).toBeInTheDocument();
    void within;
    await waitFor(() => expect(mQuote).toHaveBeenCalledTimes(1));
  });
});

describe('family bookings: only traveller 1 must be an adult', () => {
  const pax = (born_on: string, title: '' | 'ms' = '') => ({
    title,
    given_name: 'Kid',
    family_name: 'Booker',
    gender: 'f' as const,
    born_on,
    passport: null,
  });
  const three = () =>
    quote({
      passengers: [
        { id: 'a', type: 'adult', age: null },
        { id: 'b', type: 'adult', age: null },
        { id: 'c', type: 'adult', age: null },
      ],
    });
  const contact = { email: 'mum@b.co', phone_number: '+14155550123' };

  it('a mum and two kids pass; title can be left empty', () => {
    const errs = validatePassengerForm(three(), [pax('1985-03-01'), pax('2016-05-05'), pax('2020-09-09')], contact);
    expect(errs).toEqual({});
  });

  it('traveller 1 under 18 is refused', () => {
    const errs = validatePassengerForm(three(), [pax('2012-01-01'), pax('1985-03-01'), pax('1985-03-01')], contact);
    expect(errs['passengers.0.born_on']).toMatch(/first traveller must be 18 or over/);
    expect(errs['passengers.1.born_on']).toBeUndefined();
  });

  it('fareAges: children by age on the travel date, adults null, traveller 1 always adult', () => {
    // Travel 2026-06-20: born 2016-05-05 → 10; born 2008-06-21 → 17 (birthday the day after).
    expect(fareAges(three(), [pax('1985-03-01'), pax('2016-05-05'), pax('2008-06-21')])).toEqual([null, 10, 17]);
    expect(fareAges(three(), [pax('1985-03-01'), pax('1990-01-01'), pax('2008-06-20')])).toEqual([null, null, null]);
  });

  it('Continue re-prices the fare with the children’s ages and shows the new price', async () => {
    mQuote.mockResolvedValueOnce({ quote: quote({ passengers: [{ id: 'a', type: 'adult', age: null }, { id: 'b', type: 'adult', age: null }] }) });
    mQuote.mockResolvedValueOnce({
      quote: quote({ totalAmount: '180.00', passengers: [{ id: 'a', type: 'adult', age: null }, { id: 'b', type: 'child', age: 7 }] }),
    });
    render(<BookingModal transport={mockTransportFlight} date="2026-06-20" travelers={2} tripId={null} onClose={jest.fn()} />);
    await screen.findByTestId('booking-total');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const set = (label: string, i: number, value: string) =>
      fireEvent.change(screen.getAllByLabelText(label)[i], { target: { value } });
    for (const [i, name, y] of [[0, 'Mum', '1985'], [1, 'Kid', '2019']] as const) {
      set('First name', i, name);
      set('Last name', i, 'Booker');
      set('Date of birth month', i, '1');
      set('Date of birth day', i, '15');
      set('Date of birth year', i, y);
      set('Gender (as on passport)', i, 'f');
    }
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+14155550123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Priced with 1 child fare: \$226\.15 → \$180\.00/)).toBeInTheDocument();
    expect(mQuote).toHaveBeenLastCalledWith(expect.objectContaining({ travelers: 2, ages: [null, 7] }));
    expect(await screen.findByRole('checkbox')).toBeInTheDocument(); // on to fare rules
    expect(screen.getByText(/child/)).toBeInTheDocument();
  });
});
