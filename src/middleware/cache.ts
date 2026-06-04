/**
 * Response caching middleware for Blaze via the Cache API.
 *
 * Checks the CF Cache API for a cached response before invoking
 * downstream handlers. On a cache miss, caches the response for
 * future requests.
 *
 * @example
 * ```ts
 * import { cache } from 'blaze/middleware/cache'
 * app.use(cache({ maxAge: 300 }))
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface CacheOptions {
  /** `max-age` in seconds for `Cache-Control`. Default: `60`. */
  maxAge?: number;
  /** `s-maxage` for shared caches. */
  sMaxAge?: number;
  /** HTTP methods to cache. Default: `['GET']`. */
  methods?: string[];
  /** Explicit `Cache-Control` header value. Overrides maxAge/sMaxAge. */
  cacheControl?: string;
}

export function cache(
  opts: CacheOptions = {},
): (req: BlazeRequest<never>, res: BlazeResponse, next: NextFunction) => void | Promise<void> {
  const methods = opts.methods ?? ['GET'];
  const maxAge = opts.maxAge ?? 60;

  const ccHeader =
    opts.cacheControl ??
    `public, max-age=${maxAge}${opts.sMaxAge !== undefined ? `, s-maxage=${opts.sMaxAge}` : ''}`;

  return async (req, res, next) => {
    if (!methods.includes(req.method)) {
      next();
      return;
    }

    const cacheApi = caches.default;
    const cacheKey = new Request(req.url, { method: 'GET' });

    // Try cache hit
    const cached = await cacheApi.match(cacheKey);
    if (cached) {
      res.raw(cached);
      return;
    }

    // On cache miss, intercept the outgoing response and store it
    res.onSend((response) => {
      // Only cache successful responses
      if (response.status >= 200 && response.status < 400) {
        const headers = new Headers(response.headers);
        if (!headers.has('Cache-Control')) {
          headers.set('Cache-Control', ccHeader);
        }
        const cacheable = new Response(response.clone().body, {
          status: response.status,
          headers,
        });
        req.ctx.waitUntil(cacheApi.put(cacheKey, cacheable));
      }
      return response;
    });

    next();
  };
}
