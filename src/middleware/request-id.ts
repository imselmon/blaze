/**
 * Request ID middleware for Blaze.
 *
 * Assigns a unique ID to each request via `crypto.randomUUID()` and
 * sets it as `req.id` and the `X-Request-Id` response header.
 *
 * @example
 * ```ts
 * import { requestId } from 'blaze/middleware/request-id'
 * app.use(requestId())
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface RequestIdOptions {
  /** Custom response header name. Default: `'X-Request-Id'`. */
  headerName?: string;
  /** Custom ID generator. Default: `crypto.randomUUID()`. */
  generator?: () => string;
}

export function requestId(
  opts: RequestIdOptions = {},
): (req: BlazeRequest<never>, res: BlazeResponse, next: NextFunction) => void {
  const headerName = opts.headerName ?? 'X-Request-Id';
  const generate = opts.generator ?? (() => crypto.randomUUID());

  return (req, res, next) => {
    // Reuse incoming request ID if present, otherwise generate
    const id = req.header(headerName) || generate();
    req.id = id;
    res.header(headerName, id);
    next();
  };
}
