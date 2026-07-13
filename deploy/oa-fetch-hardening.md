# Pulling open-access PDFs past Cloudflare (and how to ship it)

This documents the open-access fetch hardening — why it exists and the one-time prod steps — so future-you doesn't rediscover it. It applies to every path that pulls source content: the Source Network Harvester, `citation:vacuum`, `library:create-auto-versions`, and URL import all share `App\Services\ContentFetchService::fetch()`.

## The problem, in one paragraph

Legitimately open-access works kept failing with `cloudflare_block`. Two root causes: (1) the fetch ladder only ever tried ONE `oa_url` and ONE `pdf_url`, so when that single URL pointed at a Cloudflare-walled publisher we never tried the clean repository copy (arXiv, PMC, Zenodo, an institutional DSpace) that usually also exists; and (2) the last-resort headless browser ran with weak stealth and — the real killer — from the server's **datacenter IP**, which Cloudflare blocks by reputation no matter how good the JS-challenge handling is. The fix is two-sided: find a clean copy so we never hit Cloudflare (free, biggest win), and actually beat Cloudflare when no clean copy exists (better stealth + a self-hosted FlareSolverr solver + an optional residential proxy).

## What runs where

The ladder now: JATS full text → a ranked loop over EVERY known OA copy (OpenAlex `locations[]` + Unpaywall + Semantic Scholar + Crossref, deduped and sorted repository-host-first via `OaLocationResolver`, with `LandingPagePdfLocator` pulling the real PDF off repository landing pages) → plain HTML → the **patchright browser** (see next section) → and finally, only when something returned a Cloudflare block AND a solver is configured, `FlareSolverrClient` (now a legacy last rung — patchright supersedes it). Everything after the OA-location loop is a fallback; most works resolve from a repository copy and never reach the browser.

## Beating Cloudflare managed challenges: patchright + sticky IP + headed

The residual case is a legitimately-open PDF that lives ONLY behind a Cloudflare **managed JS challenge** (e.g. tandfonline — free to read by hand, but the PDF endpoint returns `cf-mitigated: challenge`). We proved three things with a live spike (`scripts/lib/cfBrowser.mjs` carries the result):

- `puppeteer-extra-plugin-stealth` no longer clears managed challenges — Cloudflare fingerprints its CDP-runtime tells. Replaced by **patchright** (a patched Playwright that removes them).
- **Headless loses; headed wins.** Patchright headless stayed stuck on "Just a moment…"; headed (a real display) cleared it and the in-page fetch returned the real `%PDF` (753 KB). So the browser runs headed — on a Linux server that needs a virtual display (`xvfb-run`, below). Force headless with `SOURCE_FETCH_HEADFUL=0` (it will lose managed challenges, fine for easy sites).
- `cf_clearance` is **IP-bound**, so the solve and the PDF download must share one IP. The proxy must therefore be **sticky-session capable** — rotating IPs break clearance every request. `ContentFetchService` mints one sticky session per work and captures the PDF with an **in-page fetch inside the cleared session** (not a separate raw request, which re-triggers the wall).

The scripts prefer real Google Chrome (`channel: 'chrome'`) and fall back to patchright's bundled chromium; override with `SOURCE_FETCH_BROWSER_CHANNEL`.

## One-time prod steps

Set the free Unpaywall contact email (keyless, but the API rejects requests without it — any real address you control):

```bash
# in .env
UNPAYWALL_EMAIL=you@example.org
```

Install patchright and its browser, and make sure real Google Chrome is present (best fingerprint; the scripts fall back to bundled chromium if absent). The old `playwright-extra` / `puppeteer-extra-plugin-stealth` deps are gone:

```bash
cd /var/www/hyperlit && git pull
npm ci                          # brings in patchright, drops the stealth plugins
npx patchright install chromium # patchright's browser
# and install real Chrome for channel:'chrome' (Debian/Ubuntu):
#   wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
#   sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

### Headed browser on a headless server (xvfb) — READ THIS if you're confused

The plain-English version:

- To beat a Cloudflare managed challenge we have to run Chrome **"headed"** — i.e. as if there's a real screen with a real window open. The Phase 0 spike proved *headless* Chrome (no window) gets caught and stuck on "Just a moment…"; only the headed one clears it.
- Your **prod server has no screen** (it's a droplet — no monitor, no desktop). So a headed Chrome has nowhere to draw its window and refuses to start.
- **`xvfb`** ("X Virtual FrameBuffer") is a fake, invisible screen. You install it once, and then you launch the worker *through* `xvfb-run`, which hands Chrome a pretend display to draw into. Chrome is happy, nobody ever sees a window, and the challenge clears. That's the whole trick.

On your Mac in dev you don't need any of this — macOS already has a real screen, so headed Chrome just opens a (briefly visible) window. xvfb is **only** for the screenless Linux server.

**The one thing to change on the droplet.** The harvest fetch happens inside the `citation-pipeline` queue worker (Supervisor program `hyperlit-citation`), so that worker is what must run under xvfb. Install xvfb **and `xauth`** (`xvfb-run` shells out to `xauth` to mint the display cookie — without it every headed launch dies with `xvfb-run: error: xauth command not found`, surfacing as `browser_launch_failed` in harvest), then prefix that program's `command` with `xvfb-run -a`:

```bash
sudo apt install -y xvfb xauth
```

Edit `deploy/supervisor/hyperlit-citation.conf` — the `command=` line, adding `xvfb-run -a` at the front:

```ini
; before:
command=php /var/www/hyperlit/artisan queue:work --queue=citation-pipeline --sleep=3 --tries=1 --timeout=7200 --max-jobs=10
; after:
command=xvfb-run -a php /var/www/hyperlit/artisan queue:work --queue=citation-pipeline --sleep=3 --tries=1 --timeout=7200 --max-jobs=10
```

Then apply it the same way that conf documents:

```bash
sudo cp deploy/supervisor/hyperlit-citation.conf /etc/supervisor/conf.d/
sudo supervisorctl reread && sudo supervisorctl update
php artisan queue:restart
```

`xvfb-run -a` auto-picks a free display number and tears the fake screen down when the worker stops — no other config needed. Each `node scripts/fetch-pdf.mjs` the worker spawns inherits that display automatically.

**Don't want to bother with xvfb?** Set `SOURCE_FETCH_HEADFUL=0` in `.env` (then `php artisan config:cache`). The browser then runs headless — fine for easy sites, but Cloudflare managed-challenge publishers will fail to `cloudflare_block` instead of importing. That's not an error or a crash: the work just lands in the book's Source Yield Report under "Failed to Harvest" for a human to grab by hand. So the choice is simply: **xvfb = we auto-grab the Cloudflare-walled PDFs; no xvfb = those specific ones get handed to you in the report instead.**

## FlareSolverr (the Cloudflare solver) — optional, free, self-hosted

FlareSolverr runs a real browser to solve Cloudflare "Just a moment…" challenges and hands back the cleared cookies. Run the official container (Docker):

```bash
docker run -d --name flaresolverr \
  -p 127.0.0.1:8191:8191 \
  --restart unless-stopped \
  ghcr.io/flaresolverr/flaresolverr:latest

curl -s http://127.0.0.1:8191 | head    # health check — expect a JSON banner
```

Bind it to `127.0.0.1` (as above) — it is an unauthenticated request-runner and must NOT be exposed to the internet; the firewall plus the localhost bind keep it private. It is a full Chromium, so budget ~300–700 MB RAM. Then point the app at it:

```bash
# in .env
FLARESOLVERR_URL=http://127.0.0.1:8191
# optional: FLARESOLVERR_MAX_TIMEOUT=60000  (ms per solve)
sudo -u www-data php artisan config:cache
```

Leave `FLARESOLVERR_URL` unset and the solver strategy simply no-ops — the app behaves exactly as before, so you can defer this. If you'd rather not use Docker, run FlareSolverr from its release under supervisor/systemd and point `FLARESOLVERR_URL` at it the same way.

## Proxy (residential + sticky-session capable) — strongly recommended

Cloudflare's IP-reputation WAF 403s fire before any JS challenge — only egressing from a residential IP clears those. AND, because `cf_clearance` is IP-bound, the proxy must support **sticky sessions** (the same IP held for the length of one fetch). IPRoyal, Bright Data, Oxylabs et al. all do this via a per-session token appended to the password.

**There is exactly ONE line you set here** — `SOURCE_FETCH_PROXY`, with the real host/port/credentials your proxy provider gave you (the value below is a placeholder; do not paste it verbatim):

```bash
# in .env — residential, sticky-capable proxy (replace with YOUR provider's creds)
SOURCE_FETCH_PROXY=http://user:pass@geo.iproyal.com:12321
sudo -u www-data php artisan config:cache
```

That's it. `SOURCE_FETCH_STICKY_SUFFIX` is **NOT a line you add** — it already defaults to IPRoyal's format (`_session-{id}_lifetime-10m`) in `config/services.php`, so on IPRoyal you set nothing and sticky sessions just work. Only touch it to *override* the default:

- **Different provider** whose sticky-token format differs → `SOURCE_FETCH_STICKY_SUFFIX=<their format, with {id} where the per-work token goes>`.
- **Disable sticky** (use a plain rotating proxy; managed challenges then become a coin-flip) → `SOURCE_FETCH_STICKY_SUFFIX=` (empty).

`ContentFetchService::stickyProxy()` rewrites the password to `pass{suffix}` per work, so the headed browser solve and the PDF download share one IP. Left `SOURCE_FETCH_PROXY` unset entirely, fetches go out from the server's own IP — best effort, and most Cloudflare publishers will hard-block (degrading to `cloudflare_block` in the Source Yield Report, not an error).

## Deploy checklist

```bash
cd /var/www/hyperlit && git pull
npm ci                                        # patchright in, stealth plugins out
npx patchright install chromium               # patchright's browser
npm run build
sudo -u www-data php artisan migrate         # routine
sudo -u www-data php artisan config:cache     # picks up UNPAYWALL_EMAIL / SOURCE_FETCH_PROXY / SOURCE_FETCH_STICKY_SUFFIX
./deploy/supervisor/workers.sh restart        # citation-pipeline worker MUST be wrapped in xvfb-run (see above)
```

Smoke test the whole ladder on one URL with `harvest:test-fetch` (creates a throwaway book, runs the real `fetch()`, prints a trace of sticky session + proxy + winning lane, then cleans up):

```bash
sudo -u www-data php artisan harvest:test-fetch \
  'https://www.tandfonline.com/doi/pdf/10.1080/14747731.2019.1651529?needAccess=true' \
  --doi=10.1080/14747731.2019.1651529
```

Expect the trace to show a sticky session, the masked proxy, and `Status: imported` with a real `%PDF-` on disk. This is also the **canary when bumping patchright** — re-run it after `npm update patchright`. Re-running a Source Network Harvester on a citation-heavy book should show more `assigned` and fewer `fetch_failed (cloudflare_block)`, with per-work detail like "imported … from europepmc.org". With no proxy / headless, a managed-challenge publisher degrades gracefully to `cloudflare_block` (never an error) and lands in the Source Yield Report for a human.
