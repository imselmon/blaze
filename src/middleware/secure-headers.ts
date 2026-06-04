/**
 * Security headers middleware for Blaze.
 *
 * Sets recommended security headers on every response:
 * CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
 * Referrer-Policy, Permissions-Policy, and CORP/COEP/COOP.
 *
 * @example
 * ```ts
 * import { secureHdrs } from 'blaze/middleware/secure-headers'
 * app.use(secureHdrs())
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface SecureHeadersOptions {
  /** Content-Security-Policy. Default: `"default-src 'self'"`. Set `false` to omit. */
  contentSecurityPolicy?: string | false;
  /** Strict-Transport-Security. Default: `"max-age=31536000; includeSubDomains"`. */
  strictTransportSecurity?: string | false;
  /** X-Frame-Options. Default: `"DENY"`. */
  xFrameOptions?: string | false;
  /** X-Content-Type-Options. Default: `"nosniff"`. */
  xContentTypeOptions?: string | false;
  /** Referrer-Policy. Default: `"strict-origin-when-cross-origin"`. */
  referrerPolicy?: string | false;
  /** X-XSS-Protection. Default: `"0"` (disabled — CSP is preferred). */
  xXssProtection?: string | false;
  /** Permissions-Policy. Default: `"geolocation=(), camera=(), microphone=()"`. */
  permissionsPolicy?: string | false;
  /** Cross-Origin-Embedder-Policy. */
  crossOriginEmbedderPolicy?: string | false;
  /** Cross-Origin-Opener-Policy. */
  crossOriginOpenerPolicy?: string | false;
  /** Cross-Origin-Resource-Policy. */
  crossOriginResourcePolicy?: string | false;
}

const DEFAULTS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-XSS-Protection': '0',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
};

const OPTIONS_TO_HEADER: Record<string, string> = {
  contentSecurityPolicy: 'Content-Security-Policy',
  strictTransportSecurity: 'Strict-Transport-Security',
  xFrameOptions: 'X-Frame-Options',
  xContentTypeOptions: 'X-Content-Type-Options',
  referrerPolicy: 'Referrer-Policy',
  xXssProtection: 'X-XSS-Protection',
  permissionsPolicy: 'Permissions-Policy',
  crossOriginEmbedderPolicy: 'Cross-Origin-Embedder-Policy',
  crossOriginOpenerPolicy: 'Cross-Origin-Opener-Policy',
  crossOriginResourcePolicy: 'Cross-Origin-Resource-Policy',
};

export function secureHdrs(
  opts: SecureHeadersOptions = {},
): (req: BlazeRequest<never>, res: BlazeResponse, next: NextFunction) => void {
  // Pre-compute the final header map at registration time
  const headers = new Map<string, string>();

  // Apply defaults
  for (const [header, value] of Object.entries(DEFAULTS)) {
    headers.set(header, value);
  }

  // Apply user overrides
  for (const [optKey, headerName] of Object.entries(OPTIONS_TO_HEADER)) {
    const val = (opts as Record<string, unknown>)[optKey];
    if (val === false) {
      headers.delete(headerName);
    } else if (typeof val === 'string') {
      headers.set(headerName, val);
    }
  }

  return (_req, res, next) => {
    for (const [name, value] of headers) {
      res.header(name, value);
    }
    next();
  };
}
