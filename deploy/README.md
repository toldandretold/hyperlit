# Deploying Hyperlit

## The command

```bash
ssh marx@170.64.145.89
cd /var/www/hyperlit && ./deploy/deploy.sh
```

That's the deploy. One command, from a clean local repo state — it pulls, figures out what changed, runs only the steps that change needs, restarts the queue workers, then verifies the box came back up and prints anything that looks wrong.

**One-liner from your laptop.** Add to `~/.zshrc`:

```bash
alias hd='ssh -t marx@170.64.145.89 "cd /var/www/hyperlit && ./deploy/deploy.sh"'
alias hw='ssh -t marx@170.64.145.89 "cd /var/www/hyperlit && ./deploy/supervisor/workers.sh"'
```

Then a deploy is `hd`, and worker chores are `hw status` / `hw logs citation -f` / `hw health`.

## What it does, in order

- **Preflight** — checks you're in the app root, warns about local modifications, and works out which user artisan must run as (bootstrap/cache's owner, so php-fpm can still rewrite the caches afterwards).
- **Pull** — `git fetch` + `git pull --ff-only`, printing the incoming commits.
- **Decides the plan from the diff** — `composer install` only if `composer.lock` moved; `npm run build` only if `resources/` / `vite.config.js` / `package*.json` / `public/sw.js` / `scripts/` moved; `php artisan migrate` only if a migration is new or `migrate:status` reports pending; supervisor-conf install only if a `.conf` changed. It prints this plan before doing any of it.
- **Migrations pause for a y/N** (skip the prompt with `--yes`), showing you the pending list first. Everything else is unattended.
- **Rebuilds config / route / view caches.**
- **Restarts the queue workers gracefully** via `deploy/supervisor/workers.sh restart` — each worker finishes its current job, exits, and Supervisor relaunches it on the new code. This is the step that used to get forgotten and cost days (see `docs/deploy.md` and the stale-worker audio incident).
- **Verifies** — worker status, queue backlog, and an HTTP check on `https://hyperlit.io`, then a one-line pass/fail summary with every warning repeated at the bottom.

## Flags

- `--dry-run` — print the plan, change nothing. Good for "what would this deploy actually do?".
- `--yes` — no prompts at all, migrations included. For when you already know what's in the diff.
- `--maintenance` — wrap the whole thing in `artisan down` / `artisan up`. Use for a **breaking, non-rolling migration** (a column drop or a NOT NULL add, where neither old-code-new-schema nor new-code-old-schema is safe). `deploy/nodes-rawjson-removal.md` is the worked example of that kind of deploy, backup included.
- `--all` — run every step even when nothing changed. Use after a manual `git pull`, or to force a rebuild.
- `--skip-build` / `--skip-migrate` — opt out of one step.
- `HYPERLIT_URL=... ` overrides the URL the verify step curls; `HYPERLIT_WEB_USER=...` overrides the artisan user if the ownership guess is wrong.

## When it warns you

- **"front-end changed but public/sw.js CACHE_VERSION was not bumped"** — browsers keep serving the old cached HTML and chunks. Bump `CACHE_VERSION` in `public/sw.js` as part of the change (it's a code change, not a deploy step) and deploy again. Full reasoning in `docs/deploy.md`.
- **"supervisor confs NOT installed"** — a queue whose program isn't installed has *nobody listening*, and its jobs silently never run. Answer `y` to the prompt, or do it by hand per `supervisor/README.md`.
- **"not every worker line says RUNNING"** — `hw logs <name>` for that worker, then `hw health`.
- **"migrations SKIPPED by you"** — the new code is now live against the old schema. Either finish (`./deploy/deploy.sh --all`) or roll back.

## When something's wrong after a deploy

- `hw status` → are all six workers RUNNING?
- `hw backlog` → what's queued, what's reserved, how many failed.
- `hw health` → `queue:probe` (topology) + `citation:doctor --fast` (external deps).
- `hw logs citation -f` → tail one worker.
- Site looks impossibly stale despite a green deploy? Check the CDN before blaming the server: `curl -sD - https://hyperlit.io/sw.js | grep -i 'cf-cache-status\|last-modified'`. A `HIT` with an old `last-modified` is Cloudflare — Purge Everything unsticks it, and `/sw.js` must have a Bypass-cache rule. See `docs/deploy.md` §Cloudflare.

## The rest of this folder

- **`supervisor/`** — queue-worker topology: which job class runs on which queue and worker, the RAM budget for the droplet, and `workers.sh` (the `hw` alias). Read it when you add a job class or a queue, not on a routine deploy.
- **`content/README.md`** — the artisan data-repair toolbox (backfills, reconverts, canonical/library fixes) you run on the droplet by hand.
- **`nodes-rawjson-removal.md`** — the template for a breaking-migration deploy: backup, maintenance window, migrate, reclaim, workers, back up.
- **`oa-fetch-hardening.md`**, **`search-performance.md`** — one-time prod setup for the open-access fetch ladder and the search stack (host deps, `.env` keys, the `search-supplement` worker). Their steps are one-off; routine deploys are just `hd`.
- **`docs/deploy.md`** (outside this folder) — *why* the deploy is safe for tabs that are open across it: asset retention, the client-side chunk-error self-heal, and the service-worker/Cloudflare cache rules.

## Host prerequisites (one-off, not per deploy)

- **ffmpeg** — `apt install ffmpeg`, needed by the whole-book `.m4b` audiobook download only. Without it the button simply never appears. Verify as the web/queue user, not your login shell.
- **Node + npm** — the droplet builds assets in-place, so `npm ci` / `npm run build` must work there.
- **`.env` must NOT set `DB_QUEUE_RETRY_AFTER`** — it would override the 7500s config default and let long jobs be re-reserved and run twice.
