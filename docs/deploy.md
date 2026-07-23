# Deploying without stranding live clients

## The failure this guards against (2026-07-23 prod incident)

`public/build` is gitignored, so the server rebuilds assets on deploy. Vite's default `emptyOutDir` deleted every previously-hashed chunk the moment the new build landed — but live clients (open tabs, and pages served from the service worker's HTML cache) still dynamic-import chunks by their OLD hashed names. Result: `TypeError: Importing a module script failed` / `Failed to fetch dynamically imported module`, a wedged app, and "prod is unresponsive" reports even though the server was serving fine. The simultaneous service-worker swap (`skipWaiting` + `clients.claim`) added transient `Service Worker context closed` fetch failures on top.

## The three defenses (all in-repo — no special deploy steps needed)

- **Old hashed assets are retained across builds.** `vite.config.js` sets `build.emptyOutDir: false`, and `npm run build` first runs `scripts/prune-old-build-assets.mjs`, which deletes only assets untouched for 7 days. Current chunks are rewritten (fresh mtime) every build so they never age out; a client on last week's HTML keeps successfully fetching last week's chunks. Never `rm -rf public/build` in a deploy script — that reintroduces the incident.
- **Clients self-heal a failed chunk load.** `layout.blade.php` installs an early listener for `vite:preloadError` and module-import unhandled rejections; on the first failure it reloads the page once (60s loop guard), picking up fresh HTML + assets. A stranded tab recovers by itself instead of wedging.
- **The service worker version-bumps away stale caches.** Any deploy containing front-end changes should bump `CACHE_VERSION` in `public/sw.js` (this is part of the normal change workflow, not a deploy step). The new SW clears the old versioned caches and the HTML cache on activate; cache-missed old chunks now succeed from the network because of the retention above.
- **The SW retries chunk fetches past HTTP-cached 404s.** During the incident, Cloudflare stamped `max-age=14400` onto transient 404s for the new chunks, so browsers kept re-serving a dead 404 from their OWN HTTP cache for 4 hours after the origin recovered (a private window worked; the normal one stayed wedged — plain `fetch()` consults the HTTP cache). The SW's build-asset handler now retries any non-200/failed chunk fetch with `cache: 'reload'`, which bypasses the HTTP cache — poisoned browsers self-heal on their next visit with no user action.

## Cloudflare (hyperlit.io sits behind it — this bit users' browsers directly)

- **`/sw.js` must have a Bypass-cache rule** (Caching → Cache Rules → URI path equals `/sw.js` → Bypass). CF was serving a six-versions-old `sw.js` (4h edge TTL) — so deploys' SW updates never reached any browser, which is what turned a routine deploy into an outage. The SW file is the cache-buster; it must never itself be CDN-cached. (`updateViaCache: 'none'` only bypasses the browser's cache, not a CDN.)
- Caching `/build/assets/*` at the edge is fine and good — hashed files are immutable, and asset retention means even old hashes keep resolving at the origin.
- When things look impossibly stale despite a deploy, check `curl -sD - https://hyperlit.io/sw.js | grep -i 'cf-cache-status\|last-modified'` before blaming the server — `HIT` plus an old `last-modified` is the CDN, not the deploy. Purge Everything unsticks it.

## Deploy checklist

- `git pull` + `composer install` / `npm ci` as needed.
- `php artisan migrate` (remember any pending migrations noted in the PR/commits).
- `npm run build` (includes the asset prune — do NOT clear `public/build` manually).
- `php artisan queue:restart` — ALWAYS. A running `queue:work` holds pre-deploy code and silently misbehaves (see the stale-worker audio incident); job workers must be recycled every deploy.

## What users see after a deploy

Nothing, ideally. A tab that was open across the deploy either keeps working on the old chunks (still on disk) or, at worst, reloads itself once when a chunk fetch fails. The new service worker takes over on the next navigation; no more "tell users to hard-refresh twice".
