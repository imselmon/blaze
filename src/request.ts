/**
 * BlazeRequest — wraps the standard Web Platform `Request` and adds
 * Blaze-specific properties for Cloudflare Workers.
 *
 * Constructed once per request inside `app.fetch` and passed through
 * the entire middleware chain by reference.
 */
export class BlazeRequest<E = Record<string, unknown>> {
  /** The original, unmodified `Request` from the Workers runtime. */
  readonly raw: Request;

  /** Typed Cloudflare bindings from `wrangler.toml`. */
  env: E;

  /** Cloudflare `ExecutionContext` — use `req.ctx.waitUntil()` for background work. */
  ctx: ExecutionContext;

  /** Route parameters extracted by the TrieRouter. */
  params: Record<string, string>;

  /** Parsed URL search parameters. */
  query: URLSearchParams;

  /** Current routing path — adjusted by sub-router mounts. */
  path: string;

  /** Accumulated base URL from sub-router mounting. */
  baseUrl: string;

  /** Request ID set by the `requestId` middleware. */
  id: string;

  /* ---- internal ---- */
  private _parsedUrl: URL;
  private _bodyCache: ArrayBuffer | null = null;

  constructor(request: Request, env: E, ctx: ExecutionContext) {
    this.raw = request;
    this.env = env;
    this.ctx = ctx;
    this._parsedUrl = new URL(request.url);
    this.path = this._parsedUrl.pathname;
    this.query = this._parsedUrl.searchParams;
    this.params = {};
    this.baseUrl = '';
    this.id = '';
  }

  /* ------------------------------------------------------------------ */
  /*  Standard Request delegates                                        */
  /* ------------------------------------------------------------------ */

  /** HTTP method (GET, POST, …). */
  get method(): string {
    return this.raw.method;
  }

  /** Full request URL string. */
  get url(): string {
    return this.raw.url;
  }

  /** Request headers. */
  get headers(): Headers {
    return this.raw.headers;
  }

  /* ------------------------------------------------------------------ */
  /*  Cloudflare-specific metadata                                      */
  /* ------------------------------------------------------------------ */

  /** Client IP from the `CF-Connecting-IP` header. */
  get ip(): string {
    return (
      this.raw.headers.get('CF-Connecting-IP') ||
      this.raw.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
      ''
    );
  }

  /**
   * Cloudflare request metadata (country, datacenter, colo, etc.).
   * Only available when running on the Workers runtime.
   */
  get cf(): IncomingRequestCfProperties | undefined {
    return (this.raw as unknown as { cf?: IncomingRequestCfProperties }).cf;
  }

  /* ------------------------------------------------------------------ */
  /*  Header helpers                                                    */
  /* ------------------------------------------------------------------ */

  /** Case-insensitive header lookup. */
  header(name: string): string | null {
    return this.raw.headers.get(name);
  }

  /**
   * Content negotiation — returns the best match from `types` against
   * the request `Accept` header, or `false` if none match.
   */
  accepts(types: string | string[]): string | false {
    const accept = this.raw.headers.get('Accept') || '*/*';
    const candidates = Array.isArray(types) ? types : [types];

    // Helper to map shorthand types
    const expand = (t: string) => {
      const map: Record<string, string> = {
        json: 'application/json',
        html: 'text/html',
        text: 'text/plain',
        xml: 'application/xml',
        form: 'application/x-www-form-urlencoded',
        png: 'image/png',
      };
      return map[t] || t;
    };

    const parsed = accept
      .split(',')
      .map((part) => {
        const [mediaType, ...params] = part.trim().split(';');
        const qParam = params.find((p) => p.trim().startsWith('q='));
        const q = qParam ? parseFloat(qParam.split('=')[1]) : 1;
        return { type: mediaType.trim(), q };
      })
      .sort((a, b) => b.q - a.q);

    for (const { type: acceptedType } of parsed) {
      for (const candidate of candidates) {
        const expandedCandidate = expand(candidate);
        if (acceptedType === '*/*' || acceptedType === expandedCandidate) {
          return candidate;
        }
        const [mainA = '', subA = ''] = acceptedType.split('/');
        const [mainC = '', subC = ''] = expandedCandidate.split('/');
        if (mainA === mainC && (subA === '*' || subA === subC)) {
          return candidate;
        }
      }
    }

    return false;
  }

  /**
   * Check the request `Content-Type`.
   *
   * Shorthand aliases: `"json"`, `"form"`, `"text"`, `"html"`, `"xml"`.
   */
  is(type: string): boolean {
    const ct = (this.raw.headers.get('Content-Type') || '').toLowerCase();
    switch (type) {
      case 'json':
        return ct.includes('application/json');
      case 'form':
        return (
          ct.includes('application/x-www-form-urlencoded') ||
          ct.includes('multipart/form-data')
        );
      case 'text':
        return ct.startsWith('text/');
      case 'html':
        return ct.includes('text/html');
      case 'xml':
        return ct.includes('application/xml') || ct.includes('text/xml');
      default:
        return ct.includes(type.toLowerCase());
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Body helpers — cached so safe to call multiple times               */
  /* ------------------------------------------------------------------ */

  private async _readBody(): Promise<ArrayBuffer> {
    if (this._bodyCache !== null) return this._bodyCache;
    this._bodyCache = await this.raw.arrayBuffer();
    return this._bodyCache;
  }

  /** Parse `application/json` body. Returns `T`. */
  async json<T = unknown>(): Promise<T> {
    const buf = await this._readBody();
    const text = new TextDecoder().decode(buf);
    return JSON.parse(text) as T;
  }

  /** Parse body as UTF-8 text. */
  async text(): Promise<string> {
    const buf = await this._readBody();
    return new TextDecoder().decode(buf);
  }

  /** Parse `multipart/form-data` or `application/x-www-form-urlencoded`. */
  async formData(): Promise<FormData> {
    const buf = await this._readBody();
    const surrogate = new Request(this.raw.url, {
      method: this.raw.method,
      headers: this.raw.headers,
      body: buf,
    });
    return surrogate.formData();
  }

  /** Returns raw `ArrayBuffer`. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this._readBody();
  }

  /** Returns `Blob`. */
  async blob(): Promise<Blob> {
    const buf = await this._readBody();
    const ct = this.raw.headers.get('Content-Type') || '';
    return new Blob([buf], { type: ct });
  }
}
