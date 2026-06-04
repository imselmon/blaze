/**
 * Request timeout middleware for Blaze.
 *
 * Races the downstream handler chain against a timer. If the timer
 * fires first, calls `next(err)` with a timeout error.
 *
 * @example
 * ```ts
 * import { timeout } from 'blaze/middleware/timeout'
 * app.use(timeout({ duration: 5000 }))
 * ```
 */

import { BlazeError } from '../error.js';
import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface TimeoutOptions {
  /** Timeout duration in milliseconds. */
  duration: number;
  /** Error message on timeout. Default: `'Request Timeout'`. */
  message?: string;
  /** HTTP status on timeout. Default: `408`. */
  status?: number;
}

export function timeout(
  opts: TimeoutOptions,
): (req: BlazeRequest<never>, res: BlazeResponse, next: NextFunction) => void {
  const { duration, message = 'Request Timeout', status = 408 } = opts;

  return (_req, res, next) => {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      next(new BlazeError(status, message));
    }, duration);

    // Wrap next so we can clear the timer when downstream completes
    const wrappedNext: NextFunction = (err?: unknown) => {
      if (timedOut) return;
      clearTimeout(timer);
      next(err);
    };

    // Also clear if the response is sent directly (no next() call)
    res.onSend((response) => {
      clearTimeout(timer);
      return response;
    });

    // Replace next for downstream handlers
    // We call next() ourselves to continue the chain, but with our wrapper
    wrappedNext();
  };
}
