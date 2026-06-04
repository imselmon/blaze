/**
 * blaze/router — TrieRouter, Layer, Route, Router
 *
 * Implements the entire routing engine:
 *   • TrieRouter  — radix-trie for O(log n) path matching
 *   • Layer       — single internal primitive wrapping a handler
 *   • Route       — method→handler map for a single path
 *   • Router      — stack-based middleware engine with trie acceleration
 */

import { BlazeRequest } from './request.js';
import { BlazeResponse } from './response.js';
import type { Handler, ErrorHandler, Middleware, NextFunction } from './types.js';

/* ================================================================== */
/*  Path parsing utilities                                            */
/* ================================================================== */

interface ParsedSegment {
  kind: 'static' | 'param' | 'wildcard';
  value: string;          // segment text for static, param name for param/wildcard
  optional: boolean;
  constraint: RegExp | null;
}

function parseSegment(raw: string): ParsedSegment {
  if (raw === '*') {
    return { kind: 'wildcard', value: '*', optional: false, constraint: null };
  }

  if (raw.startsWith(':')) {
    let name = raw.slice(1);
    let optional = false;
    let constraint: RegExp | null = null;

    // Regex constraint  :date([0-9]{4}-[0-9]{2}-[0-9]{2})
    const cm = name.match(/^(\w+)\((.+)\)$/);
    if (cm) {
      name = cm[1];
      constraint = new RegExp(`^${cm[2]}$`);
    }

    // Optional marker  :slug?
    if (name.endsWith('?')) {
      name = name.slice(0, -1);
      optional = true;
    }

    return { kind: 'param', value: name, optional, constraint };
  }

  return { kind: 'static', value: raw, optional: false, constraint: null };
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/* ================================================================== */
/*  TrieRouter — radix trie for O(log n) path matching                */
/* ================================================================== */

class TrieNode {
  staticChildren = new Map<string, TrieNode>();
  paramChild: TrieNode | null = null;
  paramName = '';
  paramConstraint: RegExp | null = null;
  wildcardChild: TrieNode | null = null;
  isEnd = false;
  pattern = '';
}

interface TrieMatch {
  params: Record<string, string>;
  pattern: string;
}

export class TrieRouter {
  private root = new TrieNode();

  /** Register a route pattern in the trie. */
  insert(pattern: string): void {
    const segments = splitPath(pattern);
    let node = this.root;

    for (const raw of segments) {
      const seg = parseSegment(raw);

      switch (seg.kind) {
        case 'static': {
          let child = node.staticChildren.get(seg.value);
          if (!child) {
            child = new TrieNode();
            node.staticChildren.set(seg.value, child);
          }
          node = child;
          break;
        }

        case 'param': {
          if (seg.optional) {
            // An optional param means the *current* node is also a valid endpoint
            node.isEnd = true;
            node.pattern = pattern;
          }
          if (!node.paramChild) {
            node.paramChild = new TrieNode();
            node.paramName = seg.value;
            node.paramConstraint = seg.constraint;
          }
          node = node.paramChild;
          break;
        }

        case 'wildcard': {
          if (!node.wildcardChild) {
            node.wildcardChild = new TrieNode();
          }
          node = node.wildcardChild;
          node.isEnd = true;
          node.pattern = pattern;
          return; // wildcard always terminates
        }
      }
    }

    node.isEnd = true;
    node.pattern = pattern;
  }

  /** Match a request path against registered patterns. */
  match(path: string): TrieMatch | null {
    const segments = splitPath(path);
    return this._match(this.root, segments, 0, {});
  }

  private _match(
    node: TrieNode,
    segments: string[],
    idx: number,
    params: Record<string, string>,
  ): TrieMatch | null {
    // All segments consumed — check for terminal node
    if (idx === segments.length) {
      return node.isEnd ? { params, pattern: node.pattern } : null;
    }

    const seg = segments[idx];

    // 1. Static match (highest priority)
    const staticChild = node.staticChildren.get(seg);
    if (staticChild) {
      const result = this._match(staticChild, segments, idx + 1, params);
      if (result) return result;
    }

    // 2. Parameterised match
    if (node.paramChild) {
      if (!node.paramConstraint || node.paramConstraint.test(seg)) {
        const result = this._match(node.paramChild, segments, idx + 1, {
          ...params,
          [node.paramName]: decodeURIComponent(seg),
        });
        if (result) return result;
      }
    }

    // 3. Wildcard match (lowest priority — captures the rest)
    if (node.wildcardChild) {
      const remaining = segments
        .slice(idx)
        .map((s) => decodeURIComponent(s))
        .join('/');
      return {
        params: { ...params, '*': remaining },
        pattern: node.wildcardChild.pattern,
      };
    }

    return null;
  }
}

/* ================================================================== */
/*  Layer — the single internal primitive                             */
/* ================================================================== */

export class Layer {
  path: string;
  handle: Function;
  route: Route | null;
  isErrorHandler: boolean;

  constructor(path: string, fn: Function, route: Route | null = null) {
    this.path = normalizePath(path);
    this.handle = fn;
    this.route = route;
    // Express convention: 4+ args means error handler
    this.isErrorHandler = fn.length >= 4;
  }

  /** Invoke as a normal (req, res, next) handler. */
  handleRequest(
    req: any,
    res: BlazeResponse,
    next: NextFunction,
  ): void {
    try {
      const result = this.handle(req, res, next) as unknown;
      if (result instanceof Promise) {
        (result as Promise<void>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  }

  /** Invoke as a (err, req, res, next) error handler. */
  handleError(
    err: unknown,
    req: any,
    res: BlazeResponse,
    next: NextFunction,
  ): void {
    try {
      const result = this.handle(err, req, res, next) as unknown;
      if (result instanceof Promise) {
        (result as Promise<void>).catch(next);
      }
    } catch (e) {
      next(e);
    }
  }
}

/* ================================================================== */
/*  Route — method → handler stack for a single path                  */
/* ================================================================== */

export class Route {
  path: string;
  private methods = new Map<string, Function[]>();

  constructor(path: string) {
    this.path = normalizePath(path);
  }

  /** Check whether this route has handlers for the given HTTP method. */
  hasMethod(method: string): boolean {
    return (
      this.methods.has(method.toUpperCase()) || this.methods.has('ALL')
    );
  }

  /** Add handlers for the given HTTP method. */
  addHandlers(method: string, fns: Function[]): void {
    const upper = method.toUpperCase();
    const existing = this.methods.get(upper) || [];
    existing.push(...fns);
    this.methods.set(upper, existing);
  }

  /**
   * Dispatch the request to this route's handler stack.
   * Iterates handlers registered for the matching method.
   */
  dispatch(
    req: any,
    res: BlazeResponse,
    done: NextFunction,
  ): void {
    const method = req.method.toUpperCase();
    const handlers =
      this.methods.get(method) || this.methods.get('ALL') || [];

    let idx = 0;

    const next = (err?: unknown): void => {
      if (err) {
        done(err);
        return;
      }
      if (idx >= handlers.length) {
        done();
        return;
      }
      const handler = handlers[idx++];
      try {
        const result = handler(req, res, next) as unknown;
        if (result instanceof Promise) {
          (result as Promise<void>).catch(done);
        }
      } catch (e) {
        done(e);
      }
    };

    next();
  }

  /* ---- Chainable method registration (used by app.route()) ---- */

  get(...fns: Function[]): this {
    this.addHandlers('GET', fns);
    return this;
  }
  post(...fns: Function[]): this {
    this.addHandlers('POST', fns);
    return this;
  }
  put(...fns: Function[]): this {
    this.addHandlers('PUT', fns);
    return this;
  }
  patch(...fns: Function[]): this {
    this.addHandlers('PATCH', fns);
    return this;
  }
  delete(...fns: Function[]): this {
    this.addHandlers('DELETE', fns);
    return this;
  }
  all(...fns: Function[]): this {
    this.addHandlers('ALL', fns);
    return this;
  }
}

/* ================================================================== */
/*  Router — the main routing engine                                  */
/* ================================================================== */

export class Router<E = Record<string, unknown>> {
  private stack: Layer[] = [];
  private trie = new TrieRouter();

  /* ---------------------------------------------------------------- */
  /*  Middleware registration                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Register middleware, optionally scoped to a path prefix.
   *
   * Accepts plain handlers, error handlers, and sub-Routers.
   */
  use(
    pathOrHandler: string | Middleware<E> | Router<unknown>,
    ...handlers: Array<Middleware<E> | Router<unknown>>
  ): this {
    let mountPath = '/';
    let fns: Array<Middleware<E> | Router<unknown>>;

    if (typeof pathOrHandler === 'string') {
      mountPath = normalizePath(pathOrHandler);
      fns = handlers;
    } else {
      fns = [pathOrHandler, ...handlers];
    }

    for (const fn of fns) {
      if (fn instanceof Router) {
        const subRouter = fn;
        const layer = new Layer(
          mountPath,
          (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => {
            subRouter.handle(req, res, next);
          },
        );
        this.stack.push(layer);
      } else {
        const layer = new Layer(mountPath, fn as Function);
        this.stack.push(layer);
      }
    }

    return this;
  }

  /* ---------------------------------------------------------------- */
  /*  Route registration shortcuts                                    */
  /* ---------------------------------------------------------------- */

  get(path: string, ...fns: Handler<E>[]): this {
    return this._addRoute('GET', path, fns);
  }
  post(path: string, ...fns: Handler<E>[]): this {
    return this._addRoute('POST', path, fns);
  }
  put(path: string, ...fns: Handler<E>[]): this {
    return this._addRoute('PUT', path, fns);
  }
  patch(path: string, ...fns: Handler<E>[]): this {
    return this._addRoute('PATCH', path, fns);
  }
  delete(path: string, ...fns: Handler<E>[]): this {
    return this._addRoute('DELETE', path, fns);
  }
  all(path: string, ...fns: Handler<E>[]): this {
    return this._addRoute('ALL', path, fns);
  }

  /**
   * Chainable route builder — register multiple methods on the same path:
   *
   * ```ts
   * router.route('/posts/:id').get(getPost).put(updatePost).delete(deletePost)
   * ```
   */
  route(path: string): Route {
    const normalised = normalizePath(path);
    const routeObj = new Route(normalised);
    const layer = new Layer(
      normalised,
      (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => {
        routeObj.dispatch(req, res, next);
      },
      routeObj,
    );
    this.stack.push(layer);
    this.trie.insert(normalised);
    return routeObj;
  }

  /** Register a 4-arg error handler. */
  onError(fn: ErrorHandler<E>): this {
    const layer = new Layer('/', fn as Function);
    // Force error handler flag even if .length detection fails (e.g. transpiled code)
    layer.isErrorHandler = true;
    this.stack.push(layer);
    return this;
  }

  /* ---------------------------------------------------------------- */
  /*  Request dispatch                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Walk the layer stack, matching middleware and routes against the
   * incoming request. Called recursively for sub-routers.
   */
  handle(
    req: BlazeRequest<E>,
    res: BlazeResponse,
    done: NextFunction,
  ): void {
    const { stack } = this;
    let idx = 0;

    // Trie match cache — recomputed only when req.path changes
    let cachedPath = '';
    let cachedMatch: TrieMatch | null = null;

    const matchTrie = (): TrieMatch | null => {
      if (req.path !== cachedPath) {
        cachedPath = req.path;
        cachedMatch = this.trie.match(req.path);
      }
      return cachedMatch;
    };

    const next = (err?: unknown): void => {
      // Don't continue if response already sent
      if (res.headersSent) return;

      while (idx < stack.length) {
        const layer = stack[idx++];

        /* ---- Route layer ---- */
        if (layer.route) {
          const trieResult = matchTrie();

          // Fast skip: path doesn't match any registered route
          if (!trieResult) continue;
          // Fast skip: this layer's pattern doesn't match the trie result
          if (layer.path !== trieResult.pattern) continue;
          // Method check
          if (!layer.route.hasMethod(req.method)) continue;

          // Merge params
          const prevParams = req.params;
          req.params = { ...prevParams, ...trieResult.params };

          if (err) {
            // Route layers don't handle errors — skip
            req.params = prevParams;
            continue;
          }

          layer.route.dispatch(
            req as any,
            res,
            (routeErr?: unknown) => {
              req.params = prevParams;
              next(routeErr);
            },
          );
          return;
        }

        /* ---- Middleware layer ---- */
        if (!prefixMatch(layer.path, req.path)) continue;

        // Error flow
        if (err) {
          if (layer.isErrorHandler) {
            layer.handleError(err, req as any, res, next);
            return;
          }
          continue; // skip non-error handlers
        }

        // Skip error handlers when there's no error
        if (layer.isErrorHandler) continue;

        // Path trimming for sub-router mounting
        if (layer.path !== '/' && layer.path.length > 0) {
          const prevPath = req.path;
          const prevBase = req.baseUrl;
          req.path = prevPath.slice(layer.path.length) || '/';
          req.baseUrl = prevBase + layer.path;

          layer.handleRequest(
            req as any,
            res,
            (layerErr?: unknown) => {
              // Restore path context
              req.path = prevPath;
              req.baseUrl = prevBase;
              next(layerErr);
            },
          );
        } else {
          layer.handleRequest(req as any, res, next);
        }
        return;
      }

      // Stack exhausted — hand back to caller (or app-level fallback)
      done(err);
    };

    next();
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                 */
  /* ---------------------------------------------------------------- */

  private _addRoute(method: string, path: string, fns: Handler<E>[]): this {
    const normalised = normalizePath(path);
    const routeObj = new Route(normalised);
    routeObj.addHandlers(method, fns as Function[]);

    const layer = new Layer(
      normalised,
      (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => {
        routeObj.dispatch(req, res, next);
      },
      routeObj,
    );
    this.stack.push(layer);
    this.trie.insert(normalised);
    return this;
  }
}

/* ================================================================== */
/*  Shared helpers                                                    */
/* ================================================================== */

/** Ensure path starts with `/` and has no trailing slash (except root). */
function normalizePath(path: string): string {
  if (!path || path === '/') return '/';
  let p = path.startsWith('/') ? path : `/${path}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Check if `requestPath` starts with `prefix`. */
function prefixMatch(prefix: string, requestPath: string): boolean {
  if (prefix === '/' || prefix === '') return true;
  return (
    requestPath === prefix || requestPath.startsWith(prefix + '/')
  );
}
