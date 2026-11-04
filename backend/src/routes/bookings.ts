import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/error';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  bookingMode,
  confirmBooking,
  getOrder,
  quoteFlight,
  startPayment,
  type ConfirmedBooking,
} from '../services/booking';
import { findBookingByOrder, isPersistenceEnabled, listBookings } from '../services/bookingStore';
import { buildItineraryPdf, itineraryFilename } from '../services/itineraryPdf';
import { emailTemplates, sendEmail } from '../services/email';

/**
 * In-app flight booking. Mounted behind requireAuth at /api/bookings.
 * The flow and its safety rules live in services/booking.ts.
 */
const router = Router();

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const quoteSchema = z.object({
  origin: z.string().min(1).max(120),
  destination: z.string().min(1).max(120),
  originAirport: z.string().max(4).optional(),
  destinationAirport: z.string().max(4).optional(),
  date: DATE,
  travelers: z.number().int().min(1).max(9).default(1),
  carrierCode: z.string().max(8).optional(),
  operator: z.string().max(120).optional(),
  departTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  previousPrice: z.number().nonnegative().optional(),
  previousCurrency: z.string().length(3).optional(),
  /** Under-18 ages per traveller (null = adult); see QuoteInput.ages. */
  ages: z.array(z.number().int().min(0).max(17).nullable()).max(9).optional(),
});

const passengerSchema = z.object({
  title: z.string(),
  given_name: z.string().max(60),
  family_name: z.string().max(60),
  gender: z.string(),
  born_on: z.string(),
  passport: z
    .object({
      number: z.string().max(20).default(''),
      issuing_country_code: z.string().max(2).default(''),
      expires_on: z.string().default(''),
    })
    .nullable()
    .optional(),
});

const paymentSchema = z.object({
  offerId: z.string().min(1).max(80),
  expectedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  expectedCurrency: z.string().length(3),
  passengers: z.array(passengerSchema).min(1).max(9),
  contact: z.object({ email: z.string().max(200), phone_number: z.string().max(30) }),
  termsAccepted: z.boolean().default(false),
  tripId: z.string().uuid().nullable().optional(),
});

const confirmSchema = z.object({ paymentIntentId: z.string().min(1).max(80) });

router.get('/status', (_req, res) => {
  res.json({
    mode: bookingMode(),
    enabled: Boolean(env.DUFFEL_ACCESS_TOKEN) && (bookingMode() === 'test' || env.BOOKING_LIVE_ENABLED),
    persistence: isPersistenceEnabled(),
  });
});

router.post(
  '/quote',
  asyncHandler(async (req, res) => {
    const input = quoteSchema.parse(req.body);
    const quote = await quoteFlight(input);
    res.json({ quote });
  }),
);

router.post(
  '/payment-intent',
  asyncHandler(async (req, res) => {
    const input = paymentSchema.parse(req.body);
    const user = (req as any).user;
    const result = await startPayment({
      userId: user.id,
      userEmail: user.email ?? null,
      tripId: input.tripId ?? null,
      offerId: input.offerId,
      expectedAmount: input.expectedAmount,
      expectedCurrency: input.expectedCurrency,
      passengers: input.passengers as any,
      contact: input.contact,
      termsAccepted: input.termsAccepted,
    });
    res.json(result);
  }),
);

const fmtLocal = (iso: string | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso ?? '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} ${m[4]}`;
};

export async function sendConfirmationEmail(booking: ConfirmedBooking, pdf: Buffer): Promise<boolean> {
  // Only ever the signed-in account's own address — never a passenger's
  // contact email typed into the form.
  if (!booking.userEmail) return false;
  const order = booking.order;
  const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: order.total_currency }).format(
    parseFloat(order.total_amount),
  );
  const tpl = emailTemplates.bookingConfirmation({
    bookingReference: booking.bookingReference,
    airline: order.owner?.name ?? '',
    flights: (order.slices ?? []).flatMap((s: any) =>
      (s.segments ?? []).map((g: any) => ({
        flightNumber: `${g.marketing_carrier?.iata_code ?? ''}${g.marketing_carrier_flight_number ?? ''}`,
        from: g.origin?.iata_code ?? '',
        to: g.destination?.iata_code ?? '',
        departs: fmtLocal(g.departing_at),
        arrives: fmtLocal(g.arriving_at),
      })),
    ),
    travellers: (order.passengers ?? []).map((p: any) => `${p.given_name} ${p.family_name}`),
    total,
    testMode: order.live_mode === false,
    link: booking.tripId ? `${env.FRONTEND_URL}/results?tripId=${booking.tripId}` : `${env.FRONTEND_URL}/main`,
  });
  return sendEmail({
    to: booking.userEmail,
    subject: tpl.subject,
    html: tpl.html,
    type: 'booking_confirmation',
    attachments: [{ filename: itineraryFilename(order), content: pdf.toString('base64') }],
  });
}

router.post(
  '/confirm',
  asyncHandler(async (req, res) => {
    const { paymentIntentId } = confirmSchema.parse(req.body);
    const user = (req as any).user;
    const booking = await confirmBooking(user.id, paymentIntentId);

    // The order exists: from here nothing may turn the response into an
    // error. PDF / email failures are logged and reported as flags.
    let emailSent = false;
    try {
      const pdf = await buildItineraryPdf(booking.order);
      emailSent = await sendConfirmationEmail(booking, pdf);
    } catch (err: any) {
      logger.warn('booking: itinerary/email failed after order (non-fatal)', {
        orderId: booking.orderId,
        message: err?.message,
      });
    }

    res.json({
      orderId: booking.orderId,
      bookingReference: booking.bookingReference,
      status: booking.status,
      totalAmount: booking.totalAmount,
      totalCurrency: booking.totalCurrency,
      liveMode: Boolean(booking.order?.live_mode),
      emailSent,
      emailTo: emailSent ? booking.userEmail : null,
      persisted: isPersistenceEnabled(),
    });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const rows = await listBookings(user.id);
    res.json({ bookings: rows, persistence: isPersistenceEnabled() });
  }),
);

router.get(
  '/:orderId/itinerary.pdf',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const orderId = String(req.params.orderId);
    if (!/^ord_[A-Za-z0-9]+$/.test(orderId)) throw new AppError(400, 'Invalid order id');
    const own = await findBookingByOrder(user.id, orderId);
    if (!own) throw new AppError(404, 'Booking not found');
    const order = await getOrder(orderId);
    const pdf = await buildItineraryPdf(order);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${itineraryFilename(order)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  }),
);

export default router;
