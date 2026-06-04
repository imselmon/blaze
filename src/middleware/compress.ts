/**
 * Compression middleware for Blaze.
 *
 * Applies gzip or deflate compression to response bodies using the
 * Web Standard `CompressionStream` API. Checks `Accept-Encoding`
 * and skips already-encoded or tiny responses.
 *
 * @example
 * ```ts
 * import { compress } from 'blaze/middleware/compress'
 * app.use(compress({ threshold: 1024 }))
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface CompressOptions {
  /** Minimum response size in bytes before compressing. Default: `1024`. */
  threshold?: number;
  /** Preferred encodings in priority order. Default: `['gzip', 'deflate']`. */
  encodings?: ('gzip' | 'deflate')[];
}

export function compress(
  opts: CompressOptions = {},
): (req: BlazeRequest<never>, res: BlazeResponse, next: NextFunction) => void {
  const threshold = opts.threshold ?? 1024;
  const encodings = opts.encodings ?? ['gzip', 'deflate'];

  return (req, res, next) => {
    const acceptEncoding = req.header('Accept-Encoding') || '';

    // Determine which encoding to use
    let chosen: 'gzip' | 'deflate' | null = null;
    for (const enc of encodings) {
      if (acceptEncoding.includes(enc)) {
        chosen = enc;
        break;
      }
    }

    if (!chosen) {
      next();
      return;
    }

    const encoding = chosen;

    res.onSend((response) => {
      // Skip if already encoded
      if (response.headers.get('Content-Encoding')) return response;
      // Skip if no body
      if (!response.body) return response;
      // Skip small responses (check Content-Length if available)
      const cl = response.headers.get('Content-Length');
      if (cl && parseInt(cl, 10) < threshold) return response;

      const compressed = response.body.pipeThrough(
        new CompressionStream(encoding),
      );

      const headers = new Headers(response.headers);
      headers.set('Content-Encoding', encoding);
      headers.delete('Content-Length'); // length changes after compression
      // Ensure Vary includes Accept-Encoding
      const vary = headers.get('Vary');
      if (!vary) {
        headers.set('Vary', 'Accept-Encoding');
      } else if (!vary.toLowerCase().includes('accept-encoding')) {
        headers.set('Vary', `${vary}, Accept-Encoding`);
      }

      return new Response(compressed, {
        status: response.status,
        headers,
      });
    });

    next();
  };
}
