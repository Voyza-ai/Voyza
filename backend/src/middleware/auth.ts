import type { Request, Response, NextFunction } from 'express';
import { getSupabase } from '../services/supabase';
import { AppError } from './error';

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Unauthorized'));
  }

  const token = authHeader.split(' ')[1];
  const supabase = getSupabase();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  // Supabase unreachable (DNS, timeout, 5xx) is not "signed out": measured, a
  // DNS blip answered a signed-in collaborator's role check with 401. Say it's
  // temporary so callers retry instead of acting on a sign-out.
  if (error && isAuthServiceDown(error)) {
    return next(new AppError(503, 'Sign-in check unavailable, try again'));
  }
  if (error || !user) {
    return next(new AppError(401, 'Unauthorized'));
  }

  (req as any).user = user;
  next();
}

/** The token check failed because the auth service couldn't be reached, not because the token is bad. */
export function isAuthServiceDown(error: { name?: string; status?: number } | null | undefined): boolean {
  if (!error) return false;
  if (error.name === 'AuthRetryableFetchError') return true;
  // An unrecognised error stays a 401 (as before).
  return typeof error.status === 'number' && (error.status === 0 || error.status >= 500);
}
