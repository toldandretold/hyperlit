# Security hardening: complete the write-sanitize layer + harden search + fix misleading tests

## Context

The security suite now runs (RLS harness). Investigating its failures showed the app is well
defended (sanitize-on-write for most fields + DOMPurify on every render sink + comprehensive file-
upload validation + parameterized search), so most failures are false-alarm/aspirational/robustness.
BUT — per the "don't trust one layer; every layer must hold on its own" posture — the audit found
the **write-sanitize layer is incomplete** (several user-text fields reach the DB unsanitized, relying
only on render-time DOMPurify), plus a search robustness hole and a batch of misleading tests. This
plan completes each independent layer and makes the suite give honest signal. NOT exploitable today
(render layer covers it), but we harden anyway.

## A. Close write-path sanitize gaps (defense-in-depth — apply `NodeHtmlSanitizer::clean()`)
All in `app/Http/Controllers/`. NodeHtmlSanitizer is non-breaking (passes legit content/`<` through,
only scrubs real vectors, keeps text):
- **`DbHyperlightController`** — `highlightedText`: bulkCreate ~L176, upsert ~L322 (currently only
  `highlightedHTML`+`annotation` are cleaned).
- **`DbHyperciteController`** — `hypercitedText`: bulkCreate ~L181, upsert ~L329 (only `hypercitedHTML`
  cleaned today); also validate `relationshipStatus` as the known enum (whitelist, not sanitize).
- **`DbFootnoteController`** — footnote `content`: upsert ~L104/L118 (rich HTML, currently RAW).
- **`DbReferencesController`** — reference/bibliography `content`: upsertReferences ~L54 (RAW).
- **`DbLibraryController::sanitizeMetadata`** (~L827-835) — add `custom_license_text` to the field list.
  **`url`** needs a SCHEME check, NOT HTML sanitize: `NodeHtmlSanitizer::clean()` early-returns when
  there's no `<`, so a bare `javascript:alert(1)` URL slips through. Add a small URL guard (allow
  `http`/`https`/`mailto`/relative; reject or blank `javascript:`/`vbscript:`/`data:`), applied to
  `url` in both upsert (~L243) and bulkCreate (~L403).
- **`NodeHistoryController::restoreNodeVersion`** (~L484-485) — re-`clean()` content/plainText on
  restore (cheap hygiene; restored data predates current sanitizer).

Consider a single shared helper so the unified-sync fan-out can't reintroduce a gap (the sub-controllers
each sanitize independently today — `UnifiedSyncController` has no central gate; a missed field in any
sub-controller leaks). Lowest-risk: just close each field above; note the central-gate idea as follow-up.

## B. Search robustness — 500 → 422 (`SearchController`)
Malformed input reaches `to_tsquery('simple', ?)` (~L248/253/257) and throws Postgres SQLSTATE 42601
on `.get()` (~L262); the generic `catch (\Exception)` (~L60-66) returns **500** (info-leak + bad
contract). Catch the `QueryException`/`PDOException` with SQLSTATE `42601` (and `22023`) specifically
in `executeLibraryQuery()` + `searchNodes()` and return a graceful **422** ("invalid search query").
The query is parameterized so this is NOT injection — it's a robustness/DoS-surface fix. Also confirm
`buildTsQuery()` (SearchService) defensively strips tsquery metacharacters before the bind.

## C. Fix the misleading / wrong tests (so red = real regression)
- **FileUploadTest** (18 fail) — ALL post to the wrong route `/import/store`; real route is
  `/import-file` (`routes/web.php` ~L63). Fix the URL in the test → the (already-comprehensive)
  `ValidationService` assertions execute and pass. No app change.
- **XSS JSON-reflection tests** (`XssValidationTest` search test ~L412) — asserting a raw `<script>`
  substring isn't in a JSON body is a false alarm (JSON ≠ HTML; `X-Content-Type-Options: nosniff` is
  already set). Re-point to assert `$response->headers Content-Type application/json` + that the echoed
  query lives in a JSON field (`$response->json('query')`), not executable HTML.
- **SQLi "DROP TABLE users" test** (`SqlInjectionTest` ~L214-234) — `User::count()==0` is RLS hiding
  rows, not a dropped table. Assert via the admin connection (`User::on('pgsql_admin')->count()`) or set
  `app.current_user` first, so it actually verifies the table/rows survive (which they do).
- **SecurityHeadersTest** 2 fails — calls non-existent `/api/home` (~L55) and a content-type case that
  404s (~L305). Point them at real endpoints (e.g. an existing GET API route) so they assert the headers
  that the `SecurityHeaders` middleware already sets.
- The **aspirational "stored not XSS" tests** (hyperlight/hypercite/footnote/reference) PASS automatically
  once §A lands (stored value is now sanitized) — no test edits needed; verify they go green.

## D. Out of scope — flag, don't do here
- **Strict CSP `script-src` (nonce-based, drop `unsafe-inline`)** — `SecurityHeaders.php` (~L42-47)
  deliberately omits `script-src` because the app uses inline scripts + Vite HMR; the comment marks it a
  separate deliberate pass. This is the single highest-value remaining layer (stops XSS *execution* even
  if sanitize fails) but is a large, app-wide, breakage-prone change. Recommend as its own future pass.
- File-upload validation + CORS + the rest of the security headers are already solid (audit found no real
  gap) — leave them.

## Verification
- `./vendor/bin/pest tests/Feature/Security/` — the §A-affected XSS "stored not sanitized" tests go green;
  FileUploadTest green after the route fix; SQLi/JSON-reflection/SecurityHeaders fixed tests green; RLS
  insert errors stay 0. Expect failed-count to drop sharply; remaining red should be only genuinely-
  aspirational items (document them).
- Targeted: a new/auditing test that posts `<img src=x onerror=…>`/`javascript:` URL to each hardened
  endpoint and asserts the STORED value (read via admin conn) has the vector stripped.
- `php -l` on every edited controller; `php artisan route:list` unaffected.
- `grep -rn "whereRaw\|selectRaw\|DB::raw\|->raw(" app` — quick pass to confirm no OTHER raw SQL
  concatenates user input (parameterization audit), since we're hardening the "can't really run" layer.
- No frontend change → no `npm` impact; the JS render layer (DOMPurify) is already complete.

## Notes
- Severity framing: these are defense-in-depth completions, not live-exploitable holes (render layer +
  parameterization currently cover them). We fix them so no single layer is load-bearing.
- Per repo rule: do not git commit.
