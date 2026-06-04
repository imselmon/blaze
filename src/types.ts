import type { BlazeRequest } from './request.js';
import type { BlazeResponse } from './response.js';

// Re-export the concrete types so consumers can reference them via 'blaze'
export type { BlazeRequest, BlazeResponse };

/* ------------------------------------------------------------------ */
/*  Core function signatures                                          */
/* ------------------------------------------------------------------ */

/** Express-style next callback. Call with no args to continue, or pass an error. */
export type NextFunction = (err?: unknown) => void;

/** Standard request handler: `(req, res, next) => void` */
export type Handler<E = Record<string, unknown>> = (
  req: BlazeRequest<E>,
  res: BlazeResponse,
  next: NextFunction,
) => void | Promise<void>;

/** Four-argument error handler: `(err, req, res, next) => void` */
export type ErrorHandler<E = Record<string, unknown>> = (
  err: unknown,
  req: BlazeRequest<E>,
  res: BlazeResponse,
  next: NextFunction,
) => void | Promise<void>;

/** Union of normal and error handlers. */
export type Middleware<E = Record<string, unknown>> =
  | Handler<E>
  | ErrorHandler<E>;

/* ------------------------------------------------------------------ */
/*  Cookie options                                                     */
/* ------------------------------------------------------------------ */

export interface CookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitioned?: boolean;
}
