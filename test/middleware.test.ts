import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { cors } from '../src/middleware/cors.js';
import { requestId } from '../src/middleware/request-id.js';

describe('Middleware', () => {
  it('cors sets appropriate headers', async () => {
    const app = createApp();
    app.use(cors({ origins: ['https://example.com'], credentials: true }));
    app.get('/', (req, res) => res.send('OK'));

    const req = new Request('http://localhost/', {
      headers: { Origin: 'https://example.com' }
    });
    const res = await app.fetch(req, {}, {} as ExecutionContext);
    
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('request-id generates UUIDs', async () => {
    const app = createApp();
    app.use(requestId());
    app.get('/', (req, res) => res.json({ id: req.id }));

    const req = new Request('http://localhost/');
    const res = await app.fetch(req, {}, {} as ExecutionContext);
    
    expect(res.headers.has('X-Request-Id')).toBe(true);
    const body = await res.json() as any;
    expect(body.id).toBeTruthy();
    expect(body.id).toBe(res.headers.get('X-Request-Id'));
  });

  it('request-id reuses existing header', async () => {
    const app = createApp();
    app.use(requestId());
    app.get('/', (req, res) => res.json({ id: req.id }));

    const req = new Request('http://localhost/', {
      headers: { 'X-Request-Id': 'custom-id-123' }
    });
    const res = await app.fetch(req, {}, {} as ExecutionContext);
    
    expect(res.headers.get('X-Request-Id')).toBe('custom-id-123');
  });
});
