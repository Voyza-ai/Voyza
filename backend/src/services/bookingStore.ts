import { getSupabase } from './supabase';
import { logger } from '../utils/logger';

/**
 * Persistence for in-app flight bookings (public.bookings, migration 015).
 *
 * The table may not exist yet: migration 015 is written but applied by the
 * owner, by hand. Until then every write falls back to an in-process map so
 * the booking flow still works end to end (order created, email sent, PDF
 * downloadable from the same backend process) — it just isn't durable. The
 * first time the table is found missing we log it once, loudly, and stop
 * asking the database for the rest of the process's life.
 *
 * What is stored is deliberately thin: names and passenger types only. No
 * dates of birth, passport numbers, phone numbers or card data — Duffel holds
 * the full order and we can always re-read it by order id.
 */

export type BookingStatus = 'payment_pending' | 'confirmed' | 'failed' | 'refunded';

export type BookingRecord = {
  id?: string;
  user_id: string;
  trip_id: string | null;
  duffel_offer_id: string;
  duffel_payment_intent_id: string;
  duffel_order_id: string | null;
  booking_reference: string | null;
  status: BookingStatus;
  total_amount: number;
  total_currency: string;
  passengers: Array<{ given_name: string; family_name: string; type: string }>;
  slices: unknown;
  live_mode: boolean;
  failure_reason: string | null;
  created_at?: string;
  updated_at?: string;
};

const TABLE = 'bookings';
let tableMissing = false;
const memory = new Map<string, BookingRecord>(); // key: payment intent id

/** Postgres "undefined_table" or PostgREST "not in the schema cache". */
function isMissingTable(error: any): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /relation .*bookings.* does not exist|could not find the table/i.test(String(error.message ?? ''))
  );
}

function noteMissing(op: string) {
  if (!tableMissing) {
    logger.warn(
      'bookings table missing — booking persistence DISABLED, using in-memory store ' +
        '(apply backend/supabase/migrations/015_bookings.sql to persist)',
      { op },
    );
  }
  tableMissing = true;
}

export function isPersistenceEnabled(): boolean {
  return !tableMissing;
}

/** Test hook. */
export function __resetBookingStore() {
  tableMissing = false;
  memory.clear();
}

export async function insertBooking(rec: BookingRecord): Promise<void> {
  memory.set(rec.duffel_payment_intent_id, { ...rec, created_at: new Date().toISOString() });
  if (tableMissing) return;
  try {
    const { error } = await getSupabase().from(TABLE).insert(rec);
    if (isMissingTable(error)) return noteMissing('insert');
    if (error) logger.warn('insertBooking failed (non-fatal)', { message: error.message });
  } catch (err: any) {
    logger.warn('insertBooking threw (non-fatal)', { message: err?.message });
  }
}

export async function updateBooking(
  paymentIntentId: string,
  patch: Partial<BookingRecord>,
): Promise<void> {
  const prev = memory.get(paymentIntentId);
  if (prev) memory.set(paymentIntentId, { ...prev, ...patch, updated_at: new Date().toISOString() });
  if (tableMissing) return;
  try {
    const { error } = await getSupabase()
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('duffel_payment_intent_id', paymentIntentId);
    if (isMissingTable(error)) return noteMissing('update');
    if (error) logger.warn('updateBooking failed (non-fatal)', { message: error.message });
  } catch (err: any) {
    logger.warn('updateBooking threw (non-fatal)', { message: err?.message });
  }
}

/** The caller's own booking for this Duffel order, or null. */
export async function findBookingByOrder(
  userId: string,
  orderId: string,
): Promise<BookingRecord | null> {
  if (!tableMissing) {
    try {
      const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('user_id', userId)
        .eq('duffel_order_id', orderId)
        .limit(1);
      if (isMissingTable(error)) noteMissing('select');
      else if (!error && Array.isArray(data) && data[0]) return data[0] as BookingRecord;
    } catch (err: any) {
      logger.warn('findBookingByOrder threw (non-fatal)', { message: err?.message });
    }
  }
  for (const rec of memory.values()) {
    if (rec.user_id === userId && rec.duffel_order_id === orderId) return rec;
  }
  return null;
}

export async function listBookings(userId: string): Promise<BookingRecord[]> {
  if (!tableMissing) {
    try {
      const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (isMissingTable(error)) noteMissing('list');
      else if (!error && Array.isArray(data)) return data as BookingRecord[];
    } catch (err: any) {
      logger.warn('listBookings threw (non-fatal)', { message: err?.message });
    }
  }
  return [...memory.values()]
    .filter((r) => r.user_id === userId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
