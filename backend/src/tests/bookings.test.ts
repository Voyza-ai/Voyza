/**
 * In-app booking (routes/bookings.ts + services/booking.ts): offer re-fetch
 * and price change, passenger validation driven by the offer, the T&Cs
 * gate, payment intent → order, order failure → refund, the email + PDF,
 * and the degrade-without-table persistence. Duffel, Supabase and Resend
 * are all mocked; nothing here talks to a network.
 */
jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DUFFEL_ACCESS_TOKEN: 'duffel_test_abc',
    BOOKING_LIVE_ENABLED: false,
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'BlueMurr <onboarding@resend.dev>',
    FRONTEND_URL: 'http://localhost:3000',
    API_PUBLIC_URL: 'http://localhost:4000',
  },
}));

// ── Supabase: either the table exists (writes recorded) or it is missing.
let dbMode: 'ok' | 'missing' = 'ok';
const dbCalls: Array<{ method: string; args: any[] }> = [];
function chain() {
  const c: any = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'update']) {
    c[m] = jest.fn((...args: any[]) => {
      dbCalls.push({ method: m, args });
      return c;
    });
  }
  const res = () =>
    dbMode === 'missing'
      ? { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.bookings'" } }
      : { data: [], error: null };
  c.then = (resolve: any, reject: any) => Promise.resolve(res()).then(resolve, reject);
  c.single = () => Promise.resolve({ data: { preferences: {} }, error: null });
  return c;
}
jest.mock('../services/supabase', () => ({ getSupabase: () => ({ from: () => chain() }) }));

// ── Duffel
const duffel = {
  offerRequests: { create: jest.fn() },
  offers: { get: jest.fn() },
  paymentIntents: { create: jest.fn(), confirm: jest.fn() },
  refunds: { create: jest.fn() },
  orders: { create: jest.fn(), get: jest.fn() },
};
jest.mock('../services/duffel', () => ({ getDuffel: () => duffel }));
jest.mock('../services/flights', () => ({ withRetry: (fn: any) => fn(), getIataCode: jest.fn(async (n: string) => (n === 'Paris' ? 'PAR' : 'NYC')) }));

import express from 'express';
import request from 'supertest';
import bookingsRouter from '../routes/bookings';
import { errorHandler } from '../middleware/error';
import { env } from '../config/env';
import { __resetPending, effectiveTitle, offerRequestPassengers, passengerTypeOf, pickMatchingOffer, validatePassengers } from '../services/booking';
import { __resetBookingStore } from '../services/bookingStore';

const USERS: Record<string, { id: string; email: string }> = {
  'alice-token': { id: 'alice-id', email: 'alice@test.dev' },
  'bob-token': { id: 'bob-id', email: 'bob@test.dev' },
};
function fakeAuth(req: any, res: any, next: any) {
  const u = USERS[(req.headers.authorization ?? '').replace('Bearer ', '')];
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = u;
  next();
}
const app = express();
app.use(express.json());
app.use('/api/bookings', fakeAuth, bookingsRouter);
app.use(errorHandler);
const as = (who: 'alice-token' | 'bob-token') => ({ Authorization: `Bearer ${who}` });

// ── Fixtures
const FUTURE = new Date(Date.now() + 30 * 60 * 1000).toISOString();
function offer(over: Partial<any> = {}): any {
  return {
    id: 'off_1',
    live_mode: false,
    partial: false,
    expires_at: FUTURE,
    total_amount: '226.15',
    total_currency: 'USD',
    base_amount: '191.65',
    tax_amount: '34.50',
    owner: { name: 'British Airways', iata_code: 'BA', conditions_of_carriage_url: 'https://ba.example/coc' },
    passengers: [{ id: 'pas_1', type: 'adult' }],
    passenger_identity_documents_required: false,
    supported_passenger_identity_document_types: ['passport'],
    payment_requirements: { requires_instant_payment: true },
    conditions: {
      refund_before_departure: { allowed: false, penalty_amount: null, penalty_currency: null },
      change_before_departure: { allowed: true, penalty_amount: '40.00', penalty_currency: 'USD' },
    },
    slices: [
      {
        origin: { iata_code: 'LGA', city_name: 'New York' },
        destination: { iata_code: 'CDG', city_name: 'Paris' },
        duration: 'PT8H20M',
        segments: [
          {
            departing_at: '2026-12-10T06:58:00',
            arriving_at: '2026-12-10T21:18:00',
            origin: { iata_code: 'LGA', name: 'LaGuardia' },
            destination: { iata_code: 'CDG', name: 'Charles de Gaulle' },
            marketing_carrier: { iata_code: 'BA', name: 'British Airways' },
            operating_carrier: { iata_code: 'BA', name: 'British Airways' },
            marketing_carrier_flight_number: '1516',
            passengers: [{ cabin_class: 'economy', baggages: [] }],
          },
        ],
      },
    ],
    ...over,
  };
}
const order = (over: Partial<any> = {}) => ({
  id: 'ord_ABC123',
  booking_reference: 'XYZ789',
  live_mode: false,
  created_at: '2026-11-03T02:07:00Z',
  total_amount: '226.15',
  total_currency: 'USD',
  owner: { name: 'British Airways' },
  slices: offer().slices,
  passengers: [{ title: 'ms', given_name: 'Testa', family_name: 'Booker', type: 'adult' }],
  conditions: offer().conditions,
  documents: [],
  ...over,
});
const pax = (over: Partial<any> = {}): any => ({
  title: 'ms',
  given_name: 'Testa',
  family_name: 'Booker',
  gender: 'f',
  born_on: '1990-04-12',
  ...over,
});
const CONTACT = { email: 'traveller@test.dev', phone_number: '+14155550123' };
const payBody = (over: Partial<any> = {}) => ({
  offerId: 'off_1',
  expectedAmount: '226.15',
  expectedCurrency: 'USD',
  passengers: [pax()],
  contact: CONTACT,
  termsAccepted: true,
  ...over,
});

const fetchMock = jest.fn();
beforeAll(() => {
  (global as any).fetch = fetchMock;
});
beforeEach(() => {
  jest.clearAllMocks();
  __resetPending();
  __resetBookingStore();
  dbMode = 'ok';
  dbCalls.length = 0;
  (env as any).DUFFEL_ACCESS_TOKEN = 'duffel_test_abc';
  duffel.offers.get.mockResolvedValue({ data: offer() });
  duffel.paymentIntents.create.mockResolvedValue({
    data: { id: 'pit_1', client_token: 'ct_1', live_mode: false, amount: '226.15', currency: 'USD' },
  });
  duffel.paymentIntents.confirm.mockResolvedValue({
    data: { id: 'pit_1', status: 'succeeded', amount: '226.15', currency: 'USD' },
  });
  duffel.orders.create.mockResolvedValue({ data: order() });
  duffel.orders.get.mockResolvedValue({ data: order() });
  duffel.refunds.create.mockResolvedValue({ data: { id: 'ref_1' } });
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
});

describe('safety: test token only', () => {
  it('refuses to quote on a live token unless BOOKING_LIVE_ENABLED', async () => {
    (env as any).DUFFEL_ACCESS_TOKEN = 'duffel_live_xyz';
    const res = await request(app).post('/api/bookings/quote').set(as('alice-token')).send({
      origin: 'New York', destination: 'Paris', date: '2026-12-10',
    });
    expect(res.status).toBe(503);
    expect(duffel.offerRequests.create).not.toHaveBeenCalled();
  });

  it('refuses a live-mode offer even on a test token', async () => {
    duffel.offers.get.mockResolvedValue({ data: offer({ live_mode: true }) });
    const res = await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody());
    expect(res.status).toBe(503);
    expect(duffel.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe('POST /quote — fresh offer, matched to the card, price change shown', () => {
  it('re-searches, picks the same carrier + departure, re-reads the offer and reports the change', async () => {
    const cheaperOther = offer({ id: 'off_cheap', total_amount: '150.00', owner: { name: 'Iberia', iata_code: 'IB' } });
    cheaperOther.slices = [{ ...cheaperOther.slices[0], segments: [{ ...cheaperOther.slices[0].segments[0], marketing_carrier: { iata_code: 'IB', name: 'Iberia' }, operating_carrier: { iata_code: 'IB', name: 'Iberia' } }] }];
    duffel.offerRequests.create.mockResolvedValue({ data: { offers: [cheaperOther, offer()] } });

    const res = await request(app).post('/api/bookings/quote').set(as('alice-token')).send({
      origin: 'New York', destination: 'Paris', originAirport: 'LGA', date: '2026-12-10',
      operator: 'British Airways', departTime: '06:58', previousPrice: 223.52,
    });
    expect(res.status).toBe(200);
    expect(duffel.offerRequests.create.mock.calls[0][0].slices[0]).toMatchObject({ origin: 'LGA', destination: 'PAR' });
    expect(duffel.offers.get).toHaveBeenCalledWith('off_1');
    expect(res.body.quote.match).toBe('exact');
    expect(res.body.quote.priceChange).toEqual({ previous: 223.52, current: 226.15, currency: 'USD', difference: 2.63 });
    expect(res.body.quote.airline.conditionsOfCarriageUrl).toBe('https://ba.example/coc');
    expect(res.body.quote.conditions.changeBeforeDeparture).toEqual({ allowed: true, penaltyAmount: '40.00', penaltyCurrency: 'USD' });
  });

  it('no price change when the fare is the same', async () => {
    duffel.offerRequests.create.mockResolvedValue({ data: { offers: [offer()] } });
    const res = await request(app).post('/api/bookings/quote').set(as('alice-token')).send({
      origin: 'NYC', destination: 'PAR', date: '2026-12-10', previousPrice: 226.15,
    });
    expect(res.body.quote.priceChange).toBeNull();
  });

  it('404s when the route has no bookable offers, 502 when the search fails', async () => {
    duffel.offerRequests.create.mockResolvedValueOnce({ data: { offers: [] } });
    const none = await request(app).post('/api/bookings/quote').set(as('alice-token')).send({ origin: 'NYC', destination: 'PAR', date: '2026-12-10' });
    expect(none.status).toBe(404);
    duffel.offerRequests.create.mockRejectedValueOnce(new Error('boom'));
    const fail = await request(app).post('/api/bookings/quote').set(as('alice-token')).send({ origin: 'NYC', destination: 'PAR', date: '2026-12-10' });
    expect(fail.status).toBe(502);
  });

  it('pickMatchingOffer falls back: same carrier other time, then cheapest', () => {
    const a = offer({ id: 'a', total_amount: '300' });
    const b = offer({ id: 'b', total_amount: '100', owner: { name: 'X', iata_code: 'XX' } });
    b.slices = [{ ...b.slices[0], segments: [{ ...b.slices[0].segments[0], marketing_carrier: { iata_code: 'XX' }, operating_carrier: { iata_code: 'XX' } }] }];
    expect(pickMatchingOffer([a, b], { carrierCode: 'BA', departTime: '09:00' })).toMatchObject({ match: 'carrier', offer: { id: 'a' } });
    expect(pickMatchingOffer([a, b], { carrierCode: 'LH' })).toMatchObject({ match: 'cheapest', offer: { id: 'b' } });
    expect(pickMatchingOffer([], {})).toBeNull();
  });
});

describe('POST /payment-intent — gates before any card is charged', () => {
  it('requires the fare-rules checkbox', async () => {
    const res = await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody({ termsAccepted: false }));
    expect(res.status).toBe(400);
    expect(res.body.details.reason).toBe('terms_not_accepted');
    expect(duffel.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('re-fetches the offer and stops on a price change, returning the new quote', async () => {
    duffel.offers.get.mockResolvedValue({ data: offer({ total_amount: '240.00' }) });
    const res = await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody());
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe('price_changed');
    expect(res.body.details.quote.totalAmount).toBe('240.00');
    expect(res.body.details.quote.priceChange.difference).toBe(13.85);
    expect(duffel.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('410s an expired offer', async () => {
    duffel.offers.get.mockResolvedValue({ data: offer({ expires_at: '2020-01-01T00:00:00Z' }) });
    const res = await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody());
    expect(res.status).toBe(410);
  });

  it('demands a passport only when the offer requires identity documents', async () => {
    duffel.offers.get.mockResolvedValue({ data: offer({ passenger_identity_documents_required: true }) });
    const res = await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody());
    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors['passengers.0.passport']).toMatch(/requires passport/);

    duffel.offers.get.mockResolvedValue({ data: offer() }); // not required
    const ok = await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody());
    expect(ok.status).toBe(200);
  });

  it('validates names, adult age, passport expiry, contact', () => {
    const o = offer({ passenger_identity_documents_required: true });
    const errs = validatePassengers(
      o,
      [pax({ given_name: 'Zoë 1', born_on: '2015-01-01', passport: { number: 'X1', issuing_country_code: 'USA', expires_on: '2026-12-01' } })],
      { email: 'nope', phone_number: '555' },
    );
    expect(Object.keys(errs).sort()).toEqual(
      [
        'contact.email',
        'contact.phone_number',
        'passengers.0.born_on',
        'passengers.0.given_name',
        'passengers.0.passport.expires_on',
        'passengers.0.passport.issuing_country_code',
        'passengers.0.passport.number',
      ].sort(),
    );
    expect(validatePassengers(offer(), [pax(), pax()], CONTACT).passengers).toMatch(/1 traveller/);
  });

  it('creates the intent for the offer total and records a pending booking', async () => {
    const res = await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paymentIntentId: 'pit_1', clientToken: 'ct_1', amount: '226.15', currency: 'USD' });
    expect(duffel.paymentIntents.create).toHaveBeenCalledWith({ amount: '226.15', currency: 'USD' });
    const insert = dbCalls.find((c) => c.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ user_id: 'alice-id', status: 'payment_pending', duffel_payment_intent_id: 'pit_1' });
    // Only names + type are persisted — no DOB, passport or phone.
    expect(insert?.args[0].passengers).toEqual([{ given_name: 'Testa', family_name: 'Booker', type: 'adult' }]);
  });
});

describe('POST /confirm — payment → order, failures refunded', () => {
  const pay = () => request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody());

  it('confirms the payment, creates an instant balance-paid order, emails the account with the PDF', async () => {
    await pay();
    const res = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId: 'ord_ABC123', bookingReference: 'XYZ789', status: 'confirmed', emailSent: true, emailTo: 'alice@test.dev' });

    const create = duffel.orders.create.mock.calls[0][0];
    expect(create).toMatchObject({
      type: 'instant',
      selected_offers: ['off_1'],
      payments: [{ type: 'balance', amount: '226.15', currency: 'USD' }],
    });
    expect(create.passengers[0]).toMatchObject({ id: 'pas_1', given_name: 'Testa', email: 'traveller@test.dev', phone_number: '+14155550123' });

    // Email: to the signed-in account only (not the passenger contact), PDF attached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['alice@test.dev']);
    expect(body.subject).toMatch(/\[TEST\].*XYZ789/);
    expect(body.attachments[0].filename).toBe('BlueMurr-itinerary-XYZ789.pdf');
    expect(Buffer.from(body.attachments[0].content, 'base64').subarray(0, 5).toString()).toBe('%PDF-');

    const update = dbCalls.filter((c) => c.method === 'update').pop();
    expect(update?.args[0]).toMatchObject({ status: 'confirmed', duffel_order_id: 'ord_ABC123', booking_reference: 'XYZ789' });

    const again = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(again.status).toBe(409);
    expect(duffel.orders.create).toHaveBeenCalledTimes(1);
  });

  it('includes the passport on the order when the airline requires it', async () => {
    duffel.offers.get.mockResolvedValue({ data: offer({ passenger_identity_documents_required: true }) });
    await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(
      payBody({ passengers: [pax({ passport: { number: 'x1234567', issuing_country_code: 'us', expires_on: '2031-01-01' } })] }),
    );
    await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(duffel.orders.create.mock.calls[0][0].passengers[0].identity_documents).toEqual([
      { type: 'passport', unique_identifier: 'X1234567', issuing_country_code: 'US', expires_on: '2031-01-01' },
    ]);
  });

  it('two confirms at once create one order', async () => {
    await pay();
    let release: () => void = () => {};
    duffel.orders.create.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ data: order() }))),
    );
    const first = request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const second = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(duffel.orders.create).toHaveBeenCalledTimes(1);
  });

  it("another user cannot confirm someone else's payment", async () => {
    await pay();
    const res = await request(app).post('/api/bookings/confirm').set(as('bob-token')).send({ paymentIntentId: 'pit_1' });
    expect(res.status).toBe(404);
    expect(duffel.paymentIntents.confirm).not.toHaveBeenCalled();
  });

  it('a payment that did not succeed creates no order', async () => {
    await pay();
    duffel.paymentIntents.confirm.mockResolvedValue({ data: { id: 'pit_1', status: 'requires_payment_method', amount: '226.15', currency: 'USD' } });
    const res = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(res.status).toBe(402);
    expect(duffel.orders.create).not.toHaveBeenCalled();
    expect(duffel.refunds.create).not.toHaveBeenCalled();
  });

  it('order failure after payment → refund, failed status, clear message', async () => {
    await pay();
    duffel.orders.create.mockRejectedValue({ errors: [{ code: 'offer_no_longer_available', message: 'gone' }] });
    const res = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(res.status).toBe(502);
    expect(res.body.details).toMatchObject({ reason: 'order_failed', refunded: true, code: 'offer_no_longer_available' });
    expect(res.body.error).toMatch(/refunded/);
    expect(duffel.refunds.create).toHaveBeenCalledWith({ payment_intent_id: 'pit_1', amount: '226.15', currency: 'USD' });
    const update = dbCalls.filter((c) => c.method === 'update').pop();
    expect(update?.args[0]).toMatchObject({ status: 'refunded', failure_reason: 'order_failed:offer_no_longer_available' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('price moved between payment and order → refund, no order', async () => {
    await pay();
    duffel.offers.get.mockResolvedValue({ data: offer({ total_amount: '250.00' }) });
    const res = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(res.status).toBe(409);
    expect(duffel.orders.create).not.toHaveBeenCalled();
    expect(duffel.refunds.create).toHaveBeenCalled();
  });

  it('an email failure does not fail a booked order', async () => {
    await pay();
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'sandbox' });
    const res = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
  });
});

describe('itinerary PDF + persistence without the table', () => {
  it('works end to end with the bookings table missing (in-memory fallback), PDF owner-only', async () => {
    dbMode = 'missing';
    await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send(payBody());
    const conf = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(conf.status).toBe(200);
    expect(conf.body.persisted).toBe(false);

    const list = await request(app).get('/api/bookings').set(as('alice-token'));
    expect(list.body.bookings).toHaveLength(1);
    expect(list.body.bookings[0]).toMatchObject({ status: 'confirmed', duffel_order_id: 'ord_ABC123' });

    const pdf = await request(app)
      .get('/api/bookings/ord_ABC123/itinerary.pdf')
      .set(as('alice-token'))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const bob = await request(app).get('/api/bookings/ord_ABC123/itinerary.pdf').set(as('bob-token'));
    expect(bob.status).toBe(404);
    expect((await request(app).get('/api/bookings/../x/itinerary.pdf').set(as('alice-token'))).status).toBe(404);
  });
});

describe('family bookings — optional title, only traveller 1 must be an adult', () => {
  // Offer departs 2026-12-10 (fixture).
  const family = (over: Partial<any> = {}) =>
    offer({
      passengers: [
        { id: 'pas_1', type: 'adult' },
        { id: 'pas_2', age: 9 },
        { id: 'pas_3', age: 1 },
      ],
      ...over,
    });
  const kid = (born_on: string) => pax({ title: '', given_name: 'Kid', born_on, gender: 'm' });

  it('quotes children by age; traveller 1 is always an adult', () => {
    expect(offerRequestPassengers(3, [null, 9, 1])).toEqual([{ type: 'adult' }, { age: 9 }, { age: 1 }]);
    expect(offerRequestPassengers(2, [5, null])).toEqual([{ type: 'adult' }, { type: 'adult' }]);
    expect(offerRequestPassengers(2)).toEqual([{ type: 'adult' }, { type: 'adult' }]);
  });

  it('POST /quote passes the ages to Duffel', async () => {
    duffel.offerRequests.create.mockResolvedValue({ data: { offers: [offer()] } });
    const res = await request(app).post('/api/bookings/quote').set(as('alice-token')).send({
      origin: 'New York', destination: 'Paris', originAirport: 'LGA', date: '2026-12-10', travelers: 3, ages: [null, 9, 1],
    });
    expect(res.status).toBe(200);
    expect(duffel.offerRequests.create.mock.calls[0][0].passengers).toEqual([{ type: 'adult' }, { age: 9 }, { age: 1 }]);
    const bad = await request(app).post('/api/bookings/quote').set(as('alice-token')).send({
      origin: 'New York', destination: 'Paris', date: '2026-12-10', ages: [null, 30],
    });
    expect(bad.status).toBe(400);
  });

  it('a mum with a 9-year-old and a 1-year-old passes, titles left empty', () => {
    const errs = validatePassengers(family(), [pax({ title: '' }), kid('2017-06-01'), kid('2025-03-01')], CONTACT);
    expect(errs).toEqual({});
    expect(passengerTypeOf({ age: 9 })).toBe('child');
    expect(passengerTypeOf({ age: 1 })).toBe('infant_without_seat');
  });

  it('traveller 1 under 18 is refused; a child on an adult-priced seat must be re-quoted', () => {
    const lead = validatePassengers(family(), [pax({ born_on: '2012-01-01' }), kid('2017-06-01'), kid('2025-03-01')], CONTACT);
    expect(lead['passengers.0.born_on']).toMatch(/first traveller must be 18/);
    const adultSeats = offer({ passengers: [{ id: 'pas_1', type: 'adult' }, { id: 'pas_2', type: 'adult' }] });
    expect(validatePassengers(adultSeats, [pax(), kid('2017-06-01')], CONTACT)['passengers.1.born_on']).toMatch(/price a child fare/);
    // Age the fare was priced for must match the date of birth.
    expect(validatePassengers(family(), [pax(), kid('2012-06-01'), kid('2025-03-01')], CONTACT)['passengers.1.born_on']).toMatch(/does not match/);
  });

  it('an empty title is sent to the airline derived from the passport gender', async () => {
    expect(effectiveTitle({ title: '', gender: 'f' })).toBe('ms');
    expect(effectiveTitle({ title: '', gender: 'm' })).toBe('mr');
    expect(effectiveTitle({ title: 'dr', gender: 'f' })).toBe('dr');
    await request(app).post('/api/bookings/payment-intent').set(as('alice-token')).send({ ...payBody(), passengers: [pax({ title: '' })] });
    const res = await request(app).post('/api/bookings/confirm').set(as('alice-token')).send({ paymentIntentId: 'pit_1' });
    expect(res.status).toBe(200);
    expect(duffel.orders.create.mock.calls[0][0].passengers[0].title).toBe('ms'); // pax() fixture is gender f
  });
});
