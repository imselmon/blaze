/**
 * ETag middleware for Blaze.
 *
 * Generates an ETag from the response body and handles conditional
 * requests via `If-None-Match` → 304 Not Modified.
 *
 * Uses a fast djb2 hash for weak ETags (no crypto overhead).
 *
 * @example
 * ```ts
 * import { etag } from 'blaze/middleware/etag'
 * app.use(etag())
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface EtagOptions {
  /** Generate weak ETags (`W/"…"`). Default: `true`. */
  weak?: boolean;
}

export function etag(
  opts: EtagOptions = {},
): (req: BlazeRequest<never>, res: BlazeResponse, next: NextFunction) => void {
  const weak = opts.weak !== false;

  return (req, res, next) => {
    const ifNoneMatch = req.header('If-None-Match');

    // Monkey-patch terminal methods to inject ETag logic
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    const origHtml = res.html.bind(res);

    const tryEtag = (body: string, sendFn: () => void): void => {
      const tag = weak ? `W/"${djb2(body)}"` : `"${djb2(body)}"`;
      res.header('ETag', tag);

      if (ifNoneMatch && etagMatch(ifNoneMatch, tag)) {
        // Restore originals before sending 304
        res.json = origJson;
        res.send = origSend;
        res.html = origHtml;
        res.status(304).send(null);
        return;
      }

      // Restore and call original
      res.json = origJson;
      res.send = origSend;
      res.html = origHtml;
      sendFn();
    };

    res.json = (data: unknown, status?: number) => {
      const body = JSON.stringify(data);
      tryEtag(body, () => origJson(data, status));
    };

    res.send = (body?: BodyInit | null, status?: number) => {
      if (typeof body === 'string') {
        tryEtag(body, () => origSend(body, status));
      } else {
        origSend(body, status);
      }
    };

    res.html = (markup: string, status?: number) => {
      tryEtag(markup, () => origHtml(markup, status));
    };

    next();
  };
}

/* ---- djb2 hash ---- */

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

/** Check if `ifNoneMatch` header matches the `etag` value. */
function etagMatch(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch === '*') return true;
  // Handle comma-separated list of ETags
  const tags = ifNoneMatch.split(',').map((t) => t.trim());
  return tags.some(
    (t) =>
      t === etag ||
      t === etag.replace(/^W\//, '') ||
      t.replace(/^W\//, '') === etag.replace(/^W\//, ''),
  );
}
