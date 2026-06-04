/**
 * Bearer token authentication middleware for Blaze.
 *
 * Extracts the `Authorization: Bearer <token>` header and validates it
 * against a static token or an async validator function.
 *
 * @example
 * ```ts
 * import { bearerAuth } from 'blaze/middleware/bearer-auth'
 * app.use('/api', bearerAuth({ token: 'my-secret-token' }))
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface BearerAuthOptions<E = Record<string, unknown>> {
  /** Static token to compare against. */
  token?: string;
  /** Resolve the expected token at request time (e.g. from KV). */
  secret?: string | ((req: BlazeRequest<E>) => string | Promise<string>);
  /** Custom async validator — return `true` to allow. */
  validator?: (
    token: string,
    req: BlazeRequest<E>,
  ) => boolean | Promise<boolean>;
  /** WWW-Authenticate realm. Default: `'Blaze'`. */
  realm?: string;
}

export function bearerAuth<E = Record<string, unknown>>(
  opts: BearerAuthOptions<E>,
): (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => void | Promise<void> {
  const realm = opts.realm ?? 'Blaze';

  return async (req, res, next) => {
    const header = req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      res
        .status(401)
        .header('WWW-Authenticate', `Bearer realm="${realm}"`)
        .json({ error: 'Unauthorized' });
      return;
    }

    const token = header.slice(7); // strip "Bearer "

    // Custom validator
    if (opts.validator) {
      const ok = await opts.validator(token, req);
      if (!ok) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
      next();
      return;
    }

    // Static or dynamic secret comparison
    let expected: string | undefined;
    if (opts.token) {
      expected = opts.token;
    } else if (opts.secret) {
      expected =
        typeof opts.secret === 'function'
          ? await opts.secret(req)
          : opts.secret;
    }

    if (!expected || !timingSafeEqual(token, expected)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}

/** Constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}
