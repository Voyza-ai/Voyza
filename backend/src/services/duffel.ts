import { Duffel } from '@duffel/api';
import { env } from '../config/env';
import { AppError } from '../middleware/error';

/**
 * Duffel client for flight search, booking, and order management.
 * Token is a secret — only ever used from the backend.
 *
 * Duffel is optional during early dev: if DUFFEL_ACCESS_TOKEN isn't set,
 * calling getDuffel() throws a descriptive 503 instead of crashing at startup.
 */
let client: Duffel | null = null;

export function getDuffel(): Duffel {
  if (!env.DUFFEL_ACCESS_TOKEN) {
    throw new AppError(
      503,
      'Duffel is not configured. Set DUFFEL_ACCESS_TOKEN in backend/.env',
    );
  }
  if (!client) {
    client = new Duffel({ token: env.DUFFEL_ACCESS_TOKEN });
  }
  return client;
}
