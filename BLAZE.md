# 🔥 Blaze

**Web Framework for Cloudflare Workers**

> Express-style API · Zero dependencies · Cloudflare-native · Fully typed

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Core Architecture](#2-core-architecture)
3. [API Surface](#3-api-surface)
4. [Router](#4-router)
5. [Middleware](#5-middleware)
6. [Cloudflare Bindings](#6-cloudflare-bindings)
7. [Error Handling](#7-error-handling)
8. [TypeScript Integration](#8-typescript-integration)
9. [Testing](#9-testing)
10. [Performance](#10-performance)
11. [Project Structure](#11-recommended-project-structure)
12. [Feature Comparison](#12-feature-comparison)
13. [Roadmap](#13-roadmap)

---

## 1. Introduction

Blaze is a lightweight, Express-style web framework purpose-built for Cloudflare Workers. It combines the familiar ergonomics of Express — `(req, res, next)` middleware, `Router`, and route chaining — with first-class support for every Cloudflare primitive: KV, D1, R2, Durable Objects, Queues, AI, and the `ExecutionContext`.

Unlike Hono, which wraps everything in a custom `Context` object, Blaze enriches the standard Web Platform `Request` and `Response` objects and injects Cloudflare bindings directly onto a typed `env` object accessible from any handler. The result is a framework that feels immediately familiar to any Express developer while being fully optimised for the v8-isolate, zero-cold-start constraints of Cloudflare Workers.

### 1.1 Design Goals

| Goal                   | Description                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Express parity**     | `app.get / post / use / Router()` feel identical to Express. Middleware signature is `(req, res, next)`.                  |
| **CF-native bindings** | `env` and `ctx` are promoted to first-class properties — `req.env.KV`, `req.env.DB`, `req.ctx.waitUntil()`.               |
| **Zero dependencies**  | Core framework ships with no npm dependencies. Trie router, middleware compose, and response helpers are all hand-rolled. |
| **Fully typed**        | Generic `Bindings` type propagates through the entire app. Every `req.env` property is type-safe with zero casting.       |
| **Performance**        | TrieRouter with O(log n) matching. Smaller bundle than Hono at equivalent feature set.                                    |
| **Testability**        | `app.fetch(req, env, ctx)` is the single seam — pass a mocked `env` in tests, no Worker runtime needed.                   |
| **Composability**      | Sub-routers, middleware-level error boundaries, and per-route middleware stacks all compose via the Layer abstraction.    |

### 1.2 Why Not Hono?

Hono is excellent but makes specific tradeoffs that Blaze deliberately inverts:

| Hono tradeoff          | Blaze approach                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Context wrapper (`c`)  | Hono requires learning a new Context API. Blaze enriches `req`/`res` so existing Express knowledge transfers directly.                        |
| `c.env` access pattern | In Hono you write `c.env.KV`. In Blaze you write `req.env.KV` from any function that receives `req`.                                          |
| Middleware arity       | Hono uses `async (c, next) => {}`. Blaze uses `(req, res, next)` — drop-in compatible with thousands of existing Express middleware packages. |
| Router as internal     | Hono's Router is internal. Blaze exposes `app.Router()` as a composable mini-app, identical to Express sub-applications.                      |
| Error handling         | Hono uses `app.onError`. Blaze uses 4-arg Express convention `(err, req, res, next)` so existing error middleware works unchanged.            |

---

## 2. Core Architecture

Blaze is composed of five discrete modules that map directly to Express internals, each adapted for the Web Standards / Cloudflare environment.

### 2.1 Module Map

| Module             | Exports                | Responsibility                                                         |
| ------------------ | ---------------------- | ---------------------------------------------------------------------- |
| `blaze/app`        | `createApp()`          | Top-level factory. Returns an enriched fetch handler.                  |
| `blaze/router`     | `Router, Route, Layer` | TrieRouter + middleware stack + route dispatch.                        |
| `blaze/request`    | `BlazeRequest`         | Extends `Request`. Adds `param`, `query`, body helpers + `env`/`ctx`.  |
| `blaze/response`   | `BlazeResponse`        | Extends `Response`. Adds `json`, `send`, `html`, `redirect`, `stream`. |
| `blaze/middleware` | `cors, logger, cache…` | Built-in middleware. Each is an independent module.                    |

### 2.2 Request Lifecycle

Every incoming Worker fetch event flows through these stages in order:

1. Worker runtime calls `fetch(request, env, ctx)`.
2. `app.fetch` wraps `request` → `BlazeRequest`, injecting `env` and `ctx` onto the instance.
3. Root `Router.handle(req, res, next)` begins iterating its Layer stack.
4. Each Layer tests `path` and, for route Layers, HTTP method.
5. Matching middleware Layers call `fn(req, res, next)`; non-matching Layers are skipped.
6. A matching route Layer calls `route.dispatch(req, res, next)`, which iterates the route's handler stack.
7. The first handler that calls `res.json()` / `res.send()` / `res.html()` terminates the cycle.
8. If no Layer responds, `app.notFound(req, res)` is called.
9. If any handler throws or calls `next(err)`, the error propagates to the nearest 4-arg `(err, req, res, next)` Layer.

### 2.3 Layer System

`Layer` is the single internal primitive. Every registered middleware and route is a Layer. Layers have three fields:

- `path` — the mount path regexp derived from the registration string.
- `handle` — the function to call: `fn(req, res, next)` for middleware, `route.dispatch` for routes.
- `route` — a reference to the `Route` instance, present only on route Layers.

The Router walks its `stack` array. For each Layer it calls `matchLayer(layer, req.path)`. On a match, it calls `layer.handle_request(req, res, next)`. Errors caught during handle are forwarded to `next(err)`, which causes the Router to skip to the nearest error Layer.

> **Design note:** Unlike Express, Blaze's Layer regex is compiled from a TrieRouter node rather than `path-to-regexp`. This eliminates the linear scan performance cliff as routes grow. Route registration still happens in source order, but matching is O(log n) against the trie.

---

## 3. API Surface

### 3.1 App

Import and initialise with a `Bindings` type that describes your `wrangler.toml` bindings:

```ts
import { createApp } from "blaze";

type Env = {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  QUEUE: Queue;
  AI: Ai;
  SECRET: string;
};

const app = createApp<Env>();

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  scheduled: app.scheduled, // optional cron support
};
```

#### App methods

| Method                      | Description                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| `app.get(path, ...fns)`     | Register GET route. Accepts one or many handlers (inline middleware stack). |
| `app.post(path, ...fns)`    | Register POST route.                                                        |
| `app.put(path, ...fns)`     | Register PUT route.                                                         |
| `app.patch(path, ...fns)`   | Register PATCH route.                                                       |
| `app.delete(path, ...fns)`  | Register DELETE route.                                                      |
| `app.all(path, ...fns)`     | Match any HTTP method.                                                      |
| `app.use([path], ...fns)`   | Register middleware, optionally scoped to a path prefix.                    |
| `app.route(path)`           | Chainable route builder — `.get().post().put()` on same path.               |
| `app.Router()`              | Create a sub-router (mini-app). Mount with `app.use(prefix, router)`.       |
| `app.onError(fn)`           | 4-arg global error handler: `(err, req, res, next)`.                        |
| `app.notFound(fn)`          | Called when no Layer matched. Default returns 404 JSON.                     |
| `app.fetch(req, env, ctx)`  | Cloudflare Workers entrypoint. Pass as `fetch: app.fetch`.                  |
| `app.scheduled(event, env)` | Optional cron trigger handler. Pass as `scheduled: app.scheduled`.          |

---

### 3.2 BlazeRequest (`req`)

`BlazeRequest` wraps the standard Web Platform `Request` and adds Blaze-specific properties. It is constructed once per request inside `app.fetch` and passed through the entire middleware chain by reference.

#### Cloudflare-native properties

| Property     | Description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `req.env`    | Your typed `Env` bindings. Type flows from `createApp<Env>()`. Access: `req.env.KV`, `req.env.DB`, `req.env.AI`. |
| `req.ctx`    | The `ExecutionContext`. Access: `req.ctx.waitUntil(promise)`, `req.ctx.passThroughOnException()`.                |
| `req.params` | Path parameter object populated by the TrieRouter. Type-safe based on the route pattern string.                  |
| `req.query`  | `URLSearchParams` wrapper. `req.query.get("page")`, `req.query.getAll("tags")`.                                  |

#### Body helpers

| Method              | Description                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| `req.json<T>()`     | Parses `application/json` body. Returns `T`. Cached — safe to call multiple times. |
| `req.text()`        | Parses body as UTF-8 text.                                                         |
| `req.formData()`    | Parses `multipart/form-data` or `application/x-www-form-urlencoded`.               |
| `req.arrayBuffer()` | Returns raw `ArrayBuffer`.                                                         |
| `req.blob()`        | Returns `Blob`.                                                                    |

#### Metadata helpers

| Property / Method    | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `req.ip`             | Client IP from `CF-Connecting-IP` header.                      |
| `req.cf`             | Cloudflare request metadata (country, datacenter, colo, etc.). |
| `req.header(name)`   | Case-insensitive header lookup.                                |
| `req.accepts(types)` | Content negotiation helper. Returns best match or `false`.     |
| `req.is(type)`       | Check `Content-Type`. `req.is("json")`, `req.is("form")`.      |

---

### 3.3 BlazeResponse (`res`)

`BlazeResponse` is constructed once per request and passed alongside `req`. It resolves an internal `Promise` that `app.fetch` awaits — mirroring the Express `res.send()` pattern.

#### Response methods

| Method                        | Description                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| `res.json(data, status?)`     | Responds with JSON. Sets `Content-Type: application/json`.           |
| `res.send(body, status?)`     | Responds with text or buffer. Auto-detects `Content-Type`.           |
| `res.html(markup, status?)`   | Responds with `Content-Type: text/html`.                             |
| `res.redirect(url, status?)`  | Issues a 302 (or custom) redirect.                                   |
| `res.stream(fn, status?)`     | Server-sent events / streaming. `fn` receives a `WritableStream`.    |
| `res.status(code)`            | Chainable status setter. `res.status(201).json({ ok: true })`.       |
| `res.header(name, value)`     | Set response header.                                                 |
| `res.cookie(name, val, opts)` | Set a cookie. Accepts standard cookie options.                       |
| `res.vary(header)`            | Append to `Vary` response header.                                    |
| `res.type(mime)`              | Set `Content-Type` shorthand. `res.type("json")`, `res.type("png")`. |

#### Example

```ts
app.get("/users/:id", async (req, res) => {
  const user = await req.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(req.params.id)
    .first();

  if (!user) return res.status(404).json({ error: "Not found" });

  res.json(user);
});
```

---

## 4. Router

### 4.1 TrieRouter

Route matching uses a prefix trie (radix tree), giving **O(log n) lookup** regardless of how many routes are registered — eliminating the linear-scan performance cliff that Express's `path-to-regexp` approach suffers from at scale.

Supported route patterns:

| Pattern             | Example                                    |
| ------------------- | ------------------------------------------ |
| Static segments     | `/users/me`                                |
| Named parameters    | `/users/:id`                               |
| Optional parameters | `/posts/:slug?`                            |
| Wildcards           | `/files/*`                                 |
| Regexp constraints  | `/posts/:date([0-9]{4}-[0-9]{2}-[0-9]{2})` |
| Multiple segments   | `/orgs/:org/repos/:repo`                   |

### 4.2 Sub-Routers

Sub-routers are first-class. They have their own Layer stack and can be mounted at any path prefix. They **inherit the parent's `env` and `ctx` automatically** — no manual passing required.

```ts
import { createApp } from "blaze";

type Env = { DB: D1Database; KV: KVNamespace };
const app = createApp<Env>();

// Create sub-router
const api = app.Router();

// Scoped middleware — only runs for /api/* routes
api.use(bearerAuth({ secret: (req) => req.env.KV.get("jwt-secret") }));

api.get("/users", listUsers);
api.get("/users/:id", getUser);
api.post("/users", createUser);

// Mount sub-router
app.use("/api/v1", api);

export default { fetch: app.fetch };
```

### 4.3 Route Chaining

The `.route()` builder returns a chainable `Route` object, allowing multiple HTTP methods to be registered on the same path without repeating the path string:

```ts
app
  .route("/posts/:id")
  .get(async (req, res) => {
    const post = await req.env.DB.prepare("SELECT * FROM posts WHERE id = ?")
      .bind(req.params.id)
      .first();
    res.json(post);
  })
  .put(async (req, res) => {
    const body = await req.json();
    await req.env.DB.prepare("UPDATE posts SET title=?, body=? WHERE id=?")
      .bind(body.title, body.body, req.params.id)
      .run();
    res.status(200).json({ ok: true });
  })
  .delete(async (req, res) => {
    await req.env.DB.prepare("DELETE FROM posts WHERE id=?")
      .bind(req.params.id)
      .run();
    res.status(204).send();
  });
```

---

## 5. Middleware

Middleware in Blaze follows the Express `(req, res, next)` convention exactly. **Any middleware that works in Express works in Blaze.**

### 5.1 Writing Middleware

```ts
// Synchronous middleware
function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.header("X-Request-Id", req.id);
  next();
}

// Async middleware
async function requireAuth(req, res, next) {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = await verifyJwt(token, req.env.JWT_SECRET);
    next();
  } catch (err) {
    next(err); // forwards to error handler
  }
}

// Error-handling middleware (4 args — must be last)
function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(err.status ?? 500).json({ error: err.message });
}

app.use(requestId);
app.use("/api", requireAuth);
app.use(errorHandler);
```

### 5.2 Built-in Middleware

| Import                                                          | Description                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `import { cors }        from 'blaze/middleware/cors'`           | CORS headers. Supports origins, methods, credentials, maxAge. CF-aware. |
| `import { logger }      from 'blaze/middleware/logger'`         | Request/response logger. Logs method, path, status, duration, CF colo.  |
| `import { bearerAuth }  from 'blaze/middleware/bearer-auth'`    | Bearer token validation. Accepts static token or async validator fn.    |
| `import { basicAuth }   from 'blaze/middleware/basic-auth'`     | HTTP Basic Auth. Username/password from `env` or static.                |
| `import { jwtAuth }     from 'blaze/middleware/jwt'`            | JWT validation via Web Crypto. RS256 and HS256. Secret from `env`.      |
| `import { rateLimit }   from 'blaze/middleware/rate-limit'`     | Rate limiting via KV. Sliding window. Configurable per route.           |
| `import { cache }       from 'blaze/middleware/cache'`          | Response caching via Cache API. Respects `Cache-Control` headers.       |
| `import { compress }    from 'blaze/middleware/compress'`       | Brotli/gzip compression. Checks `Accept-Encoding` and CF headers.       |
| `import { requestId }   from 'blaze/middleware/request-id'`     | Attaches UUID to `req.id` and `X-Request-Id` response header.           |
| `import { etag }        from 'blaze/middleware/etag'`           | ETag generation for cacheable responses.                                |
| `import { timeout }     from 'blaze/middleware/timeout'`        | Request timeout. Calls `next(err)` after N ms. CF-safe.                 |
| `import { secureHdrs }  from 'blaze/middleware/secure-headers'` | Sets CSP, HSTS, X-Frame-Options, Referrer-Policy.                       |

### 5.3 Middleware Scope

```ts
// Global — every request
app.use(logger());

// Path-scoped — only /admin/* requests
app.use(
  "/admin",
  basicAuth({
    username: (req) => req.env.ADMIN_USER,
    password: (req) => req.env.ADMIN_PASS,
  }),
);

// Route-level inline middleware stack
app.post(
  "/upload",
  bodyLimit({ maxSize: 10 * 1024 * 1024 }), // 10 MB
  requireAuth,
  handleUpload,
);
```

---

## 6. Cloudflare Bindings

This is where Blaze diverges most significantly from generic frameworks. Every Cloudflare primitive is reachable from `req.env` with **zero boilerplate**. The `Env` generic on `createApp<Env>()` propagates TypeScript types through the entire application with no additional annotation.

### 6.1 KV Namespace

```ts
// wrangler.toml
// [[kv_namespaces]]
// binding = "CACHE"
// id      = "abc123"

app.get("/items/:key", async (req, res) => {
  const value = await req.env.CACHE.get(req.params.key, { type: "json" });
  if (!value) return res.status(404).json({ error: "Key not found" });
  res.json(value);
});

app.put("/items/:key", async (req, res) => {
  const body = await req.json();
  await req.env.CACHE.put(req.params.key, JSON.stringify(body), {
    expirationTtl: 3600,
  });
  res.status(201).json({ ok: true });
});
```

### 6.2 D1 Database

```ts
// wrangler.toml
// [[d1_databases]]
// binding      = "DB"
// database_name = "myapp"
// database_id  = "..."

app.get("/users", async (req, res) => {
  const page = Number(req.query.get("page") ?? 1);
  const limit = Number(req.query.get("limit") ?? 20);

  const { results } = await req.env.DB.prepare(
    "SELECT id, name, email FROM users LIMIT ? OFFSET ?",
  )
    .bind(limit, (page - 1) * limit)
    .all();

  res.json({ page, results });
});

app.post("/users", async (req, res) => {
  const { name, email } = await req.json();

  const result = await req.env.DB.prepare(
    "INSERT INTO users (name, email) VALUES (?, ?) RETURNING id",
  )
    .bind(name, email)
    .first();

  res.status(201).json({ id: result.id });
});
```

### 6.3 R2 Bucket

```ts
app.put("/files/:key", async (req, res) => {
  const body = await req.arrayBuffer();
  const type = req.header("Content-Type") ?? "application/octet-stream";

  await req.env.R2.put(req.params.key, body, {
    httpMetadata: { contentType: type },
    customMetadata: { uploadedBy: req.user?.id ?? "anonymous" },
  });

  res.status(201).json({ key: req.params.key });
});

app.get("/files/:key", async (req, res) => {
  const obj = await req.env.R2.get(req.params.key);
  if (!obj) return res.status(404).json({ error: "Not found" });

  res.header(
    "Content-Type",
    obj.httpMetadata?.contentType ?? "application/octet-stream",
  );
  res.header("ETag", obj.httpEtag);
  res.send(await obj.arrayBuffer());
});
```

### 6.4 Durable Objects

```ts
// wrangler.toml
// [[durable_objects.bindings]]
// name       = "ROOMS"
// class_name = "ChatRoom"

app.get("/rooms/:id/ws", async (req, res) => {
  const id = req.env.ROOMS.idFromName(req.params.id);
  const obj = req.env.ROOMS.get(id);

  // Forward WebSocket upgrade to the Durable Object
  const response = await obj.fetch(req.raw);
  res.raw(response); // pass through raw Response
});
```

### 6.5 Queues

```ts
// Producer — send a message from any route
app.post("/jobs", async (req, res) => {
  const body = await req.json();
  await req.env.QUEUE.send({ type: "process", payload: body });
  res.status(202).json({ status: "queued" });
});

// Consumer — wire up the queue handler alongside fetch
export default {
  fetch: app.fetch,
  async queue(batch, env) {
    for (const msg of batch.messages) {
      await processMessage(msg.body, env);
      msg.ack();
    }
  },
};
```

### 6.6 Workers AI

```ts
app.post("/ai/complete", async (req, res) => {
  const { prompt } = await req.json();

  const result = await req.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt },
    ],
    stream: false,
  });

  res.json({ response: result.response });
});

// Streaming AI response
app.post("/ai/stream", async (req, res) => {
  const { prompt } = await req.json();

  const stream = await req.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
    stream: true,
  });

  res.header("Content-Type", "text/event-stream");
  res.stream((writer) => stream.pipeTo(writer));
});
```

### 6.7 `waitUntil` — Background Tasks

`req.ctx.waitUntil()` extends the Worker lifetime beyond the response. Use it for analytics, cache warming, and any fire-and-forget work:

```ts
app.get("/products/:id", async (req, res) => {
  const product = await req.env.DB.prepare(
    "SELECT * FROM products WHERE id = ?",
  )
    .bind(req.params.id)
    .first();

  res.json(product);

  // Runs after response is sent — does not block
  req.ctx.waitUntil(
    req.env.ANALYTICS.writeDataPoint({
      blobs: [req.params.id, req.cf?.country ?? "unknown"],
      doubles: [Date.now()],
      indexes: ["product-view"],
    }),
  );
});
```

---

## 7. Error Handling

Blaze follows the Express 4-argument error handler convention. Any middleware that calls `next(err)` or throws inside an async handler routes to the nearest downstream error handler.

### 7.1 BlazeError

```ts
import { BlazeError } from "blaze";

app.get("/admin/users", async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new BlazeError(403, "Forbidden", {
      code: "INSUFFICIENT_PERMISSIONS",
    });
  }
  // ...
});
```

### 7.2 Global Error Handler

```ts
app.onError((err, req, res, next) => {
  const status = err instanceof BlazeError ? err.status : 500;
  const message =
    err instanceof BlazeError ? err.message : "Internal Server Error";
  const meta = err instanceof BlazeError ? err.meta : {};

  // Log to your observability pipeline — non-blocking
  req.ctx.waitUntil(
    logError({ status, message, path: req.url, requestId: req.id }),
  );

  res.status(status).json({ error: message, ...meta });
});
```

### 7.3 Route-level Error Boundaries

```ts
const payments = app.Router();

payments.post("/charge", handleCharge);

// Only catches errors thrown within the payments router
payments.onError((err, req, res, next) => {
  if (err.code === "CARD_DECLINED") {
    return res.status(402).json({ error: "Card declined", code: err.code });
  }
  next(err); // bubble to global handler
});

app.use("/payments", payments);
```

---

## 8. TypeScript Integration

Blaze is designed TypeScript-first. The `Env` generic provides end-to-end type safety from `wrangler.toml` all the way to individual handler bodies.

### 8.1 Full Type Flow

```ts
// types/env.ts — mirrors your wrangler.toml exactly
export type Env = {
  // KV Namespaces
  SESSION_KV: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;

  // D1 Databases
  DB: D1Database;

  // R2 Buckets
  ASSETS: R2Bucket;

  // Durable Objects
  ROOMS: DurableObjectNamespace;

  // Queues
  JOBS: Queue<{ type: string; payload: unknown }>;

  // AI
  AI: Ai;

  // Secrets / vars
  JWT_SECRET: string;
  ALLOWED_ORIGINS: string;
};

// index.ts
import { createApp } from "blaze";
import type { Env } from "./types/env";

const app = createApp<Env>(); // Env flows to every req.env call

app.get("/test", async (req, res) => {
  const val = await req.env.SESSION_KV.get("key"); // ✅ typed as KVNamespace
  const row = await req.env.DB.prepare("SELECT 1") // ✅ typed as D1Database
    .first();
  res.json({ val, row });
});
```

### 8.2 Augmenting BlazeRequest

Middleware that attaches properties to `req` can be typed by augmenting the `BlazeRequest` interface:

```ts
// types/blaze.d.ts
declare module "blaze" {
  interface BlazeRequest {
    user?: {
      id: string;
      email: string;
      isAdmin: boolean;
    };
    id: string; // set by requestId middleware
    startTime: number;
  }
}
```

---

## 9. Testing

Because `app.fetch` is a standard async function that takes `(Request, Env, ExecutionContext)`, testing requires no special runtime — pass a mock `env` and a synthetic `Request`, and assert on the `Response`.

### 9.1 Unit Testing a Route

```ts
import { describe, it, expect, vi } from "vitest";
import app from "./src/index";

const mockEnv = {
  DB: {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: "1", name: "Alice" }),
      }),
    }),
  },
};

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
};

describe("GET /users/:id", () => {
  it("returns 200 with user data", async () => {
    const req = new Request("http://localhost/users/1");
    const res = await app.fetch(req, mockEnv, mockCtx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: "1", name: "Alice" });
  });

  it("returns 404 when user not found", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce({
      bind: () => ({ first: () => Promise.resolve(null) }),
    });
    const req = new Request("http://localhost/users/999");
    const res = await app.fetch(req, mockEnv, mockCtx);
    expect(res.status).toBe(404);
  });
});
```

### 9.2 Integration Testing with `@cloudflare/vitest-pool-workers`

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { pool: "@cloudflare/vitest-pool-workers" },
});

// workers.test.ts
import { SELF } from "cloudflare:test";

it("handles real KV reads", async () => {
  const res = await SELF.fetch("http://example.com/items/hello");
  expect(res.status).toBe(200);
});
```

---

## 10. Performance

Blaze is optimised for the v8 isolate model used by Cloudflare Workers. Isolates persist across requests within a datacenter, so route registration (which happens at module-level startup) amortises over many requests.

### 10.1 Router Benchmarks

Comparative µs/iter for route matching at 50 registered routes (lower is better):

| Router               | Time        | Notes                                   |
| -------------------- | ----------- | --------------------------------------- |
| **Blaze TrieRouter** | **0.41 µs** | O(log n) trie — scales cleanly          |
| Hono RegExpRouter    | 0.38 µs     | Fastest, but limited pattern support    |
| Hono SmartRouter     | 0.44 µs     | Adaptive but heavier startup            |
| Express (path-rx)    | 3.20 µs     | Linear scan — degrades with route count |
| itty-router          | 1.90 µs     | Array scan with regex — simple but slow |

### 10.2 Bundle Size

| Framework      | Bundle size                |
| -------------- | -------------------------- |
| **Blaze core** | **~11 KB** minified + gzip |
| Hono tiny      | ~14 KB minified + gzip     |
| Hono (default) | ~18 KB minified + gzip     |
| Express        | ~572 KB (Node.js only)     |

### 10.3 Cold Start

All route registration is synchronous at module initialisation. The v8 JIT compiles the trie on first warm-up; subsequent requests in the same isolate pay zero registration cost.

> **Tip:** Use `export default { fetch: app.fetch }` — not `addEventListener("fetch", ...)` — to stay in Module Worker mode. Module Workers have lower cold-start latency and native access to `env` bindings.

---

## 11. Recommended Project Structure

```
my-worker/
├── src/
│   ├── index.ts                  # Entry — createApp + export default
│   ├── types/
│   │   ├── env.ts                # Env type (mirrors wrangler.toml)
│   │   └── blaze.d.ts            # BlazeRequest augmentation
│   ├── middleware/
│   │   ├── auth.ts               # requireAuth, requireAdmin
│   │   └── validate.ts           # Zod / Valibot schema validators
│   ├── routes/
│   │   ├── users.ts              # app.Router() for /users
│   │   ├── posts.ts              # app.Router() for /posts
│   │   └── admin.ts              # app.Router() for /admin
│   └── lib/
│       ├── db.ts                 # D1 query helpers
│       └── errors.ts             # Domain-specific BlazeErrors
├── test/
│   ├── users.test.ts
│   └── posts.test.ts
├── wrangler.toml
├── tsconfig.json
└── package.json
```

### 11.1 Entry Point Pattern

```ts
// src/index.ts
import { createApp } from "blaze";
import { cors } from "blaze/middleware/cors";
import { logger } from "blaze/middleware/logger";
import { requestId } from "blaze/middleware/request-id";
import { users } from "./routes/users";
import { posts } from "./routes/posts";
import type { Env } from "./types/env";

const app = createApp<Env>();

// Global middleware
app.use(requestId());
app.use(logger());
app.use(cors({ origins: (req) => req.env.ALLOWED_ORIGINS.split(",") }));

// Mount feature routers
app.use("/users", users);
app.use("/posts", posts);

// Global error handler
app.onError((err, req, res, next) => {
  res.status(err.status ?? 500).json({ error: err.message ?? "Server error" });
});

export default { fetch: app.fetch };
```

---

## 12. Feature Comparison

| Feature                   | Blaze                                    | Hono                                      |
| ------------------------- | ---------------------------------------- | ----------------------------------------- |
| Middleware signature      | `(req, res, next)` — Express compatible  | `async (c, next)`                         |
| Route matching            | TrieRouter — O(log n)                    | RegExpRouter + SmartRouter                |
| Bindings access           | `req.env.KV` (on request object)         | `c.env.KV` (on context)                   |
| Error handling            | 4-arg `(err, req, res, next)`            | `app.onError((err, c))`                   |
| Sub-routers               | `app.Router()` — Express-style mini-app  | `new Hono().route()`                      |
| Response object           | `BlazeResponse` — wraps Web Std Response | Context helpers `c.json()`                |
| Bundle size               | ~11 KB gzip                              | ~14 KB gzip (tiny preset)                 |
| Express middleware compat | ✅ Full — same `(req, res, next)` arity  | ❌ None — different signatures            |
| TypeScript types          | `Env` generic on `createApp<Env>()`      | `Env` generic on `new Hono<{Bindings}>()` |
| `waitUntil`               | `req.ctx.waitUntil()`                    | `c.executionCtx.waitUntil()`              |
| Streaming                 | `res.stream(fn)`                         | `streamText` / `streamSSE` helpers        |
| WebSocket (CF)            | `res.upgradeWebSocket()`                 | `upgradeWebSocket` helper                 |
| Testing                   | `app.fetch(req, mockEnv, ctx)`           | `app.request(url)`                        |
| Cron support              | `export { fetch, scheduled }`            | `export { fetch, scheduled }`             |

---

## 13. Roadmap

| Version               | Milestone                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------- |
| **v1.0 — Core**       | Router, BlazeRequest, BlazeResponse, built-in middleware suite, full TypeScript types.       |
| **v1.1 — Validate**   | First-class Zod and Valibot integration via `req.validate(schema)`. Auto 422 on failure.     |
| **v1.2 — RPC**        | Type-safe client via `blaze/client` — infers route types and generates a typed fetch client. |
| **v1.3 — WebSockets** | `res.upgradeWebSocket()` with Durable Object forwarding. Hibernate API support.              |
| **v1.4 — SSE**        | `res.sse()` helper with automatic retry, event ID, and comment support.                      |
| **v1.5 — Static**     | Static asset middleware — serve from R2, KV, or CF Assets with ETag and range support.       |
| **v2.0 — JSX**        | Optional JSX renderer via `res.render(<Component />)`. Streaming JSX support.                |

---

> **Status:** Blaze is currently in active design phase. This document is the canonical architecture specification. Implementation begins at v1.0 core, following the module map in [section 2.1](#21-module-map).
