# 🔥 Blaze

**Express-style Web Framework for Cloudflare Workers**

> Zero dependencies · Cloudflare-native · Fully typed · O(log n) Router

Blaze is a lightweight, Express-style web framework purpose-built for Cloudflare Workers. It combines the familiar ergonomics of Express — `(req, res, next)` middleware, `Router`, and route chaining — with first-class support for every Cloudflare primitive: KV, D1, R2, Durable Objects, Queues, AI, and the `ExecutionContext`.

## Features

- **Ultrafast** 🚀 - Blaze's hand-rolled TrieRouter uses an O(1) character index and precompiled parametric routes to ensure minimal cold starts and zero linear scanning overhead.
- **Lightweight** 🪶 - Zero npm dependencies. Built entirely on the Web Standard API, resulting in an exceptionally small bundle size.
- **Cloudflare Native** 🌍 - Built from the ground up specifically for Cloudflare Workers. Direct, first-class access to KV, D1, R2, AI, Durable Objects, and native `ExecutionContext`.
- **Batteries Included** 🔋 - Ships with 12 built-in, tree-shakeable middleware modules including JWT auth, KV rate limiting, CORS, and caching. No need to install extra packages.
- **Delightful DX** 😃 - Familiar Express-style `(req, res, next)` API with first-class TypeScript support. Enjoy strongly-typed environments, params, and middleware out of the box.

## Why Blaze?

Unlike Hono, which wraps everything in a custom `Context` object, Blaze enriches the standard Web Platform `Request` and `Response` objects and injects Cloudflare bindings directly onto a typed `env` object accessible from any handler. 

- **Express Parity**: Drop-in compatible with thousands of existing Express middleware packages.
- **CF-Native Bindings**: `req.env.KV`, `req.env.DB`, `req.ctx.waitUntil()`.
- **Zero Dependencies**: Core framework ships with no npm dependencies.
- **Performance**: Hand-rolled TrieRouter provides `O(log n)` matching. Smaller bundle than Hono at equivalent feature set.
- **Composability**: Sub-routers, middleware-level error boundaries, and per-route middleware stacks compose beautifully.

## Installation

### 1. Scaffold a new project (Recommended)

The easiest way to start with Blaze is using the official CLI scaffolder. It will set up a fully typed Cloudflare Workers project, complete with Wrangler configuration and example routes:

```bash
npm create blazefw-app@latest
# or
npx create-blazefw-app@latest
```

### 2. Manual Installation

If you're adding Blaze to an existing project:

```bash
npm install blazefw
```

## Quick Start

```typescript
import { createApp } from 'blazefw'

// Define your Cloudflare bindings
type Env = {
  DB: D1Database
  KV: KVNamespace
}

const app = createApp<Env>()

app.get('/', (req, res) => {
  res.json({ hello: 'world' })
})

app.get('/users/:id', async (req, res) => {
  const user = await req.env.DB
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(req.params.id)
    .first()

  if (!user) return res.status(404).json({ error: 'Not found' })

  res.json(user)
})

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  scheduled: app.scheduled
}
```

## Middleware

Blaze includes 12 built-in, tree-shakeable middleware modules optimized for Cloudflare Workers:

- `cors`: Handles CORS preflight and headers
- `logger`: Logs requests and durations
- `bearer-auth`: Validates static or dynamic bearer tokens
- `basic-auth`: Validates HTTP Basic Auth
- `jwt`: Web Crypto JWT validation (HS256, RS256)
- `rate-limit`: KV-backed sliding window rate limiter
- `cache`: Cloudflare Cache API integration
- `compress`: Gzip/Deflate compression via Streams
- `request-id`: UUID generation
- `etag`: High-speed djb2 ETag generation
- `timeout`: Request timeout handler
- `secure-headers`: CSP, HSTS, and standard security headers

Usage example:

```typescript
import { cors } from 'blazefw/middleware/cors'
import { logger } from 'blazefw/middleware/logger'
import { rateLimit } from 'blazefw/middleware/rate-limit'

app.use(logger())
app.use(cors({ origins: '*' }))
app.use('/api', rateLimit({
  kvBinding: (req) => req.env.KV,
  limit: 100,
  window: 60
}))
```

## License

MIT
