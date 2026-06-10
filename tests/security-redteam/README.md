# Red-Team Harness (`tests/security-redteam/`)

An **offensive** security harness that actively attacks a running Hyperlit
instance and writes a documented findings report. It's the "try to break in"
counterpart to the assertion-based Pest suite in `tests/Feature/Security/`
(which proves specific defenses hold in isolation, in CI, against a test DB).

- **Pest `Feature/Security/`** → unit-style, white-box, in-process, CI. "Does the
  RLS policy reject this exact query?"
- **This harness** → black-box, over real HTTP, against a live server. "If I were
  an attacker with an account, what could I actually pull or break?"

It is **dependency-free** (pure PHP + ext-curl, no composer autoload, no
framework bootstrap), so it can be pointed at local, staging, or any host you
own without setup.

---

## ⚠️ Safety & authorization

- **Only run this against a host you own / are authorized to test.** Point it at
  **local or staging**, never production.
- It **creates real accounts** on the target (via `/api/register`), and in
  `--aggressive` mode it makes **real Stripe test-mode checkout sessions**,
  **outbound SSRF fetches** from the server, and sends **heavy DoS payloads**.
- The default (safe) mode is read-only-ish: recon, auth probes, SQLi, IDOR
  setup, path traversal, and privilege-escalation attempts against the harness's
  **own throwaway accounts** only. It never touches other users' data.

---

## Usage

```bash
# Safe mode (read-only probes) against the local dev server:
php tests/security-redteam/run.php --target=http://hyperlit.test

# Full run including destructive probes (rate-limit burst, SSRF, Stripe, DoS):
php tests/security-redteam/run.php --target=http://hyperlit.test --aggressive

# List every probe (destructive ones are tagged):
php tests/security-redteam/run.php --list

# Run only specific probes (substring match, case-insensitive):
php tests/security-redteam/run.php --only=sql,idor

# See every HTTP request on stderr:
php tests/security-redteam/run.php --verbose
```

| Option | Meaning |
|---|---|
| `--target=URL` | Base URL to attack (default `http://hyperlit.test`). |
| `--aggressive` | Also run destructive probes. Off by default. |
| `--only=a,b` | Run only probes whose name contains one of these substrings. |
| `--marker=STR` | Prefix for throwaway accounts (default `rt`; keep ≤4 chars — usernames must be ≤30). |
| `--list` | List probes and exit. |
| `--verbose` | Log every HTTP request. |

**Exit code:** `0` if no `VULNERABLE` findings, `1` if any were confirmed —
so you can gate a pipeline on it (`php run.php --target=… || alert`).

---

## What it does each run

1. **Provisions accounts.** Registers + logs in two throwaway users against the
   live target: an **attacker** (the account we act as) and a **victim** (whose
   private data the attacker must not reach). If the throttle blocks
   registration, it backs off and retries (a single run is reliable; spamming
   runs will trip the limiter — which is itself the rate-limit defense working).
2. **Runs the probes** in order (recon → auth → injection → heavy), each
   emitting `VULNERABLE` / `SAFE` / `INCONCLUSIVE` findings.
3. **Writes the report** to `reports/report-<timestamp>.md` (human) and
   `.json` (machine), plus refreshes `reports/latest.md`. Runs are timestamped,
   never overwritten — so you can diff this month's posture against last month's.

`SAFE` findings are recorded on purpose: a report that only lists holes tells
you nothing about coverage. "Tried X, correctly blocked" is how you trust the
suite actually exercised the defense.

---

## Probes

| Probe | Class | Destructive | What it attacks |
|---|---|:---:|---|
| Info Disclosure & Headers | `InfoDisclosureProbe` | | Missing security headers, version leakage, **APP_DEBUG stack-trace leak**, over-sharing `session-info`. |
| Sensitive File Exposure | `SensitiveFilesProbe` | | `.env`, `.git/`, logs, dumps, `phpinfo`, Telescope/Horizon, `.DS_Store`. |
| Cookie Security | `CookieSecurityProbe` | | `HttpOnly`/`SameSite`/`Secure` flags on the session + XSRF cookies. |
| Auth & Access Control | `AuthBypassProbe` | | Hits every protected endpoint anonymously (expects 401/403); checks a non-admin can't reach `admin` routes. |
| User Enumeration | `UserEnumerationProbe` | | Forgot-password + register differential — does the app reveal which emails are registered? |
| IDOR / Cross-Tenant | `IdorProbe` | | Victim creates private vibes/shelves; attacker tries to **read/modify/delete them by id**. |
| Content IDOR | `ContentIdorProbe` | ✓ | Victim plants a **private book** with a secret; attacker tries to read its data/snapshots and write nodes into it. |
| SQL Injection | `SqlInjectionProbe` | | Error-based, boolean-based, and **time-based (`pg_sleep`)** payloads on search params + book route segments. |
| Privilege Escalation | `PrivilegeEscalationProbe` | | Self-grant credits, self-upgrade tier, **mass-assign** `is_admin`/`role`/`tier` via preferences. |
| Admin Impersonation | `AdminImpersonationProbe` | ✓ | Registers magic usernames (`admin`/`root`/…) and checks they can't reach the admin-only credit endpoint. |
| Path Traversal | `PathTraversalProbe` | | `../../etc/passwd` / `.env` through the media + book-json routes. |
| Stripe Webhook Forgery | `WebhookForgeryProbe` | | Forged `checkout.session.completed` with no/bad signature → must 400 and grant no credit. |
| Rate Limiting | `RateLimitProbe` | ✓ | Bursts the login route; expects a 429 to fire. |
| Open Redirect | `OpenRedirectProbe` | ✓ | Stripe checkout `return_url` → off-site redirect. |
| Stored XSS | `StoredXssProbe` | ✓ | Creates a public book and injects XSS into node content + highlight HTML/annotation; checks survival through the read API. |
| SSRF | `SsrfProbe` | ✓ | Aims url-import/scrape at metadata/loopback/`file://`. |
| Denial of Service | `DosProbe` | ✓ | Oversized body, deeply-nested JSON, search-pagination amplification. |

### Adding a probe

Drop a class into `probes/` extending `RedTeam\Probe`, implement `name()` and
`run(): Finding[]`, override `destructive()` if it writes/floods, then add it to
the `$probeClasses` list in `run.php`. Use the `vuln()` / `safe()` /
`inconclusive()` helpers from the base class. Probes must never throw — wrap
risky calls and emit `inconclusive()` instead, so one flaky endpoint can't abort
the run.

---

## Reports

`reports/` holds the artifacts. `latest.md` always points at the most recent
run. The `.md` is what you revisit; the `.json` is for diffing/automation.
`reports/` is git-ignored except for this README and `.gitkeep` — findings can
contain environment specifics, so they're not committed by default.

---

## Cleanup

Throwaway accounts are named `<marker>_attacker_*` / `<marker>_victim_*` with
`@redteam.local` emails (default marker `rt`). They (and any vibes/shelves they
created, which the IDOR probe deletes inline) accumulate in the DB. To purge:

```bash
php artisan tinker --execute="
  \$names = DB::connection('pgsql_admin')->table('users')
      ->where('email','like','%@redteam.local')->pluck('name');
  DB::connection('pgsql_admin')->table('vibes')->whereIn('creator',\$names)->delete();
  DB::connection('pgsql_admin')->table('shelves')->whereIn('creator',\$names)->delete();
  DB::connection('pgsql_admin')->table('users')->where('email','like','%@redteam.local')->delete();
  echo 'purged '.\$names->count().' red-team accounts'.PHP_EOL;
"
```

(Uses the `pgsql_admin` BYPASSRLS connection because the `users` table blocks
deletes from the app role under RLS — same pattern the Pest suite uses.)

---

## Known findings baseline

**Fixed (verified by re-run):**
- ~~Privilege escalation — register the username `admin` → mint unlimited
  credits~~ (was **Critical, live-exploited**). `BillingController::addCredits`
  gated on `$admin->name === 'admin'` (a username string) instead of the
  `is_admin` column; the name was unclaimed. Now uses `$admin->isAdmin()`.
  Regression probe: `AdminImpersonationProbe` (4/4 SAFE).
- ~~EPUB extraction "security theatre"~~ — `EpubProcessor` *logged* `..` entries
  then `extractTo()`'d the whole archive anyway (only libzip's path-sanitising
  saved it). Now builds a real allow-list, extracts per-file with a realpath
  escape-check, and strips symlinks (mirrors `ZipProcessor`).
- ~~Unvalidated `bookId` → path traversal~~ in `vibe-convert`, `conversion-tests`,
  `integrity` endpoints (fed into `resource_path("markdown/{bookId}")`). Added
  `regex:/^[A-Za-z0-9_\/-]+$/` (allows sub-book `/`, blocks `..`).
- ~~Open redirect via Stripe `return_url`~~ → now validated `url` + `starts_with:`
  app URL, with a server-side clamp (`StripeController::createCheckoutSession`).
- ~~Missing CSP~~ → `SecurityHeaders` middleware now sends
  `frame-ancestors/base-uri/object-src/form-action`.
- ~~`X-Powered-By` version leak~~ → stripped in `SecurityHeaders`.
- ~~`public/.DS_Store` served~~ → deleted + untracked.
- HSTS is added by the middleware over HTTPS (not visible on local HTTP).

- **Stored XSS — was Critical, NOW FIXED (verified).** Node `content`,
  `highlightedHTML`, and `annotation` were stored verbatim and the reader's
  DOMPurify ran too late: `applyHighlights`/`applyHypercites` assigned the **raw**
  content to a detached `innerHTML` (`lazyLoaderFactory.js:1525/1387`) **before**
  the final `sanitizeHtml()`, and `renderBlockToHtml()` returned `block.content`
  unsanitised. A Playwright PoC proved an `<img onerror>` in a public book
  *executed* in a viewer browser. **Fixed in two layers, both verified:**
  1. _Client:_ `sanitizeHtml()` now runs AT the detached-innerHTML sink in both
     `applyHighlights`/`applyHypercites` (covers every caller + old rows). PoC now
     passes (`fired=false`, content still renders).
  2. _Server:_ `App\Services\Security\NodeHtmlSanitizer` (blocklist, gated so clean
     content is byte-identical) scrubs every HTML-bearing field AND its `raw_json`
     copy on write, across all four write controllers:
     - `DbNodeChunkController` — node `content`
     - `DbHyperlightController` — `highlightedHTML`, `annotation`
     - `DbHyperciteController` — `hypercitedHTML`
     - `DbLibraryController` — `title`/`bibtex`/`note`/… metadata (rendered into
       `innerHTML` by `displayCitations.js` / `bibtexProcessor.js`, so also a vector)

     The red-team `StoredXssProbe` reports 7/7 SAFE; library `title`/`bibtex`
     round-trip verified stripped.

  > PoC: `npx playwright test --config tests/e2e/playwright.security.config.js`
  > (auto-remaps the `public/hot` Vite host to 127.0.0.1 so headless Chromium can
  > boot the SPA). It's a regression guard — green now, would go red if either
  > layer regresses. Server unit test: `tests/Unit/NodeHtmlSanitizerTest.php`.

**Open:**

**Accepted / infra:**
- **`Server: nginx/<ver>` banner** (Low, infra). Set `server_tokens off;` on the
  droplet/Herd nginx — can't be done from PHP.
- **Register confirms email existence** (Low, commonly accepted). 422 "already
  registered" is an enumeration vector; forgot-password is correctly generic.
- **No request-body size cap** (Low, intentionally left — large EPUB/book uploads
  need big bodies; a small `client_max_body_size` would break imports).
- **`SESSION_SECURE_COOKIE` unset** — set it `true` in prod so the session cookie
  gets the `Secure` flag over HTTPS.

Strong defenses observed (recorded as `SAFE`): parameterized queries everywhere
(no SQLi surfaced), RLS + creator/visibility checks on content read AND write
(content IDOR fully blocked — private books 403, cross-tenant node writes
rejected), **Stripe webhook signature verification** (forged events 400),
host-/identifier-allowlisted URL fetching (SSRF blocked), traversal-sanitized
media routes, `HttpOnly`+`SameSite` session cookie, anon-token claim bound to the
HttpOnly cookie, and throttled auth endpoints. `.env` is git-ignored and untracked.
