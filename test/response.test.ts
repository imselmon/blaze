import { describe, it, expect, vi } from 'vitest';
import { BlazeResponse } from '../src/response.js';

describe('BlazeResponse', () => {
  it('resolves json() properly', async () => {
    const promise = new Promise<Response>((resolve) => {
      const res = new BlazeResponse(resolve);
      res.status(201).json({ success: true });
    });
    
    const response = await promise;
    expect(response.status).toBe(201);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    
    const body = await response.json();
    expect(body).toEqual({ success: true });
  });

  it('resolves html() properly', async () => {
    const promise = new Promise<Response>((resolve) => {
      const res = new BlazeResponse(resolve);
      res.html('<h1>Hello</h1>');
    });
    
    const response = await promise;
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    
    const text = await response.text();
    expect(text).toBe('<h1>Hello</h1>');
  });

  it('supports cookies and headers', async () => {
    const promise = new Promise<Response>((resolve) => {
      const res = new BlazeResponse(resolve);
      res.header('X-Custom', '123').cookie('session', 'abc', { httpOnly: true, secure: true }).send('OK');
    });
    
    const response = await promise;
    expect(response.headers.get('X-Custom')).toBe('123');
    expect(response.headers.get('Set-Cookie')).toBe('session=abc; HttpOnly; Secure');
  });

  it('supports the onSend hook for middleware interception', async () => {
    const promise = new Promise<Response>((resolve) => {
      const res = new BlazeResponse(resolve);
      
      // Inject a hook
      res.onSend((r) => {
        const headers = new Headers(r.headers);
        headers.set('X-Hooked', 'true');
        return new Response(r.body, { status: r.status, headers });
      });
      
      res.send('original body');
    });
    
    const response = await promise;
    expect(response.headers.get('X-Hooked')).toBe('true');
  });
});
