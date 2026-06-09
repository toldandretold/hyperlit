# Hyperlit scaling roadmap

How Hyperlit scales — when to do what, in what order, and the gotchas specific to
this codebase. The short version: **you have a lot of headroom on one box, and
horizontal scaling (multiple app servers) is near the *bottom* of the ladder, not
the top.** This doc exists so that when the triggers actually fire, the path (and
its prerequisites) are already written down.

> Companion docs:
> - `docs/api-restructure-findings.md` — the concurrency/consistency findings
>   register (F1–F12). The fixes that make the API safe *under concurrency* live
>   there; this roadmap is about scaling the *infrastructure* around it.
> - `tests/Feature/Api/README.md` — the per-endpoint API test suite + a full
>   coverage matrix (see "Verifying before you scale" below).
> - `tests/load/README.md` — the standalone load probes for "what happens when N
>   users hit this at once?"

---

## TL;DR

- The expensive coordination work is **already done**: sessions, cache, queue, and
  locks are all on a shared Postgres backend, so multiple servers *could* already
  coordinate. The concurrency-correctness bugs (F1/F2/F12) are fixed and verified.
- The **only** thing blocking >1 app server is `FILESYSTEM_DISK=local` — book
  images, the per-book working dir, and the F3 IPC markers all live on one box's
  local disk.
- But you almost certainly **don't need** horizontal scaling yet. Climb the ladder
  in order; most "it's slow under load" problems are solved at step 2–3 without
  ever running a second app server.
- The database does **not** scale horizontally the way the app tier does — it stays
  a single shared source of truth, scaled by vertical → read replicas → pooling.
- **Codebase-specific landmine:** the RLS session context is set with a
  *session-scoped* `set_config(..., false)`, which **leaks across users under a
  transaction-mode connection pooler (PgBouncer)**. Must be fixed before any pooler
  goes in. See "The RLS / PgBouncer prerequisite."

---

## The scaling ladder (climb in this order)

### 1. Vertical — a bigger box
More cores → more php-fpm workers → more throughput, **zero code change**. A single
tuned droplet goes a long way; reading is mostly cacheable GETs. This is where we
are and there's lots of headroom.

### 2. Tune what you have
php-fpm pool size (`pm.max_children`), opcache, fix N+1 queries, add the right
indexes, cache hot reads. Usually buys 2–5× before spending anything on hardware.

### 3. Split by role (the big one — and it is NOT horizontal)
Move Postgres to its own box / managed instance; move the queue worker off the web
box. One web server still, but each component gets its own resources, so the web
box spends all its CPU on web. **Solves most load problems and needs neither F3 nor
shared storage** (still one web box → local disk is fine).

### 4. Horizontal — N app servers behind a load balancer
Only when one well-tuned, vertically-maxed box is genuinely CPU-bound at *peak real
traffic* and going bigger isn't cost-effective. This is the step that requires the
filesystem migration (below). For a niche academic reading/annotation tool, raw
throughput saturation is likely thousands of concurrent readers away.

---

## When do you actually need horizontal scaling?

Watch the droplet for these **triggers**:
- Web-box CPU consistently >70–80% at peak — *and it's PHP burning it, not Postgres*.
- p95 latency climbing under **organic** load (not synthetic bursts).
- You've maxed the droplet tier and bigger isn't cost-effective.

**The more realistic near-term reason is high availability, not throughput.** A
second box so that one dying (OOM / swap pressure — see `prod-infra` notes) doesn't
take the whole site down. HA is a legitimate reason to go to 2 servers even at low
traffic, and it's a *different* motivation than raw capacity.

---

## What blocks >1 app server today

Everything that breaks is **local-disk state** (`FILESYSTEM_DISK=local`). Four
categories, biggest user-impact first:

| # | What | Where | Breaks when… |
|---|------|-------|--------------|
| 1 | **Book images** | `storage/app/public/books/{book}/images/` | written on box A → users served by box B get 404s. **A user-facing READ path** — breaks normal reading, not just conversion. |
| 2 | **Book working dir** | `resources/markdown/{book}/` — uploaded `original.epub/pdf` + artifacts (`nodes.json`, `main-text.html`, `footnotes.json`, `epub_original/`) | upload, worker, and apply land on different boxes; the worker can't find a source uploaded elsewhere. |
| 3 | **F3 IPC markers** | 9 progress/cancel files under `resources/markdown/{book}/` | progress polling + cancel cross web↔worker on different boxes. See `docs/api-restructure-findings.md#f3`. |
| 4 | misc static | `public/images` | same as #1. |

### Already shared — the hard part

| State | Backend | Cross-server? |
|-------|---------|---------------|
| Sessions | `database` | ✅ |
| Cache **+ locks** | `database` | ✅ |
| Queue | `database` | ✅ |
| Auth (Sanctum tokens, anon sessions) | DB tables | ✅ |

Because the locks are DB-backed, the **F1/F2/F12 `Cache::lock` fixes work across
servers** (a DB lock is global, not per-box). Coordination is sound.

### Two routes to fix the filesystem

- **Route A — shared network volume** (DigitalOcean Spaces-as-volume / NFS / block
  storage). Mount `resources/markdown` + `storage/app/public` so all boxes see the
  same files. **Near-zero code change**; unlocks N servers fast. *Caveat:* a shared
  FS makes files *visible* everywhere but does **not** fix F3's concurrency clobber
  (two boxes still overwrite each other's `progress.json`), so F3-to-DB stays worth
  doing as a correctness fix on top.
- **Route B — object storage (Spaces/S3)** via Laravel's `Storage` disk + a CDN for
  images, plus F3 fully in DB. Cloud-native, no shared-FS appliance, scales further.
  *Friction:* the **Python conversion subprocess reads/writes local paths directly**
  (`app/Python/...`), so it needs S3 access or a job-level bridge (download source →
  temp dir → run Python → upload artifacts).

**Note on F3 specifically:** it splits cleanly. *Import progress* (`progress.json`,
`notify_email.json`, the crash shutdown handler) is **pure PHP** — Python only
`print("PROGRESS:{json}")` to stdout; PHP persists it — so it can go DB-backed with
no Python changes. The *vibe markers* (`vibe_progress`/`vibe_cancel`/`vibe_use_now`/
`vibe_report`) are **Python-coupled** and a bigger lift.

---

## How it works with the database

The common misconception: *"everything's on the database, so won't N app servers
just hammer one DB and make it the bottleneck?"* The model:

**The app tier scales out; the database does not — it stays a single shared source
of truth.** That's the point of stateless app servers: state lives in Postgres, the
app servers are interchangeable. You then scale the *database differently*:

1. **Vertical first** — one Postgres instance scales remarkably far (tens of
   thousands of queries/sec on decent hardware). Most apps never outgrow a single
   well-resourced primary.
2. **Read replicas** — streaming replication: one primary takes writes, N read-only
   replicas take reads. **Hyperlit is extremely read-heavy** (reading books), so
   this fits well. Laravel supports it natively (separate `read`/`write` hosts in
   `config/database.php`, no app rewrite). *Caveat:* replication lag — a replica can
   be milliseconds behind, so "read your own write" needs the write connection for
   that query.
3. **Connection pooling — the gotcha that bites when you add app servers.** Each
   php-fpm worker opens its *own* Postgres connection. N servers × M workers exhausts
   `max_connections` (default ~100) fast. Put **PgBouncer** (or DO managed Postgres's
   built-in pooler) between app servers and Postgres.

**The offload nobody mentions until it's urgent:** `CACHE_STORE`, `SESSION_DRIVER`,
and `QUEUE_CONNECTION` are all `database`. Fine now — but every cache read, session
write, `Cache::lock`, and queue poll is *load on Postgres*, competing with real data
queries. When the DB gets busy, move cache/session/queue/locks to **Redis** (one
shared in-memory service the app servers share like they share Postgres).

### A fully horizontal Hyperlit

```
        DigitalOcean Load Balancer
                 │
   ┌─────────────┼─────────────┐
 app#1         app#2         app#3      (stateless web + php-fpm)
   └─────────────┼─────────────┘
                 ├──────► Redis        (cache / session / queue / locks)
                 ├──────► PgBouncer ──► Postgres primary (writes)
                 │                  └─► read replica(s)  (reads)
                 └──────► Spaces/S3    (images + book working dir — the filesystem fix)
   worker#1 worker#2  ← separate boxes, same Redis + Postgres
```

---

## The RLS / PgBouncer prerequisite (codebase-specific, important)

`app/Http/Middleware/SetDatabaseSessionContext.php` sets the RLS context with:

```php
set_config('app.current_token', ?, false)   // false = SESSION-scoped — persists on the connection
```

That `false` is **fine with dedicated per-worker connections** (one user per
connection per request). But **PgBouncer in transaction-pooling mode** — the
efficient mode you'd reach for *precisely because* multiple app servers explode the
connection count — hands a physical connection to one transaction, then returns it
to the pool for a *different user's* next request. A session-scoped
`set_config(..., false)` **persists on that connection and leaks the previous user's
RLS token to the next borrower** → a cross-tenant data leak, surfacing exactly when
you scale out and add a pooler.

**Fix before any transaction-mode pooler goes in:** either
- switch to `set_config(..., true)` (transaction-local) and guarantee the token-set
  and the RLS-dependent queries share one transaction, or
- run PgBouncer in **session-pooling** mode (safer, but fewer effective connections,
  partly defeating the point).

Not urgent today (one box, dedicated connections), but a hard prerequisite for
step 4 + pooling.

---

## Verifying before you scale

Two test layers already exist for the "many users" question — use them before and
after any scaling change:

- **`tests/Feature/Api/`** — per-endpoint API tests (auth / validation / ownership /
  RLS / idempotency) with a full **coverage matrix** in `tests/Feature/Api/README.md`.
  These pin current behaviour and assert *status codes* (the SPA branches on status).
  The `Concurrency/` subfolder holds the live `--group=concurrency` harness that
  fires genuinely-simultaneous requests at a running server (excluded from CI). Run:
  ```bash
  php artisan test tests/Feature/Api/
  ```
  ⚠️ Never point a `Feature/` test at a server whose DB you care about — the suite
  `migrate:fresh`es `.env`'s DB. See the README's corollary box.

- **`tests/load/`** — `loadprobe.php`, a standalone (no framework, no DB) concurrency
  probe that prints p50/p95/p99 + 2xx/4xx/5xx columns under rising concurrency. Safe
  to point at a live server. Use it to capture the capacity curve and to reproduce
  the F12 cache stampede (cold-cache burst). Recipes + the `--ip-spread` trick (one
  machine simulating N distinct users past the per-IP throttle) are in
  `tests/load/README.md`.
  ```bash
  php tests/load/loadprobe.php http://hyperlit.test/api/vibes/public --ip-spread
  ```
  **Verified 2026-06-09:** F12 fix holds — homepage cold burst to 40 concurrent and
  public shelf render to 25 distinct users, all-2xx, zero collisions.

---

## Recommended sequencing

1. **Now:** nothing infrastructural required. Stay on one box; keep an eye on the
   triggers above. Optionally do the **import-progress → DB** F3 slice (pure PHP,
   improves the hot polling path's correctness even before scaling).
2. **When load climbs:** step 2 (tune) then step 3 (split Postgres + worker onto
   their own boxes). This alone covers most growth and needs no shared storage.
3. **When one box is CPU-bound at peak, or you want HA:** Route A (shared volume) to
   unlock multiple app servers, **after** the RLS/PgBouncer fix if a pooler is
   involved. Add Redis when Postgres feels the cache/session/queue load. Add read
   replicas for the read-heavy book traffic.
4. **Long-term read path:** images → object storage + CDN (Route B), independent of
   the rest.

**Bottom line:** F3 alone does **not** unlock horizontal scaling — it's the smallest
of the four filesystem blockers and is really correctness polish. The real unlock is
shared storage for images + the book working dir, and you won't need even that until
vertical + split-by-role are exhausted.
