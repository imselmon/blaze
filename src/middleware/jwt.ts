/**
 * JWT authentication middleware for Blaze.
 *
 * Verifies JWTs via Web Crypto (`crypto.subtle`). Supports HS256 and
 * RS256 algorithms. Sets decoded payload on `req.user`.
 *
 * @example
 * ```ts
 * import { jwtAuth } from 'blaze/middleware/jwt'
 * app.use('/api', jwtAuth({ secret: (req) => req.env.JWT_SECRET }))
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface JwtAuthOptions<E = Record<string, unknown>> {
  /** HMAC secret (HS256) or JWK/PEM public key string (RS256). */
  secret: string | ((req: BlazeRequest<E>) => string | Promise<string>);
  /** Allowed algorithms. Default: `['HS256']`. */
  algorithms?: ('HS256' | 'RS256')[];
  /** Expected `iss` claim. */
  issuer?: string;
  /** Expected `aud` claim. */
  audience?: string;
}

export function jwtAuth<E = Record<string, unknown>>(
  opts: JwtAuthOptions<E>,
): (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => void | Promise<void> {
  const algorithms = opts.algorithms ?? ['HS256'];

  return async (req, res, next) => {
    const header = req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = header.slice(7);
    const secret =
      typeof opts.secret === 'function'
        ? await opts.secret(req)
        : opts.secret;

    try {
      const payload = await verifyJwt(token, secret, algorithms, {
        issuer: opts.issuer,
        audience: opts.audience,
      });
      // Set decoded payload — users augment BlazeRequest for type safety
      (req as any).user = payload;
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token';
      res.status(401).json({ error: message });
    }
  };
}

/* ================================================================== */
/*  JWT verification internals (Web Crypto only)                      */
/* ================================================================== */

async function verifyJwt(
  token: string,
  secret: string,
  algorithms: ('HS256' | 'RS256')[],
  claims: { issuer?: string; audience?: string },
): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const [headerB64, payloadB64, signatureB64] = parts;

  const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64));
  const header = JSON.parse(headerJson) as { alg: string; typ?: string };

  if (!algorithms.includes(header.alg as 'HS256' | 'RS256')) {
    throw new Error(`Algorithm ${header.alg} not allowed`);
  }

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);

  let valid = false;

  if (header.alg === 'HS256') {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify('HMAC', key, signature, data);
  } else if (header.alg === 'RS256') {
    const key = await importRS256Key(secret);
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature,
      data,
    );
  }

  if (!valid) throw new Error('Invalid signature');

  const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;

  // Validate time-based claims
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new Error('Token expired');
  }
  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    throw new Error('Token not yet valid');
  }
  if (claims.issuer && payload.iss !== claims.issuer) {
    throw new Error('Invalid issuer');
  }
  if (claims.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(claims.audience)) {
      throw new Error('Invalid audience');
    }
  }

  return payload;
}

/** Import an RS256 public key from either JWK or PEM format. */
async function importRS256Key(secret: string): Promise<CryptoKey> {
  const trimmed = secret.trim();

  // Try JWK first
  if (trimmed.startsWith('{')) {
    const jwk = JSON.parse(trimmed) as JsonWebKey;
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  }

  // PEM (SPKI) format
  const pemBody = trimmed
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return crypto.subtle.importKey(
    'spki',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/* ---- Base64URL helpers ---- */

function base64UrlDecode(str: string): ArrayBuffer {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
