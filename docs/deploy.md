# Deploying without stranding live clients

## The failure this guards against (2026-07-23 prod incident)

`public/build` is gitignored, so the server rebuilds assets on deploy. Vite's default `emptyOutDir` deleted every previously-hashed chunk the moment the new build landed — but live clients (open tabs, and pages served from the service worker's HTML cache) still dynamic-import chunks by their OLD hashed names. Result: `TypeError: Importing a module script failed` / `Failed to fetch dynamically imported module`, a wedged app, and "prod is unresponsive" reports even though the server was serving fine. The simultaneous service-worker swap (`skipWaiting` + `clients.claim`) added transient `Service Worker context closed` fetch failures on top.

## The three defenses (all in-repo — no special deploy steps needed)

- **Old hashed assets are retained across builds.** `vite.config.js` sets `build.emptyOutDir: false`, and `npm run build` first runs `scripts/prune-old-build-assets.mjs`, which deletes only assets untouched for 7 days. Current chunks are rewritten (fresh mtime) every build so they never age out; a client on last week's HTML keeps successfully fetching last week's chunks. Never `rm -rf public/build` in a deploy script — that reintroduces the incident.
- **Clients self-heal a failed chunk load.** `layout.blade.php` installs an early listener for `vite:preloadError` and module-import unhandled rejections; on the first failure it reloads the page once (60s loop guard), picking up fresh HTML + assets. A stranded tab recovers by itself instead of wedging.
- **The service worker version-bumps away stale caches.** Any deploy containing front-end changes should bump `CACHE_VERSION` in `public/sw.js` (this is part of the normal change workflow, not a deploy step). The new SW clears the old versioned caches and the HTML cache on activate; cache-missed old chunks now succeed from the network because of the retention above.

## Deploy checklist

- `git pull` + `composer install` / `npm ci` as needed.
- `php artisan migrate` (remember any pending migrations noted in the PR/commits).
- `npm run build` (includes the asset prune — do NOT clear `public/build` manually).
- `php artisan queue:restart` — ALWAYS. A running `queue:work` holds pre-deploy code and silently misbehaves (see the stale-worker audio incident); job workers must be recycled every deploy.

## What users see after a deploy

Nothing, ideally. A tab that was open across the deploy either keeps working on the old chunks (still on disk) or, at worst, reloads itself once when a chunk fetch fails. The new service worker takes over on the next navigation; no more "tell users to hard-refresh twice".
