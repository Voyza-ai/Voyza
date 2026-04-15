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

  if (error || !user) {
    return next(new AppError(401, 'Unauthorized'));
  }

  (req as any).user = user;
  next();
}
