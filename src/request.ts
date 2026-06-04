/**
 * BlazeRequest — wraps the standard Web Platform `Request`.
 *
 * PERF: All expensive parsing (URL, query params) is lazy. Path is extracted
 * with a cheap indexOf slice instead of `new URL()`.
 */
export class BlazeRequest<E = Record<string, unknown>> {
  readonly raw: Request;
  env: E;
  ctx: ExecutionContext;
  params: Record<string, string>;
  path: string;
  baseUrl: string;
  id: string;
  /** HTTP method — uppercased and cached at construction. */
  readonly method: string;

  private _url: URL | null = null;
  private _query: URLSearchParams | null = null;
  private _bodyCache: ArrayBuffer | null = null;

  constructor(request: Request, env: E, ctx: ExecutionContext) {
    this.raw     = request;
    this.env     = env;
    this.ctx     = ctx;
    // Cache method uppercased — avoids string allocation on every layer check
    this.method  = request.method.toUpperCase();
    this.params  = {};
    this.baseUrl = '';
    this.id      = '';

    // Extract path without full URL parse
    const raw  = request.url;
    const si   = raw.indexOf('/', raw.indexOf('//') + 2); // start of path
    const qi   = raw.indexOf('?', si);                    // query start
    this.path  = si === -1 ? '/' : (qi === -1 ? raw.slice(si) : raw.slice(si, qi)) || '/';
  }

  private get _parsedUrl(): URL {
    if (!this._url) this._url = new URL(this.raw.url);
    return this._url;
  }

  get query(): URLSearchParams {
    if (!this._query) this._query = this._parsedUrl.searchParams;
    return this._query;
  }

  get url(): string   { return this.raw.url; }
  get headers(): Headers { return this.raw.headers; }

  get ip(): string {
    return (
      this.raw.headers.get('CF-Connecting-IP') ||
      this.raw.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
      ''
    );
  }

  get cf(): IncomingRequestCfProperties | undefined {
    return (this.raw as unknown as { cf?: IncomingRequestCfProperties }).cf;
  }

  header(name: string): string | null {
    return this.raw.headers.get(name);
  }

  accepts(types: string | string[]): string | false {
    const accept = this.raw.headers.get('Accept') || '*/*';
    const candidates = Array.isArray(types) ? types : [types];

    const expand = (t: string): string => {
      switch (t) {
        case 'json': return 'application/json';
        case 'html': return 'text/html';
        case 'text': return 'text/plain';
        case 'xml':  return 'application/xml';
        case 'form': return 'application/x-www-form-urlencoded';
        default:     return t;
      }
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
        const ec = expand(candidate);
        if (acceptedType === '*/*' || acceptedType === ec) return candidate;
        const si   = acceptedType.indexOf('/');
        const ci   = ec.indexOf('/');
        const mainA = si === -1 ? acceptedType : acceptedType.slice(0, si);
        const subA  = si === -1 ? '' : acceptedType.slice(si + 1);
        const mainC = ci === -1 ? ec : ec.slice(0, ci);
        if (mainA === mainC && (subA === '*' || subA === ec.slice(ci + 1))) return candidate;
      }
    }

    return false;
  }

  is(type: string): boolean {
    const ct = (this.raw.headers.get('Content-Type') || '').toLowerCase();
    switch (type) {
      case 'json': return ct.includes('application/json');
      case 'form': return ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data');
      case 'text': return ct.startsWith('text/');
      case 'html': return ct.includes('text/html');
      case 'xml':  return ct.includes('application/xml') || ct.includes('text/xml');
      default:     return ct.includes(type.toLowerCase());
    }
  }

  private async _readBody(): Promise<ArrayBuffer> {
    if (this._bodyCache !== null) return this._bodyCache;
    this._bodyCache = await this.raw.arrayBuffer();
    return this._bodyCache;
  }

  async json<T = unknown>(): Promise<T> {
    const buf = await this._readBody();
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  }

  async text(): Promise<string> {
    const buf = await this._readBody();
    return new TextDecoder().decode(buf);
  }

  async formData(): Promise<FormData> {
    const buf = await this._readBody();
    return new Request(this.raw.url, { method: this.raw.method, headers: this.raw.headers, body: buf }).formData();
  }

  async arrayBuffer(): Promise<ArrayBuffer> { return this._readBody(); }

  async blob(): Promise<Blob> {
    const buf = await this._readBody();
    return new Blob([buf], { type: this.raw.headers.get('Content-Type') || '' });
  }
}
