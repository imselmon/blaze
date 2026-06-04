import { describe, it, expect } from 'vitest';
import { BlazeRequest } from '../src/request.js';

describe('BlazeRequest', () => {
  it('parses JSON bodies', async () => {
    const raw = new Request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify({ name: 'Blaze' }),
      headers: { 'Content-Type': 'application/json' },
    });
    
    const req = new BlazeRequest(raw, {}, {} as ExecutionContext);
    const body = await req.json();
    
    expect(body).toEqual({ name: 'Blaze' });
    
    // Test cache: calling it again should work
    const body2 = await req.json();
    expect(body2).toEqual({ name: 'Blaze' });
  });

  it('parses text bodies', async () => {
    const raw = new Request('http://localhost/', {
      method: 'POST',
      body: 'Hello Blaze',
    });
    
    const req = new BlazeRequest(raw, {}, {} as ExecutionContext);
    const text = await req.text();
    
    expect(text).toBe('Hello Blaze');
  });

  it('identifies content types with .is()', () => {
    const raw = new Request('http://localhost/', {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    const req = new BlazeRequest(raw, {}, {} as ExecutionContext);
    
    expect(req.is('json')).toBe(true);
    expect(req.is('html')).toBe(false);
  });

  it('extracts IP from CF-Connecting-IP', () => {
    const raw = new Request('http://localhost/', {
      headers: { 'CF-Connecting-IP': '192.168.1.1' },
    });
    const req = new BlazeRequest(raw, {}, {} as ExecutionContext);
    
    expect(req.ip).toBe('192.168.1.1');
  });

  it('performs content negotiation with .accepts()', () => {
    const raw = new Request('http://localhost/', {
      headers: { 'Accept': 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8' },
    });
    const req = new BlazeRequest(raw, {}, {} as ExecutionContext);
    
    expect(req.accepts(['json', 'html'])).toBe('html');
    expect(req.accepts(['image/png', 'application/xml'])).toBe('application/xml');
  });
});
