/**
 * blaze/app — `createApp<Env>()` factory
 *
 * Returns the top-level application object with Express-style method
 * shortcuts and the Cloudflare Workers `fetch` entrypoint.
 */

import { BlazeRequest } from './request.js';
import { BlazeResponse } from './response.js';
import { Router, Route } from './router.js';
import { BlazeError } from './error.js';
import type { Handler, ErrorHandler, Middleware, NextFunction } from './types.js';

/* ------------------------------------------------------------------ */
/*  Public app interface                                              */
/* ------------------------------------------------------------------ */

export interface BlazeApp<E = Record<string, unknown>> {
  /* HTTP method shortcuts */
  get(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  post(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  put(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  patch(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  delete(path: string, ...fns: Handler<E>[]): BlazeApp<E>;
  all(path: string, ...fns: Handler<E>[]): BlazeApp<E>;

  /* Middleware & routing */
  use(
    pathOrHandler: string | Middleware<E> | Router<E>,
    ...handlers: Array<Middleware<E> | Router<E>>
  ): BlazeApp<E>;
  route(path: string): Route;
  Router(): Router<E>;

  /* Error / 404 */
  onError(fn: ErrorHandler<E>): BlazeApp<E>;
  notFound(fn: Handler<E>): BlazeApp<E>;

  /* Workers entrypoints */
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
  scheduled(
    event: ScheduledEvent,
    env: E,
    ctx: ExecutionContext,
  ): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create a new Blaze application.
 *
 * ```ts
 * const app = createApp<Env>()
 * app.get('/', (req, res) => res.json({ ok: true }))
 * export default { fetch: app.fetch }
 * ```
 */
export function createApp<E = Record<string, unknown>>(): BlazeApp<E> {
  const rootRouter = new Router<E>();

  let notFoundHandler: Handler<E> | null = null;

  /* ---- build the public interface ---- */

  const app: BlazeApp<E> = {
    /* HTTP shortcuts */
    get(path, ...fns) {
      rootRouter.get(path, ...fns);
      return app;
    },
    post(path, ...fns) {
      rootRouter.post(path, ...fns);
      return app;
    },
    put(path, ...fns) {
      rootRouter.put(path, ...fns);
      return app;
    },
    patch(path, ...fns) {
      rootRouter.patch(path, ...fns);
      return app;
    },
    delete(path, ...fns) {
      rootRouter.delete(path, ...fns);
      return app;
    },
    all(path, ...fns) {
      rootRouter.all(path, ...fns);
      return app;
    },

    /* Middleware / routing */
    use(
      pathOrHandler: string | Middleware<E> | Router<E>,
      ...handlers: Array<Middleware<E> | Router<E>>
    ) {
      if (typeof pathOrHandler === 'string') {
        rootRouter.use(pathOrHandler, ...handlers);
      } else {
        rootRouter.use(pathOrHandler, ...handlers);
      }
      return app;
    },

    route(path) {
      return rootRouter.route(path);
    },

    Router() {
      return new Router<E>();
    },

    /* Error / 404 */
    onError(fn) {
      rootRouter.onError(fn);
      return app;
    },

    notFound(fn) {
      notFoundHandler = fn;
      return app;
    },

    /* ---- Workers fetch entrypoint ---- */
    async fetch(
      request: Request,
      env: E,
      ctx: ExecutionContext,
    ): Promise<Response> {
      try {
        const req = new BlazeRequest<E>(request, env, ctx);

        return await new Promise<Response>((resolve) => {
          const res = new BlazeResponse(resolve);

          rootRouter.handle(req, res, (err?: unknown) => {
            // Stack exhausted — resolve with error or 404
            if (res.headersSent) return;

            if (err) {
              resolveError(err, resolve);
              return;
            }

            // No route matched — 404
            if (notFoundHandler) {
              try {
                const result = notFoundHandler(req, res, (_e?: unknown) => {
                  if (!res.headersSent) {
                    if (_e) {
                      resolveError(_e, resolve);
                    } else {
                      resolve(json404());
                    }
                  }
                });
                if (result instanceof Promise) {
                  result.catch((e) => {
                    if (!res.headersSent) resolveError(e, resolve);
                  });
                }
              } catch (e) {
                if (!res.headersSent) resolveError(e, resolve);
              }
            } else {
              resolve(json404());
            }
          });
        });
      } catch (err) {
        return errorResponse(err);
      }
    },

    /* ---- Workers scheduled entrypoint ---- */
    async scheduled(
      _event: ScheduledEvent,
      _env: E,
      _ctx: ExecutionContext,
    ): Promise<void> {
      // Intended to be overridden or left as a no-op by default
    },
  };

  return app;
}

/* ================================================================== */
/*  Private helpers                                                   */
/* ================================================================== */

function json404(): Response {
  return new Response(JSON.stringify({ error: 'Not Found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(err: unknown): Response {
  const status = err instanceof BlazeError ? err.status : 500;
  const message =
    err instanceof BlazeError ? err.message : 'Internal Server Error';
  const meta = err instanceof BlazeError ? err.meta : {};
  return new Response(JSON.stringify({ error: message, ...meta }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function resolveError(
  err: unknown,
  resolve: (response: Response) => void,
): void {
  resolve(errorResponse(err));
}
