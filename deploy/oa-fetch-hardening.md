# Pulling open-access PDFs past Cloudflare (and how to ship it)

This documents the open-access fetch hardening — why it exists and the one-time prod steps — so future-you doesn't rediscover it. It applies to every path that pulls source content: the Source Network Harvester, `citation:vacuum`, `library:create-auto-versions`, and URL import all share `App\Services\ContentFetchService::fetch()`.

## The problem, in one paragraph

Legitimately open-access works kept failing with `cloudflare_block`. Two root causes: (1) the fetch ladder only ever tried ONE `oa_url` and ONE `pdf_url`, so when that single URL pointed at a Cloudflare-walled publisher we never tried the clean repository copy (arXiv, PMC, Zenodo, an institutional DSpace) that usually also exists; and (2) the last-resort headless browser ran with weak stealth and — the real killer — from the server's **datacenter IP**, which Cloudflare blocks by reputation no matter how good the JS-challenge handling is. The fix is two-sided: find a clean copy so we never hit Cloudflare (free, biggest win), and actually beat Cloudflare when no clean copy exists (better stealth + a self-hosted FlareSolverr solver + an optional residential proxy).

## What runs where

The ladder now: JATS full text → a ranked loop over EVERY known OA copy (OpenAlex `locations[]` + Unpaywall + Semantic Scholar + Crossref, deduped and sorted repository-host-first via `OaLocationResolver`, with `LandingPagePdfLocator` pulling the real PDF off repository landing pages) → plain HTML → the Playwright browser (now `playwright-extra` stealth, ~18s Cloudflare wait, proxy-ready) → and finally, only when something returned a Cloudflare block AND a solver is configured, `FlareSolverrClient`. Everything after the OA-location loop is a fallback; most works now resolve from a repository copy and never reach the browser.

## One-time prod steps

Set the free Unpaywall contact email (keyless, but the API rejects requests without it — any real address you control):

```bash
# in .env
UNPAYWALL_EMAIL=you@example.org
```

Install the new browser deps (the stealth plugin) and make sure Chromium is present for the fetch scripts:

```bash
cd /var/www/hyperlit && git pull
npm ci                          # brings in playwright-extra + puppeteer-extra-plugin-stealth
npx playwright install chromium # no-op if already installed for the existing scripts
```

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

## Proxy (the real fix for datacenter-IP blocks) — optional

Cloudflare's hardest blocks are IP-reputation WAF 403s that fire before any JS challenge — no stealth or solver clears those, only egressing from a residential/rotating IP does. If you have such a proxy, set it and it flows through both the HTTP fetches and the Playwright/FlareSolverr browsers:

```bash
# in .env
SOURCE_FETCH_PROXY=http://user:pass@proxy-host:port
sudo -u www-data php artisan config:cache
```

Left unset, fetches go out from the server's own IP — best effort. Be honest with yourself here: without a residential egress, some publishers will still hard-block regardless of FlareSolverr.

## Deploy checklist

```bash
cd /var/www/hyperlit && git pull
npm ci
npm run build
sudo -u www-data php artisan migrate         # no new migrations in this change, but routine
sudo -u www-data php artisan config:cache     # picks up UNPAYWALL_EMAIL / FLARESOLVERR_URL / SOURCE_FETCH_PROXY
./deploy/supervisor/workers.sh restart        # the harvester runs on the citation-pipeline queue
```

Smoke test: pick a known open-access-but-Cloudflare-walled DOI (the Samir Amin case from the last harvest) whose stub book id you have, and run:

```bash
sudo -u www-data php artisan citation:vacuum <stubBookId>
```

Expect it to resolve a repository copy now (watch which host wins in `library.pdf_url`), or — with FlareSolverr up — to clear the challenge and import. With FlareSolverr down/unset it must degrade gracefully to a `cloudflare_block` failure, never an error. Re-running a Source Network Harvester on a citation-heavy book should show more `assigned` and fewer `fetch_failed (cloudflare_block)` in the harvest telemetry, with per-work detail like "imported … from europepmc.org".
