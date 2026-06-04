/**
 * CORS middleware for Blaze.
 *
 * Handles preflight (OPTIONS) requests and sets appropriate
 * Access-Control-* headers on all responses.
 *
 * @example
 * ```ts
 * import { cors } from 'blaze/middleware/cors'
 * app.use(cors({ origins: ['https://example.com'], credentials: true }))
 * ```
 */

import type { BlazeRequest } from '../request.js';
import type { BlazeResponse } from '../response.js';
import type { NextFunction } from '../types.js';

export interface CorsOptions {
  /** Allowed origin(s). `'*'` allows all. Can be a function for dynamic origins. */
  origins?:
    | string
    | string[]
    | ((req: BlazeRequest<never>) => string | string[] | Promise<string | string[]>);
  /** Allowed HTTP methods. Default: `['GET','HEAD','PUT','PATCH','POST','DELETE']` */
  methods?: string[];
  /** Allowed request headers. */
  allowHeaders?: string[];
  /** Headers exposed to the client. */
  exposeHeaders?: string[];
  /** Allow credentials (cookies, Authorization header). */
  credentials?: boolean;
  /** `Access-Control-Max-Age` in seconds. */
  maxAge?: number;
}

export function cors(
  opts: CorsOptions = {},
): (req: BlazeRequest<never>, res: BlazeResponse, next: NextFunction) => void | Promise<void> {
  const {
    methods = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    allowHeaders = [],
    exposeHeaders = [],
    credentials = false,
    maxAge,
  } = opts;

  return async (req, res, next) => {
    const origin = req.header('Origin') || '';

    // Resolve allowed origins
    let allowedOrigins: string[];
    if (typeof opts.origins === 'function') {
      const result = await opts.origins(req);
      allowedOrigins = Array.isArray(result) ? result : [result];
    } else if (Array.isArray(opts.origins)) {
      allowedOrigins = opts.origins;
    } else if (typeof opts.origins === 'string') {
      allowedOrigins = [opts.origins];
    } else {
      allowedOrigins = ['*'];
    }

    // Determine the Access-Control-Allow-Origin value
    let acao: string;
    if (allowedOrigins.includes('*')) {
      acao = credentials ? origin : '*';
    } else if (allowedOrigins.includes(origin)) {
      acao = origin;
    } else {
      // Origin not allowed — continue without CORS headers
      next();
      return;
    }

    res.header('Access-Control-Allow-Origin', acao);
    if (acao !== '*') res.vary('Origin');
    if (credentials) res.header('Access-Control-Allow-Credentials', 'true');
    if (exposeHeaders.length > 0) {
      res.header('Access-Control-Expose-Headers', exposeHeaders.join(', '));
    }

    // Preflight
    if (req.method === 'OPTIONS') {
      res.header('Access-Control-Allow-Methods', methods.join(', '));

      const requestedHeaders = req.header('Access-Control-Request-Headers');
      if (allowHeaders.length > 0) {
        res.header('Access-Control-Allow-Headers', allowHeaders.join(', '));
      } else if (requestedHeaders) {
        // Reflect requested headers
        res.header('Access-Control-Allow-Headers', requestedHeaders);
      }

      if (maxAge !== undefined) {
        res.header('Access-Control-Max-Age', String(maxAge));
      }

      res.status(204).send(null);
      return;
    }

    next();
  };
}
