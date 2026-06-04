/**
 * Rate limiting middleware for Blaze via KV.
 *
 * Implements a sliding-window rate limiter backed by Cloudflare KV.
 *
 * @example
 * ```ts
 * import { rateLimit } from 'blaze/middleware/rate-limit'
 * app.use(rateLimit({
 *   kvBinding: (req) => req.env.RATE_LIMIT_KV,
 *   limit: 100,
 *   window: 60,
 * }))
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface RateLimitOptions<E = Record<string, unknown>> {
  /** KV namespace binding name or resolver. */
  kvBinding: string | ((req: BlazeRequest<E>) => KVNamespace);
  /** Maximum number of requests per window. */
  limit: number;
  /** Window size in seconds. */
  window: number;
  /** Custom key derivation. Default: client IP. */
  keyFn?: (req: BlazeRequest<E>) => string;
  /** Custom message for 429 responses. */
  message?: string;
}

export function rateLimit<E = Record<string, unknown>>(
  opts: RateLimitOptions<E>,
): (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => void | Promise<void> {
  const { limit, window: windowSec, message = 'Too Many Requests' } = opts;

  return async (req, res, next) => {
    // Resolve KV namespace
    let kv: KVNamespace;
    if (typeof opts.kvBinding === 'function') {
      kv = opts.kvBinding(req);
    } else {
      kv = (req.env as Record<string, unknown>)[opts.kvBinding] as KVNamespace;
    }

    const clientKey = opts.keyFn ? opts.keyFn(req) : req.ip || 'unknown';
    const now = Math.floor(Date.now() / 1000);
    const windowId = Math.floor(now / windowSec);
    const kvKey = `rl:${clientKey}:${windowId}`;

    const current = parseInt((await kv.get(kvKey)) || '0', 10);

    // Set rate-limit headers
    const remaining = Math.max(0, limit - current - 1);
    const reset = (windowId + 1) * windowSec;
    res.header('X-RateLimit-Limit', String(limit));
    res.header('X-RateLimit-Remaining', String(remaining));
    res.header('X-RateLimit-Reset', String(reset));

    if (current >= limit) {
      res.header('Retry-After', String(reset - now));
      res.status(429).json({ error: message });
      return;
    }

    // Increment counter — fire-and-forget for speed
    req.ctx.waitUntil(
      kv.put(kvKey, String(current + 1), { expirationTtl: windowSec * 2 }),
    );

    next();
  };
}
