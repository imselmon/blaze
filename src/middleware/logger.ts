/**
 * Request logger middleware for Blaze.
 *
 * Logs method, path, status, response time, and CF colo to `console.log`.
 *
 * @example
 * ```ts
 * import { logger } from 'blaze/middleware/logger'
 * app.use(logger())
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface LoggerOptions {
  /** Log format: `'short'` (default), `'long'`, or a custom formatter. */
  format?:
    | 'short'
    | 'long'
    | ((req: BlazeRequest<never>, status: number, durationMs: number) => string);
}

export function logger(
  opts: LoggerOptions = {},
): (req: BlazeRequest<never>, res: BlazeResponse, next: NextFunction) => void {
  const { format = 'short' } = opts;

  return (req, res, next) => {
    const start = Date.now();

    // Hook into the response to capture status + timing
    res.onSend((response) => {
      const duration = Date.now() - start;

      let line: string;
      if (typeof format === 'function') {
        line = format(req, response.status, duration);
      } else if (format === 'long') {
        const colo = req.cf?.colo ?? '-';
        const ip = req.ip || '-';
        line = `${req.method} ${req.path} ${response.status} ${duration}ms ip=${ip} colo=${colo} id=${req.id || '-'}`;
      } else {
        const colo = req.cf?.colo ?? '-';
        line = `${req.method} ${req.path} ${response.status} ${duration}ms [${colo}]`;
      }

      console.log(line);

      return response; // pass through unchanged
    });

    next();
  };
}
