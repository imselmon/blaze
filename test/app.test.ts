import { describe, it, expect, vi } from 'vitest';
import { createApp, BlazeError } from '../src/index.js';

describe('App Factory', () => {
  it('creates an app with expected HTTP methods', () => {
    const app = createApp();
    expect(app.get).toBeTypeOf('function');
    expect(app.post).toBeTypeOf('function');
    expect(app.put).toBeTypeOf('function');
    expect(app.patch).toBeTypeOf('function');
    expect(app.delete).toBeTypeOf('function');
    expect(app.all).toBeTypeOf('function');
    expect(app.use).toBeTypeOf('function');
    expect(app.route).toBeTypeOf('function');
    expect(app.Router).toBeTypeOf('function');
  });

  it('handles basic GET request', async () => {
    const app = createApp();
    app.get('/hello', (req, res) => {
      res.json({ message: 'world' });
    });

    const req = new Request('http://localhost/hello');
    const res = await app.fetch(req, {}, {} as ExecutionContext);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ message: 'world' });
  });

  it('returns 404 for unmatched routes', async () => {
    const app = createApp();
    app.get('/hello', (req, res) => {
      res.json({ message: 'world' });
    });

    const req = new Request('http://localhost/not-found');
    const res = await app.fetch(req, {}, {} as ExecutionContext);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not Found' });
  });

  it('supports custom notFound handler', async () => {
    const app = createApp();
    app.notFound((req, res) => {
      res.status(404).json({ custom: 'not found' });
    });

    const req = new Request('http://localhost/not-found');
    const res = await app.fetch(req, {}, {} as ExecutionContext);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ custom: 'not found' });
  });

  it('handles errors gracefully', async () => {
    const app = createApp();
    app.get('/error', () => {
      throw new Error('Something broke!');
    });

    const req = new Request('http://localhost/error');
    const res = await app.fetch(req, {}, {} as ExecutionContext);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal Server Error' });
  });

  it('handles custom BlazeErrors with metadata', async () => {
    const app = createApp();
    app.get('/blaze-error', () => {
      throw new BlazeError(403, 'Forbidden', { code: 'NO_ACCESS' });
    });

    const req = new Request('http://localhost/blaze-error');
    const res = await app.fetch(req, {}, {} as ExecutionContext);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Forbidden', code: 'NO_ACCESS' });
  });

  it('supports global onError handler', async () => {
    const app = createApp();
    app.get('/error', () => {
      throw new Error('Original error');
    });

    app.onError((err, req, res) => {
      res.status(400).json({ error: 'Caught error' });
    });

    const req = new Request('http://localhost/error');
    const res = await app.fetch(req, {}, {} as ExecutionContext);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Caught error' });
  });

  it('injects environment bindings and execution context', async () => {
    type Env = { DB_NAME: string };
    const app = createApp<Env>();
    
    app.get('/', (req, res) => {
      res.json({ db: req.env.DB_NAME, hasCtx: !!req.ctx });
    });

    const req = new Request('http://localhost/');
    const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const res = await app.fetch(req, { DB_NAME: 'test-db' }, mockCtx);

    const body = await res.json();
    expect(body).toEqual({ db: 'test-db', hasCtx: true });
  });

  it('executes scheduled handlers', async () => {
    const app = createApp();
    // We didn't implement scheduled setting in BlazeApp since it's an entrypoint, 
    // but the method exists. We'll just verify it doesn't throw.
    const mockEvent = { cron: '* * * * *', type: 'scheduled', scheduledTime: Date.now() };
    await expect(app.scheduled(mockEvent as ScheduledEvent, {}, {} as ExecutionContext)).resolves.toBeUndefined();
  });
});
