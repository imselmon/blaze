/**
 * blaze/router — CompiledRouter, Layer, Route, Router
 *
 * Performance architecture:
 *
 *  ┌─ TrieRouter.match(path) ─────────────────────────────────────────────────┐
 *  │  1. charIndex[path.charCodeAt(1)] → tiny candidate subset (O(1) lookup)  │
 *  │  2. Run only 1-2 compiled matchers instead of scanning all routes         │
 *  │  3. Static routes: path === pattern  (one string comparison)              │
 *  │     Single trailing param: startsWith(prefix) + slice (2 operations)     │
 *  │     Multi-param / wildcard: pre-compiled RegExp.exec (one RE call)        │
 *  └──────────────────────────────────────────────────────────────────────────┘
 *
 *  ┌─ Router.handle(req, res, done) ──────────────────────────────────────────┐
 *  │  Fast path (no middleware registered):                                    │
 *  │    trie.match(path) → routeRegistry.get(pattern) → route.dispatch()      │
 *  │    = 1 charIndex lookup + 1 Map.get + dispatch — no stack scan at all    │
 *  │                                                                           │
 *  │  Slow path (middleware present):                                          │
 *  │    Existing iterative stack walk (Express-compatible ordering)            │
 *  └──────────────────────────────────────────────────────────────────────────┘
 *
 *  ┌─ Route.dispatch ─────────────────────────────────────────────────────────┐
 *  │  Method resolved via switch table (no Map.get)                            │
 *  │  Single-handler fast path skips next() closure creation entirely          │
 *  └──────────────────────────────────────────────────────────────────────────┘
 */

import { BlazeRequest } from './request.js';
import { BlazeResponse } from './response.js';
import type { Handler, ErrorHandler, Middleware, NextFunction } from './types.js';

/* ================================================================== */
/*  Path utilities                                                     */
/* ================================================================== */

/** Frozen empty params — shared by all static route matches, zero allocation */
const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

function splitPath(path: string): string[] {
  const parts: string[] = [];
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    if (segs[i]) parts.push(segs[i]);
  }
  return parts;
}

function decodeSeg(s: string): string {
  return s.indexOf('%') === -1 ? s : decodeURIComponent(s);
}

/* ================================================================== */
/*  Fast compiled matcher — built once at route registration          */
/* ================================================================== */

interface TrieMatch {
  params: Record<string, string>;
  pattern: string;
}

interface FastMatcher {
  pattern: string;
  isComplex: boolean;
  exec(path: string): TrieMatch | null;
}

/**
 * Build the fastest possible matcher for a route pattern.
 * Called ONCE at `app.get(...)` — the returned function runs on every request.
 */
function buildMatcher(pattern: string): FastMatcher {
  // ── Root ──────────────────────────────────────────────────────────────────
  if (pattern === '/') {
    return {
      pattern, isComplex: false,
      exec: (path) => path === '/' ? { params: EMPTY_PARAMS, pattern } : null,
    };
  }

  const segments = splitPath(pattern);

  // ── Pure static ───────────────────────────────────────────────────────────
  if (segments.every(s => !s.startsWith(':') && s !== '*')) {
    return {
      pattern, isComplex: false,
      exec: (path) => path === pattern ? { params: EMPTY_PARAMS, pattern } : null,
    };
  }

  // Detect complex patterns (optional params, regex constraints) → trie handles them
  const hasComplex = segments.some(s => {
    if (!s.startsWith(':')) return false;
    const n = s.slice(1);
    return n.endsWith('?') || n.includes('(');
  });
  if (hasComplex) {
    return { pattern, isComplex: true, exec: () => null };
  }

  // ── Single trailing param: /prefix/:id ────────────────────────────────────
  const lastSeg = segments[segments.length - 1];
  const prevAllStatic = segments.slice(0, -1).every(s => !s.startsWith(':') && s !== '*');

  if (lastSeg.startsWith(':') && prevAllStatic) {
    const prefix = segments.length === 1 ? '/' : '/' + segments.slice(0, -1).join('/') + '/';
    const paramName = lastSeg.slice(1);
    const prefixLen = prefix.length;
    return {
      pattern, isComplex: false,
      exec(path: string): TrieMatch | null {
        if (path.length <= prefixLen) return null;
        if (!path.startsWith(prefix)) return null;
        const val = path.slice(prefixLen);
        if (val.indexOf('/') !== -1) return null;
        const params = Object.create(null) as Record<string, string>;
        params[paramName] = val;
        return { params, pattern };
      },
    };
  }

  // ── General: pre-compiled RegExp ─────────────────────────────────────────
  const paramNames: string[] = [];
  const reStr = '^/' + segments.map(seg => {
    if (seg === '*')         { paramNames.push('*');        return '(.+)'; }
    if (seg.startsWith(':')) { paramNames.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/') + '$';
  const re = new RegExp(reStr);

  return {
    pattern, isComplex: false,
    exec(path: string): TrieMatch | null {
      const m = re.exec(path);
      if (!m) return null;
      const params = Object.create(null) as Record<string, string>;
      for (let i = 0; i < paramNames.length; i++) params[paramNames[i]] = decodeSeg(m[i + 1]);
      return { params, pattern };
    },
  };
}

/* ================================================================== */
/*  Recursive trie — fallback for complex patterns only               */
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

function insertTrie(root: TrieNode, pattern: string): void {
  const segs = splitPath(pattern);
  let node = root;
  for (const raw of segs) {
    const seg = parseSegment(raw);
    switch (seg.kind) {
      case 'static': {
        let c = node.staticChildren.get(seg.value);
        if (!c) { c = new TrieNode(); node.staticChildren.set(seg.value, c); }
        node = c; break;
      }
      case 'param': {
        if (seg.optional) { node.isEnd = true; node.pattern = pattern; }
        if (!node.paramChild) {
          node.paramChild = new TrieNode();
          node.paramName = seg.value;
          node.paramConstraint = seg.constraint;
        }
        node = node.paramChild; break;
      }
      case 'wildcard': {
        if (!node.wildcardChild) node.wildcardChild = new TrieNode();
        node = node.wildcardChild;
        node.isEnd = true;
        node.pattern = pattern;
        return;
      }
    }
  }
  node.isEnd = true;
  node.pattern = pattern;
}

function execTrie(node: TrieNode, segs: string[], idx: number, params: Record<string, string>): TrieMatch | null {
  if (idx === segs.length) return node.isEnd ? { params, pattern: node.pattern } : null;
  const seg = segs[idx];
  const sc = node.staticChildren.get(seg);
  if (sc) { const r = execTrie(sc, segs, idx + 1, params); if (r) return r; }
  if (node.paramChild) {
    if (!node.paramConstraint || node.paramConstraint.test(seg)) {
      const prev = params[node.paramName];
      params[node.paramName] = decodeSeg(seg);
      const r = execTrie(node.paramChild, segs, idx + 1, params);
      if (r) return r;
      if (prev === undefined) delete params[node.paramName]; else params[node.paramName] = prev;
    }
  }
  if (node.wildcardChild) {
    const parts: string[] = [];
    for (let i = idx; i < segs.length; i++) parts.push(decodeSeg(segs[i]));
    params['*'] = parts.join('/');
    return { params, pattern: node.wildcardChild.pattern };
  }
  return null;
}

/* ================================================================== */
/*  TrieRouter — two-index system for O(1)–O(depth) dispatch         */
/*                                                                    */
/*  exactIndex:  static route  →  O(1) Map.get per request           */
/*  prefixIndex: parametric    →  O(depth) lastIndexOf walk,         */
/*               keyed by the full static prefix of the pattern       */
/*               e.g. "/resource/50/:id" → key "resource/50"         */
/*               So 200 /resource/N/:id routes all get their OWN key  */
/*               instead of colliding in charIndex['r']               */
/* ================================================================== */

/**
 * Returns the path formed by all segments BEFORE the first param/wildcard.
 * This is the discriminator used for prefixIndex.
 *
 *  /resource/50/:id          → "resource/50"
 *  /users/:id                → "users"
 *  /org/:org/repo/:repo/...  → "org"
 *  /static/*                 → "static"
 *  /*                        → ""            (root-level wildcard)
 *  /health                   → (never called; stored in exactIndex)
 */
function staticPrefixKey(pattern: string): string {
  const segs = splitPath(pattern);
  const parts: string[] = [];
  for (const s of segs) {
    if (s.charCodeAt(0) === 58 /* ':' */ || s === '*') break;
    parts.push(s);
  }
  return parts.join('/');
}

export class TrieRouter {
  /** O(1) duplicate detection — replaces O(n) Array.some() */
  private patternSet = new Set<string>();
  /** Static routes: exact path → matcher. O(1) Map.get per request. */
  private exactIndex = new Map<string, FastMatcher>();
  /**
   * Parametric routes: staticPrefixKey → candidates.
   * e.g. "resource/50" → [matcher for /resource/50/:id]
   *      "users"        → [matcher for /users/:id, /users/:id/posts]
   * At match time we walk lastIndexOf('/') backwards until we hit a key.
   */
  private prefixIndex = new Map<string, FastMatcher[]>();
  private trieRoot = new TrieNode();
  private hasComplexPatterns = false;

  insert(pattern: string): void {
    if (this.patternSet.has(pattern)) return;   // O(1) — was O(n)
    this.patternSet.add(pattern);

    const m = buildMatcher(pattern);

    if (m.isComplex) {
      this.hasComplexPatterns = true;
      insertTrie(this.trieRoot, pattern);
      // Complex patterns also enter prefixIndex for candidate narrowing
      const key = staticPrefixKey(pattern);
      let arr = this.prefixIndex.get(key);
      if (!arr) { arr = []; this.prefixIndex.set(key, arr); }
      arr.push(m);
      return;
    }

    // Determine if the pattern is purely static (no params, no wildcard)
    const segs = splitPath(pattern);
    const isStatic = pattern === '/' || segs.every(s => s.charCodeAt(0) !== 58 && s !== '*');

    if (isStatic) {
      // Exact lookup — one Map.get per request, zero iteration
      this.exactIndex.set(pattern, m);
    } else {
      // Prefix lookup — keyed by the static prefix
      const key = staticPrefixKey(pattern);
      let arr = this.prefixIndex.get(key);
      if (!arr) { arr = []; this.prefixIndex.set(key, arr); }
      arr.push(m);
    }
  }

  match(path: string): TrieMatch | null {
    // ── 1. O(1) exact match for all static routes ────────────────────────────
    const exact = this.exactIndex.get(path);
    if (exact) return exact.exec(path);

    // ── 2. Prefix walk for parametric routes ────────────────────────────────
    // Walk path backwards (lastIndexOf) building progressively shorter keys.
    // For "/resource/50/42":
    //   try key "resource/50" → hit in 1 step
    // For "/users/42":
    //   try key "users" → hit in 1 step
    // For "/org/acme/repo/web/issues/42":
    //   walk down 5 slashes until key "org" → hit
    // Worst case = path_depth steps, each is one lastIndexOf + one Map.get.
    let rslash = path.lastIndexOf('/');
    while (rslash >= 0) {
      const key = path.slice(1, rslash); // e.g. "resource/50"
      const candidates = this.prefixIndex.get(key);
      if (candidates) {
        const len = candidates.length;
        for (let i = 0; i < len; i++) {
          const r = candidates[i].exec(path);
          if (r) return r;
        }
      }
      if (rslash === 0) break;
      rslash = path.lastIndexOf('/', rslash - 1);
    }

    // ── 3. Recursive trie — complex patterns only (optional, regex) ──────────
    if (this.hasComplexPatterns) {
      const params: Record<string, string> = Object.create(null);
      return execTrie(this.trieRoot, splitPath(path), 0, params);
    }
    return null;
  }
}


/* ================================================================== */
/*  Layer                                                             */
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
    this.isErrorHandler = fn.length >= 4;
  }

  handleRequest(req: any, res: BlazeResponse, next: NextFunction): void {
    try {
      const result = this.handle(req, res, next) as unknown;
      if (result !== null && result !== undefined && typeof (result as any).then === 'function') {
        (result as Promise<void>).catch(next);
      }
    } catch (err) { next(err); }
  }

  handleError(err: unknown, req: any, res: BlazeResponse, next: NextFunction): void {
    try {
      const result = this.handle(err, req, res, next) as unknown;
      if (result !== null && result !== undefined && typeof (result as any).then === 'function') {
        (result as Promise<void>).catch(next);
      }
    } catch (e) { next(e); }
  }
}

/* ================================================================== */
/*  Route — consolidated per-pattern, switch-table method dispatch    */
/* ================================================================== */

export class Route {
  path: string;
  private _GET:    Function[] | null = null;
  private _POST:   Function[] | null = null;
  private _PUT:    Function[] | null = null;
  private _PATCH:  Function[] | null = null;
  private _DELETE: Function[] | null = null;
  private _ALL:    Function[] | null = null;
  private _other:  Map<string, Function[]> | null = null;

  constructor(path: string) { this.path = normalizePath(path); }

  hasMethod(method: string): boolean { return this._resolve(method) !== null; }

  addHandlers(method: string, fns: Function[]): void {
    switch (method) {
      case 'GET':    this._GET    = this._GET    ? [...this._GET,    ...fns] : [...fns]; break;
      case 'POST':   this._POST   = this._POST   ? [...this._POST,   ...fns] : [...fns]; break;
      case 'PUT':    this._PUT    = this._PUT    ? [...this._PUT,    ...fns] : [...fns]; break;
      case 'PATCH':  this._PATCH  = this._PATCH  ? [...this._PATCH,  ...fns] : [...fns]; break;
      case 'DELETE': this._DELETE = this._DELETE ? [...this._DELETE, ...fns] : [...fns]; break;
      case 'ALL':    this._ALL    = this._ALL    ? [...this._ALL,    ...fns] : [...fns]; break;
      default: {
        if (!this._other) this._other = new Map();
        const ex = this._other.get(method);
        if (ex) ex.push(...fns); else this._other.set(method, [...fns]);
      }
    }
  }

  private _resolve(method: string): Function[] | null {
    switch (method) {
      case 'GET':    return this._GET    ?? this._ALL;
      case 'POST':   return this._POST   ?? this._ALL;
      case 'PUT':    return this._PUT    ?? this._ALL;
      case 'PATCH':  return this._PATCH  ?? this._ALL;
      case 'DELETE': return this._DELETE ?? this._ALL;
      case 'ALL':    return this._ALL;
      default:       return (this._other?.get(method)) ?? this._ALL;
    }
  }

  dispatch(req: any, res: BlazeResponse, done: NextFunction): void {
    const handlers = this._resolve(req.method);
    if (!handlers) { done(); return; }
    const len = handlers.length;
    if (len === 0) { done(); return; }

    // Single-handler fast path — no closure, no loop
    if (len === 1) {
      try {
        const result = handlers[0](req, res, done) as unknown;
        if (result !== null && result !== undefined && typeof (result as any).then === 'function') {
          (result as Promise<void>).catch(done);
        }
      } catch (e) { done(e); }
      return;
    }

    let idx = 0;
    const next = (err?: unknown): void => {
      if (err) { done(err); return; }
      if (idx >= len) { done(); return; }
      try {
        const result = handlers[idx++](req, res, next) as unknown;
        if (result !== null && result !== undefined && typeof (result as any).then === 'function') {
          (result as Promise<void>).catch(done);
        }
      } catch (e) { done(e); }
    };
    next();
  }

  get(...fns: Function[]): this    { this.addHandlers('GET',    fns); return this; }
  post(...fns: Function[]): this   { this.addHandlers('POST',   fns); return this; }
  put(...fns: Function[]): this    { this.addHandlers('PUT',    fns); return this; }
  patch(...fns: Function[]): this  { this.addHandlers('PATCH',  fns); return this; }
  delete(...fns: Function[]): this { this.addHandlers('DELETE', fns); return this; }
  all(...fns: Function[]): this    { this.addHandlers('ALL',    fns); return this; }
}

/* ================================================================== */
/*  Router                                                            */
/* ================================================================== */

export class Router<E = Record<string, unknown>> {
  private stack: Layer[] = [];
  private trie = new TrieRouter();

  /**
   * Route consolidation registry: pattern → Route
   * When the same pattern is registered with different methods
   * (e.g., GET /users/:id and DELETE /users/:id), they share ONE Route object
   * and ONE layer in the stack. This halves the layer scan and avoids duplicate
   * trie entries.
   */
  private routeRegistry = new Map<string, Route>();

  /**
   * No-middleware fast path flag.
   * When true, handle() skips the stack scan entirely and does:
   *   trie.match(path) → routeRegistry.get(pattern) → route.dispatch()
   * = 1 char-indexed lookup + 1 Map.get + dispatch. Zero stack iteration.
   */
  private _noMiddleware = true;

  /** Error handlers for the no-middleware fast path */
  private _errorHandlers: Layer[] = [];

  use(
    pathOrHandler: string | Middleware<E> | Router<unknown>,
    ...handlers: Array<Middleware<E> | Router<unknown>>
  ): this {
    this._noMiddleware = false; // any middleware disables the fast path
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
        const sub = fn;
        this.stack.push(new Layer(mountPath, (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => {
          sub.handle(req, res, next);
        }));
      } else {
        this.stack.push(new Layer(mountPath, fn as Function));
      }
    }
    return this;
  }

  get(path: string, ...fns: Handler<E>[]): this    { return this._addRoute('GET',    path, fns); }
  post(path: string, ...fns: Handler<E>[]): this   { return this._addRoute('POST',   path, fns); }
  put(path: string, ...fns: Handler<E>[]): this    { return this._addRoute('PUT',    path, fns); }
  patch(path: string, ...fns: Handler<E>[]): this  { return this._addRoute('PATCH',  path, fns); }
  delete(path: string, ...fns: Handler<E>[]): this { return this._addRoute('DELETE', path, fns); }
  all(path: string, ...fns: Handler<E>[]): this    { return this._addRoute('ALL',    path, fns); }

  route(path: string): Route {
    const normalised = normalizePath(path);
    let routeObj = this.routeRegistry.get(normalised);
    if (!routeObj) {
      routeObj = new Route(normalised);
      this.routeRegistry.set(normalised, routeObj);
      this.stack.push(new Layer(normalised,
        (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => routeObj!.dispatch(req, res, next),
        routeObj,
      ));
      this.trie.insert(normalised);
    }
    return routeObj;
  }

  onError(fn: ErrorHandler<E>): this {
    const layer = new Layer('/', fn as Function);
    layer.isErrorHandler = true;
    this._errorHandlers.push(layer);
    this.stack.push(layer);
    return this;
  }

  handle(req: BlazeRequest<E>, res: BlazeResponse, done: NextFunction): void {
    // ── Ultra-fast no-middleware path ─────────────────────────────────────────
    // When no middleware is registered, skip the stack scan entirely.
    // Execution: charIndex lookup → Map.get → switch → handler call.
    if (this._noMiddleware) {
      const match = this.trie.match(req.path);
      if (!match) { done(); return; }
      const routeObj = this.routeRegistry.get(match.pattern);
      if (!routeObj || !routeObj.hasMethod(req.method)) { done(); return; }
      req.params = match.params;
      routeObj.dispatch(req as any, res, (err?: unknown) => {
        if (err && this._errorHandlers.length) {
          let ei = 0;
          const errNext = (e?: unknown): void => {
            if (!e || ei >= this._errorHandlers.length) { done(e); return; }
            this._errorHandlers[ei++].handleError(e, req as any, res, errNext);
          };
          errNext(err);
        } else {
          done(err);
        }
      });
      return;
    }

    // ── Full iterative path (middleware present) ───────────────────────────────
    const stack = this.stack;
    const stackLen = stack.length;
    let idx = 0;

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
      if (res.headersSent) return;

      while (idx < stackLen) {
        const layer = stack[idx++];

        if (layer.route) {
          const trieResult = matchTrie();
          if (!trieResult) continue;
          if (layer.path !== trieResult.pattern) continue;
          if (!layer.route.hasMethod(req.method)) continue;

          const prevParams = req.params;
          req.params = trieResult.params;
          if (err) { req.params = prevParams; continue; }

          layer.route.dispatch(req as any, res, (routeErr?: unknown) => {
            req.params = prevParams;
            next(routeErr);
          });
          return;
        }

        // Middleware layer
        if (!prefixMatch(layer.path, req.path)) continue;
        if (err) {
          if (layer.isErrorHandler) { layer.handleError(err, req as any, res, next); return; }
          continue;
        }
        if (layer.isErrorHandler) continue;

        if (layer.path !== '/' && layer.path.length > 0) {
          const prevPath = req.path;
          const prevBase = req.baseUrl;
          req.path = prevPath.slice(layer.path.length) || '/';
          req.baseUrl = prevBase + layer.path;
          layer.handleRequest(req as any, res, (layerErr?: unknown) => {
            req.path = prevPath;
            req.baseUrl = prevBase;
            next(layerErr);
          });
        } else {
          layer.handleRequest(req as any, res, next);
        }
        return;
      }

      done(err);
    };

    next();
  }

  private _addRoute(method: string, path: string, fns: Handler<E>[]): this {
    const normalised = normalizePath(path);

    // Route consolidation: reuse existing Route object for same pattern
    let routeObj = this.routeRegistry.get(normalised);
    if (!routeObj) {
      routeObj = new Route(normalised);
      this.routeRegistry.set(normalised, routeObj);
      this.stack.push(new Layer(
        normalised,
        (req: BlazeRequest<E>, res: BlazeResponse, next: NextFunction) => routeObj!.dispatch(req, res, next),
        routeObj,
      ));
      this.trie.insert(normalised);
    }

    routeObj.addHandlers(method, fns as Function[]);
    return this;
  }
}

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */

function normalizePath(path: string): string {
  if (!path || path === '/') return '/';
  let p = path.charCodeAt(0) !== 47 ? `/${path}` : path;
  if (p.length > 1 && p.charCodeAt(p.length - 1) === 47) p = p.slice(0, -1);
  return p;
}

function prefixMatch(prefix: string, requestPath: string): boolean {
  if (prefix === '/') return true;
  const pLen = prefix.length;
  if (requestPath.length < pLen) return false;
  if (!requestPath.startsWith(prefix)) return false;
  return requestPath.length === pLen || requestPath.charCodeAt(pLen) === 47;
}

function parseSegment(raw: string): { kind: 'static' | 'param' | 'wildcard'; value: string; optional: boolean; constraint: RegExp | null } {
  if (raw === '*') return { kind: 'wildcard', value: '*', optional: false, constraint: null };
  if (raw.charCodeAt(0) === 58) {
    let name = raw.slice(1);
    let optional = false;
    let constraint: RegExp | null = null;
    const cm = name.match(/^(\w+)\((.+)\)$/);
    if (cm) { name = cm[1]; constraint = new RegExp(`^${cm[2]}$`); }
    if (name.charCodeAt(name.length - 1) === 63) { name = name.slice(0, -1); optional = true; }
    return { kind: 'param', value: name, optional, constraint };
  }
  return { kind: 'static', value: raw, optional: false, constraint: null };
}
