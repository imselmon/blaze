# 🔥 Blaze

**Express-style Web Framework for Cloudflare Workers**

> Zero dependencies · Cloudflare-native · Fully typed · O(log n) Router

Blaze is a lightweight, Express-style web framework purpose-built for Cloudflare Workers. It combines the familiar ergonomics of Express — `(req, res, next)` middleware, `Router`, and route chaining — with first-class support for every Cloudflare primitive: KV, D1, R2, Durable Objects, Queues, AI, and the `ExecutionContext`.

## Why Blaze?

Unlike Hono, which wraps everything in a custom `Context` object, Blaze enriches the standard Web Platform `Request` and `Response` objects and injects Cloudflare bindings directly onto a typed `env` object accessible from any handler. 

- **Express Parity**: Drop-in compatible with thousands of existing Express middleware packages.
- **CF-Native Bindings**: `req.env.KV`, `req.env.DB`, `req.ctx.waitUntil()`.
- **Zero Dependencies**: Core framework ships with no npm dependencies.
- **Performance**: Hand-rolled TrieRouter provides `O(log n)` matching. Smaller bundle than Hono at equivalent feature set.
- **Composability**: Sub-routers, middleware-level error boundaries, and per-route middleware stacks compose beautifully.

## Installation

```bash
npm install blaze
```

## Quick Start

```typescript
import { createApp } from 'blaze'

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
import { cors } from 'blaze/middleware/cors'
import { logger } from 'blaze/middleware/logger'
import { rateLimit } from 'blaze/middleware/rate-limit'

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
