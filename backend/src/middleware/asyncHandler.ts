import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler so thrown errors propagate to Express's
 * error middleware instead of being silently swallowed.
 *
 * Usage:
 *   router.get('/x', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler<T extends RequestHandler>(fn: T): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
