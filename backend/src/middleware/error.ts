import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

/**
 * Known application error — use this instead of generic Error
 * when you want to control the HTTP status returned to clients.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  // Zod validation errors → 400 with field-level details
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'ValidationError',
      details: err.flatten().fieldErrors,
    });
  }

  if (err instanceof AppError) {
    logger.warn('AppError', { statusCode: err.statusCode, message: err.message });
    return res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
    });
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  logger.error('Unhandled error', {
    message,
    stack: err instanceof Error ? err.stack : undefined,
    path: req.originalUrl,
  });

  return res.status(500).json({
    error: 'Internal Server Error',
  });
}
