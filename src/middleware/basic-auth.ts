/**
 * HTTP Basic Authentication middleware for Blaze.
 *
 * Decodes the `Authorization: Basic <base64>` header, compares
 * credentials with a timing-safe comparison.
 *
 * @example
 * ```ts
 * import { basicAuth } from 'blaze/middleware/basic-auth'
 * app.use('/admin', basicAuth({
 *   username: (req) => req.env.ADMIN_USER,
 *   password: (req) => req.env.ADMIN_PASS,
 * }))
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface BasicAuthOptions<E = Record<string, unknown>> {
  /** Expected username — static string or resolver function. */
  username: string | ((req: BlazeRequest<E>) => string | Promise<string>);
  /** Expected password — static string or resolver function. */
  password: string | ((req: BlazeRequest<E>) => string | Promise<string>);
  /** WWW-Authenticate realm. Default: `'Blaze'`. */
  realm?: string;
}

export function basicAuth<E = Record<string, unknown>>(
  opts: BasicAuthOptions<E>,
): (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => void | Promise<void> {
  const realm = opts.realm ?? 'Blaze';

  return async (req, res, next) => {
    const header = req.header('Authorization');
    if (!header || !header.startsWith('Basic ')) {
      deny(res, realm);
      return;
    }

    const decoded = decodeBasicCredentials(header.slice(6));
    if (!decoded) {
      deny(res, realm);
      return;
    }

    const expectedUser =
      typeof opts.username === 'function'
        ? await opts.username(req)
        : opts.username;
    const expectedPass =
      typeof opts.password === 'function'
        ? await opts.password(req)
        : opts.password;

    if (
      !timingSafeEqual(decoded.username, expectedUser) ||
      !timingSafeEqual(decoded.password, expectedPass)
    ) {
      deny(res, realm);
      return;
    }

    next();
  };
}

/* ---- Helpers ---- */

function deny(res: BlazeResponse, realm: string): void {
  res
    .status(401)
    .header('WWW-Authenticate', `Basic realm="${realm}"`)
    .json({ error: 'Unauthorized' });
}

function decodeBasicCredentials(
  encoded: string,
): { username: string; password: string } | null {
  try {
    const decoded = atob(encoded);
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      username: decoded.slice(0, colonIdx),
      password: decoded.slice(colonIdx + 1),
    };
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}
