/**
 * blaze/app — `createApp<Env>()` factory
 *
 * PERF: The `fetch` entrypoint uses a Deferred object instead of
 * `new Promise(executor)` to avoid the Promise executor allocation and
 * the microtask overhead it introduces on the hot path.
 */

import { BlazeRequest } from './request.js';
import { BlazeResponse, acquireResponse } from './response.js';
import { Router, Route } from './router.js';
import { BlazeError } from './error.js';
import type { Handler, ErrorHandler, Middleware, NextFunction } from './types.js';

/* ------------------------------------------------------------------ */
/*  Pre-built static error responses                                   */
/* ------------------------------------------------------------------ */
const NOT_FOUND_BODY = JSON.stringify({ error: 'Not Found' });
const NOT_FOUND_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json404(): Response {
  return new Response(NOT_FOUND_BODY, { status: 404, headers: NOT_FOUND_HEADERS });
}

function errorResponse(err: unknown): Response {
  const isBlazeErr = err instanceof BlazeError;
  const status  = isBlazeErr ? err.status : 500;
  const message = isBlazeErr ? err.message : 'Internal Server Error';
  const meta    = isBlazeErr ? err.meta : {};
  return new Response(
    JSON.stringify({ error: message, ...meta }),
    { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

/* ------------------------------------------------------------------ */
/*  Public app interface                                              */
/* ------------------------------------------------------------------ */

export interface BlazeApp<E = Record<string, unknown>> {
  get(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  post(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  put(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  patch(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  delete(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  all(path: string, ...fns: Handler<E>[]): BlazeApp<E>;

  use(
    pathOrHandler: string | Middleware<E> | Router<E>,
    ...handlers: Array<Middleware<E> | Router<E>>
  ): BlazeApp<E>;
  route(path: string): Route;
  Router(): Router<E>;

  onError(fn: ErrorHandler<E>): BlazeApp<E>;
  notFound(fn: Handler<E>): BlazeApp<E>;

  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
  scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                           */
/* ------------------------------------------------------------------ */

export function createApp<E = Record<string, unknown>>(): BlazeApp<E> {
  const rootRouter = new Router<E>();
  let notFoundHandler: Handler<E> | null = null;

  const app: BlazeApp<E> = {
    get(path, ...fns)    { rootRouter.get(path, ...fns);    return app; },
    post(path, ...fns)   { rootRouter.post(path, ...fns);   return app; },
    put(path, ...fns)    { rootRouter.put(path, ...fns);    return app; },
    patch(path, ...fns)  { rootRouter.patch(path, ...fns);  return app; },
    delete(path, ...fns) { rootRouter.delete(path, ...fns); return app; },
    all(path, ...fns)    { rootRouter.all(path, ...fns);    return app; },

    use(pathOrHandler, ...handlers) {
      rootRouter.use(pathOrHandler as any, ...handlers as any);
      return app;
    },

    route(path) { return rootRouter.route(path); },
    Router()    { return new Router<E>(); },

    onError(fn) { rootRouter.onError(fn); return app; },
    notFound(fn) { notFoundHandler = fn; return app; },

    /* ---- Workers fetch entrypoint (sync-first optimized) ---- */
    fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      // Sync-first capture: if the entire handler chain is synchronous
      // (the common case for simple JSON routes), we capture the Response in
      // a local variable and return Promise.resolve() — one allocation instead
      // of new Promise(executor) + two variable captures + executor call.
      let syncResponse: Response | null = null;
      let asyncResolve: ((r: Response) => void) | null = null;

      const resolve = (r: Response): void => {
        if (asyncResolve !== null) {
          asyncResolve(r);
        } else {
          syncResponse = r;
        }
      };

      try {
        const req = new BlazeRequest<E>(request, env, ctx);
        const res = acquireResponse(resolve);

        rootRouter.handle(req, res, (err?: unknown) => {
          if (res.headersSent) return;
          if (err) { resolve(errorResponse(err)); return; }

          if (notFoundHandler) {
            try {
              const r = notFoundHandler(req, res, (_e?: unknown) => {
                if (!res.headersSent) resolve(_e ? errorResponse(_e) : json404());
              });
              if (r !== null && r !== undefined && typeof (r as any).then === 'function') {
                (r as Promise<void>).catch((e) => { if (!res.headersSent) resolve(errorResponse(e)); });
              }
            } catch (e) {
              if (!res.headersSent) resolve(errorResponse(e));
            }
          } else {
            resolve(json404());
          }
        });
      } catch (err) {
        resolve(errorResponse(err));
      }

      // Fast path: handler was synchronous — return already-resolved promise
      if (syncResponse !== null) return Promise.resolve(syncResponse);

      // Slow path: handler is async — create the promise and wire up resolve
      return new Promise<Response>((r) => { asyncResolve = r; });
    },

    async scheduled(_event: ScheduledEvent, _env: E, _ctx: ExecutionContext): Promise<void> {
      // Override by registering a handler externally if needed
    },
  };

  return app;
}
