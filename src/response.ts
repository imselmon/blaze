import type { CookieOptions } from './types.js';

/**
 * BlazeResponse — constructed once per request with an internal `resolve`
 * callback that `app.fetch` awaits.
 *
 * Terminal methods (`json`, `send`, `html`, `redirect`, `stream`, `raw`)
 * build a `Response` and resolve the promise, mirroring Express's
 * `res.send()` semantics.
 */
export class BlazeResponse {
  /* ---- internal plumbing ---- */
  private _resolve: (response: Response) => void;
  private _headers: Headers = new Headers();
  private _status = 200;
  private _sent = false;
  private _onSendHooks: Array<(response: Response) => Response> = [];

  constructor(resolve: (response: Response) => void) {
    this._resolve = resolve;
  }

  /** `true` after any terminal method has been called. */
  get headersSent(): boolean {
    return this._sent;
  }

  /* ------------------------------------------------------------------ */
  /*  Hook for middleware that needs to transform the outgoing Response  */
  /* ------------------------------------------------------------------ */

  /**
   * Register a synchronous hook that can inspect / transform the
   * `Response` just before it is resolved back to the Workers runtime.
   *
   * Hooks run in registration order. Each receives the current Response
   * and must return a (possibly new) Response.
   */
  onSend(fn: (response: Response) => Response): void {
    this._onSendHooks.push(fn);
  }

  /** Apply hooks and resolve the response promise. */
  private _complete(response: Response): void {
    if (this._sent) return;
    this._sent = true;
    let final = response;
    for (const hook of this._onSendHooks) {
      try {
        final = hook(final);
      } catch {
        /* hooks must not break the response */
      }
    }
    this._resolve(final);
  }

  /* ------------------------------------------------------------------ */
  /*  Chainable setters                                                 */
  /* ------------------------------------------------------------------ */

  /** Set the HTTP status code. Chainable. */
  status(code: number): this {
    this._status = code;
    return this;
  }

  /** Set a response header. Chainable. */
  header(name: string, value: string): this {
    this._headers.set(name, value);
    return this;
  }

  /** Set a cookie. Chainable. */
  cookie(name: string, value: string, opts?: CookieOptions): this {
    const parts = [
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    ];
    if (opts?.domain) parts.push(`Domain=${opts.domain}`);
    if (opts?.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
    if (opts?.httpOnly) parts.push('HttpOnly');
    if (opts?.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
    if (opts?.path) parts.push(`Path=${opts.path}`);
    if (opts?.secure) parts.push('Secure');
    if (opts?.sameSite) parts.push(`SameSite=${opts.sameSite}`);
    if (opts?.partitioned) parts.push('Partitioned');
    this._headers.append('Set-Cookie', parts.join('; '));
    return this;
  }

  /** Append to the `Vary` response header. Chainable. */
  vary(field: string): this {
    const existing = this._headers.get('Vary');
    if (existing) {
      const fields = existing.split(',').map((f) => f.trim().toLowerCase());
      if (!fields.includes(field.toLowerCase())) {
        this._headers.set('Vary', `${existing}, ${field}`);
      }
    } else {
      this._headers.set('Vary', field);
    }
    return this;
  }

  /** Set `Content-Type` by shorthand or full MIME string. Chainable. */
  type(mime: string): this {
    const map: Record<string, string> = {
      json: 'application/json',
      html: 'text/html',
      text: 'text/plain',
      xml: 'application/xml',
      form: 'application/x-www-form-urlencoded',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      css: 'text/css',
      js: 'application/javascript',
      pdf: 'application/pdf',
      zip: 'application/zip',
      mp4: 'video/mp4',
      webp: 'image/webp',
    };
    this._headers.set('Content-Type', map[mime] || mime);
    return this;
  }

  /* ------------------------------------------------------------------ */
  /*  Terminal methods — each resolves the response promise exactly once */
  /* ------------------------------------------------------------------ */

  /** Respond with JSON. Sets `Content-Type: application/json`. */
  json(data: unknown, status?: number): void {
    if (status !== undefined) this._status = status;
    this._headers.set('Content-Type', 'application/json; charset=utf-8');
    this._complete(
      new Response(JSON.stringify(data), {
        status: this._status,
        headers: this._headers,
      }),
    );
  }

  /**
   * Respond with text or buffer. Auto-detects `Content-Type` when not
   * already set.
   */
  send(body?: BodyInit | null, status?: number): void {
    if (status !== undefined) this._status = status;

    if (!this._headers.has('Content-Type') && body != null) {
      if (typeof body === 'string') {
        this._headers.set('Content-Type', 'text/plain; charset=utf-8');
      } else {
        this._headers.set('Content-Type', 'application/octet-stream');
      }
    }

    this._complete(
      new Response(body ?? null, {
        status: this._status,
        headers: this._headers,
      }),
    );
  }

  /** Respond with `Content-Type: text/html`. */
  html(markup: string, status?: number): void {
    if (status !== undefined) this._status = status;
    this._headers.set('Content-Type', 'text/html; charset=utf-8');
    this._complete(
      new Response(markup, {
        status: this._status,
        headers: this._headers,
      }),
    );
  }

  /** Issue a redirect (default 302). */
  redirect(url: string, status?: number): void {
    this._status = status ?? 302;
    this._headers.set('Location', url);
    this._complete(
      new Response(null, {
        status: this._status,
        headers: this._headers,
      }),
    );
  }

  /**
   * Streaming response.
   *
   * `fn` receives a `WritableStream`. Write to it and close when done.
   * The response begins sending immediately.
   */
  stream(
    fn: (writable: WritableStream) => void | Promise<void>,
    status?: number,
  ): void {
    if (status !== undefined) this._status = status;

    const { readable, writable } = new TransformStream();

    this._complete(
      new Response(readable, {
        status: this._status,
        headers: this._headers,
      }),
    );

    // Fire-and-forget — errors should be handled by the caller
    Promise.resolve(fn(writable)).catch(() => {
      try {
        writable.close();
      } catch {
        /* already closed */
      }
    });
  }

  /** Pass through a raw `Response` from e.g. a Durable Object fetch. */
  raw(response: Response): void {
    this._complete(response);
  }
}
