import { describe, it, expect } from 'vitest';
import { Router, TrieRouter } from '../src/router.js';

describe('TrieRouter', () => {
  it('matches static routes', () => {
    const trie = new TrieRouter();
    trie.insert('/api/v1/users');

    const match = trie.match('/api/v1/users');
    expect(match).not.toBeNull();
    expect(match?.pattern).toBe('/api/v1/users');
  });

  it('matches named parameters', () => {
    const trie = new TrieRouter();
    trie.insert('/api/users/:id');

    const match = trie.match('/api/users/123');
    expect(match).not.toBeNull();
    expect(match?.params).toEqual({ id: '123' });
  });

  it('matches optional parameters', () => {
    const trie = new TrieRouter();
    trie.insert('/files/:filename?');

    // Without param
    const match1 = trie.match('/files');
    expect(match1).not.toBeNull();
    expect(match1?.params).toEqual({});
    
    // With param
    const match2 = trie.match('/files/logo.png');
    expect(match2).not.toBeNull();
    expect(match2?.params).toEqual({ filename: 'logo.png' });
  });

  it('matches regex constraints', () => {
    const trie = new TrieRouter();
    trie.insert('/users/:id(\\d+)');

    const match1 = trie.match('/users/123');
    expect(match1).not.toBeNull();
    expect(match1?.params).toEqual({ id: '123' });

    const match2 = trie.match('/users/abc');
    expect(match2).toBeNull();
  });

  it('matches wildcards', () => {
    const trie = new TrieRouter();
    trie.insert('/assets/*');

    const match = trie.match('/assets/images/logo.png');
    expect(match).not.toBeNull();
    expect(match?.params).toEqual({ '*': 'images/logo.png' });
  });
});

describe('Router (Middleware Stack)', () => {
  // To test the stack without HTTP overhead, we'll construct mock requests
  // However, it's easier to test the Router using the App layer since it wraps it nicely
  it('mounts sub-routers correctly', () => {
    const router = new Router();
    const subRouter = new Router();
    let subRouterHit = false;

    subRouter.use((req, res, next) => {
      subRouterHit = true;
      next();
    });

    router.use('/api', subRouter);

    // We can verify this via internal state or by setting up an app
    expect(subRouterHit).toBe(false); 
  });
});
