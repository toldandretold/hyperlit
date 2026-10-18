# Privacy policy — annotated internal version

This is the engineering record behind the public privacy page. Every claim carries a `> verified:` line citing the code that proves it, so we know exactly what we have and have not confirmed. The public page is a Hyperlit BOOK at `/privacy` (the `/license2025content` pattern — served through the catch-all, no route, no reservation), created on prod by the operator from `docs/privacy-page.md`; when the code changes, update THIS file first, then mirror the prose there and in the live book. Contact on the public page is sam@hyperlit.io. Facts verified 2026-10-15.

## What we collect

### Account

Registration collects exactly three user-supplied fields: username, email, password (bcrypt-hashed). A `user_token` UUID is minted server-side as the RLS secret.

> verified: `app/Http/Controllers/AuthController.php:82-99` (SPA path validates name/email/password, inserts hash + user_token); `app/Actions/Fortify/CreateNewUser.php:40-50` (no-JS path, same three); both share `app/Support/UsernameRules.php:30-61`.

The users table additionally holds billing tier/credits/debits, preferences, is_admin, email_verified_at — all app-generated, not collected.

> verified: `database/schema/pgsql_admin-schema.sql:1293-1311` (note: that dump is stale for OTHER tables; live DB is authority).

Passkeys/E2EE: the server stores only the public-key credential and a blind wrapped vault key; the recovery code is shown once and never stored.

> verified: `app/Http/Controllers/E2eeVaultController.php:9-13`; `app/Http/Controllers/PasskeyController.php:77,92,113`.

### Anonymous identity

`anon_token` is a random UUID cookie: 90 days, HttpOnly, SameSite=Lax, minted at `POST /api/anonymous-session`. The server-side row stores the token, created_at/last_used_at, **ip_address, and user_agent** (truncated to 500 chars). Rows are deleted 30 days after last use by a daily sweep. An IP change on an existing token is logged.

> verified: mint `routes/api.php:320` → `AuthController.php:210-220` (cookie attrs), `:330-336` (row contents), `:176-183` (IP-change log); retention `app/Console/Commands/CleanupAnonymousSessions.php:15-17` + schedule `routes/console.php:18-19`; tolerant read `app/Support/AnonToken.php`.

### Session + CSRF cookies

Laravel session cookie: database driver, 120-minute lifetime, http_only, SameSite=Lax. XSRF-TOKEN read by the SPA for request headers. A legacy `anon_author` cookie is still read by the download-all owner check.

> verified: `config/session.php:21,35,185,202`; XSRF usage e.g. `resources/js/e2ee/lifecycle.ts:39`; legacy cookie `routes/web.php:299`.

### Reading telemetry

Identity is stamped SERVER-side (authenticated name, else the anon cookie), never taken from the request body; no identity → 401, not counted. One row per (page/book, identity, day) via `ON CONFLICT … DO NOTHING` — the day-dedup is enforced at write time, which is why post-deletion scrubbing of `user_name` keeps historical counts honest. `book_reads` also records which chunk ranges were seen (bounded payload, max 2000 ids). `user_reading_positions` is a resume bookmark keyed (book, identity).

> verified: `app/Http/Controllers/PageViewController.php:28,37-55` (whitelist 'home', server identity, ON CONFLICT); `app/Http/Controllers/ReadingTelemetryController.php:26,33,37-39,42-51,65-78`; `app/Http/Controllers/DatabaseToIndexedDBController.php:1983-2007` (position write).

Retention — 90-day de-identification: `telemetry:rollup` (scheduled daily, `routes/console.php`) folds raw rows older than `config('telemetry.raw_retention_days')` (90) into identity-free daily counts (`book_read_rollups` / `page_view_rollups`, no identity columns BY DESIGN) and deletes them, atomically per table. Totals never change: `ReadStatsCounter` and the maintainer stats sum raw + rollups; the 30-day windows and the depth funnel read raw only (retention floor of 31 enforced by the command). All-time "distinct readers" is deliberately unknowable after the sweep — the un-knowability IS the privacy feature. Changing the retention value means updating the public page's "after 90 days" sentence too.

> verified: `app/Console/Commands/TelemetryRollup.php`; `config/telemetry.php`; consumers `app/Services/Stats/ReadStatsCounter.php` + `app/Http/Controllers/Maintainer/StatsController.php` + the funnel comment in `CreatorStatsController.php`; locked by `tests/Feature/Stats/TelemetryRollupTest.php` (fold/delete, no double-count on re-run, total_views invariant, retention floor).

### Device-local only (never sent anywhere)

`TAB_ID` in sessionStorage (cross-tab edit dedup); localStorage auth cache / reading positions / UI prefs / debug flags / draft form data; IndexedDB `MarkdownDB` holding the local book corpus.

> verified: `resources/js/utilities/BroadcastListener.ts:25-41`; `resources/js/utilities/auth/session.ts:102,114,277-278`; `resources/js/indexedDB/core/connection.ts:207`.

### Server logs

IPs land in application logs around auth events: anonymous-session mint/failure/rate-limit, anon-token IP change, RequireAuthor checks. IP is also a rate-limit key (login, Fortify, API throttles). Telemetry failure logs carry page/book + error only, no identity. RLS-context failure logs deliberately record booleans, not values. Laravel logs go to local files; no log-shipping SaaS configured.

> verified: `AuthController.php:176-183,318-348`; `app/Http/Middleware/RequireAuthor.php:29,39`; rate-limit keys `app/Providers/AppServiceProvider.php:164-183`, `app/Http/Requests/Auth/LoginRequest.php:83`; clean failure logs `PageViewController.php:62-65`, `SetDatabaseSessionContext.php:87-91`; channels `config/logging.php:21,55-67,132-142`.

> NOT verified from repo: nginx access-log config on the droplet (no nginx conf in `deploy/`). The public page says "standard operational logs" generically on purpose. Confirm host config before saying anything more specific.

## Analytics

Cloudflare Web Analytics (cookieless beacon) is on every page via the shared layout — the ONLY third-party script served. Decision 2026-10-15: keep and disclose.

> verified: `resources/views/layout.blade.php:353`; absence of GA/GTM/Plausible/Matomo/Segment/Mixpanel/Hotjar/PostHog/Sentry/Bugsnag confirmed by repo-wide scan (no hits in `resources/`, `config/`, `app/`, `composer.lock`).

## Third-party processors

User content leaves the server ONLY for user-invoked features:

- **Fireworks AI** — default LLM transport for AI brain / citation review / archivist; receives selected passages, node text, citation strings.
> retention claim verified 2026-10-15: "does not log or store prompt or generation data for any open models, without explicit user opt-in" — https://docs.fireworks.ai/guides/security_compliance/data_handling. Caveats checked: the Response API's store=True 30-day retention does NOT apply (LlmService calls /chat/completions); FireOptimizer logging is opt-in and not enabled; prompt caching is volatile memory for minutes. Provider claims can change — re-check before republishing the page.
> verified: `config/services.php:46`; `app/Services/LlmService.php:125,302`.
- **DeepInfra** — alternate LLM transport; Kokoro TTS receives node text for narration.
> retention claim verified 2026-10-15: "Input data is not stored to disk during inference … Output data is not stored — it is sent to you and then deleted from memory"; "We do not use data you submit to our APIs for training models, except when using Google or Anthropic models" — https://docs.deepinfra.com/account/data-privacy. Caveats checked: image-generation storage does not apply (we use Kokoro TTS + open-weight LLMs); bulk APIs unused; we use no Google/Anthropic models via DeepInfra. Provider claims can change — re-check before republishing the page.
> verified: `config/services.php:140,229-241`; `app/Services/Tts/DeepInfraKokoroProvider.php:38-40,77-80`.
- **Embeddings** — node plainText to the configured LLM endpoint (nomic-embed).
> verified: `app/Services/EmbeddingService.php:56,58,134,180`; model `config/services.php:56`.
- **Mistral OCR** — uploaded PDF pages at import. On-device `native_ocr` (Apple Vision) exists as an alternative.
> verified: `config/services.php:189-199` (mistral), `:204-215` (native).
- **Translation** — `hosted` rides the LLM endpoint; `ollama` is local (localhost:11434) and the ONLY option for E2EE books; `dedicated` is any OpenAI-compatible endpoint the operator points at.
> verified: `config/services.php:254-256,260-317`; `app/Services/Translation/BookTranslationService.php:100-103`.
- **Brave Search / OpenAlex / Semantic Scholar / Unpaywall / CORE** — citation-resolution queries built from bibliographic fields (quoted title + author surname + year), not the user's prose. Unpaywall requires a contact email query param.
> verified: `app/Services/BraveSearchService.php:77-82,398-419`; `config/services.php:38-43,409,415-418,424-426`.
- **Stripe** — session-only integration (raw stripe-php, NO Cashier, no stored customer ids). We pass user_id + credit_amount in metadata; card details never touch our server.
> verified: `app/Http/Controllers/StripeController.php:62-80,88-96`; `composer.json:22`.
- **Email** — recipient address + links (verification, resets, completion notices).
> NOT verified from repo: the production mail vendor (`config/mail.php:17` defaults to env; local .env is Mailpit). Check the droplet `.env` before naming a processor publicly.

## E2EE exclusions

The client is the encryption boundary; the server can't decrypt but enforces exclusions.

> verified (boundary + backstops): `app/Services/E2ee/EncryptedBookGuard.php:8-20,36-48`.

Refusal sites, each independently enforced server-side: AI brain 422 (`app/Http/Controllers/AiBrainController.php:179-183`; hypercite-target text never quoted, `app/Services/AiBrain/ReadingContextFormatter.php:167`); vibe convert (`VibeConvertController.php:46-50`); citation metadata 403 with the free local tier still working client-side (`CitationMetadataController.php:110-116`); citation scan (`CitationScannerController.php:34-35`); harvest (`SourceHarvestController.php:421`); no slug/public URL (`DbLibraryController.php:1451-1453,1587`); embeddings excluded + race-proof recheck inside the UPDATE (`EmbeddingEligibility.php:15-17`, `app/Jobs/GenerateNodeEmbedding.php:94-100`); search cannot index ciphertext and never returns private books (`SearchService.php:104-109,141,280,596-608`); server-side translation refused (`BookTranslationService.php:100-103`); TTS/audiobook refused (`app/Jobs/GenerateBookAudioJob.php:94-99`, `app/Jobs/BuildAudiobookJob.php:60-65`); plaintext writes 422 at every sync endpoint (`BeaconSyncController.php:69-72` + DbNode/DbHyperlight/DbHypercite/DbFootnote/DbReferences/SubBook controllers). Locked by `tests/javascript/e2ee/noPlaintextLeaves.test.js` + `tests/Feature/E2ee/*`.

Honest caveat (stated on the public page): import-then-encrypt means the server — and for PDFs, Mistral OCR — saw the book once during conversion. The lock transition scrubs plainText + embeddings tree-wide, conversion artifacts on disk, legacy public images, and the `nodes_history` plaintext mirror.

> verified: `DbLibraryController.php:1195-1203` (docblock), `:1287-1291,1292-1300,1302-1307,1333-1349`.

## Access control (RLS)

Postgres session identity (`app.current_user`, `app.current_token`) is set per request by middleware on both web and api groups; ~80 row-level-security policies filter every read/write against it. Users table SELECT is own-row-only and additionally requires the token match. No identity → public reads only.

**Claim boundary — never overstate RLS.** RLS protects against OTHER USERS and application bugs on the RLS-subject connection. It does NOT protect against the operator: `pgsql_admin` bypasses RLS (table owner, `config/database.php:120`), so anyone with database credentials (psql, Postico) can read every non-encrypted private book in plaintext. The public page must say "private from everyone except the operator" and point to E2EE as the holds-against-us option — only encrypted books are unreadable to the operator. Caught 2026-10-15: an earlier draft said "no one can read your private data", which was false as stated.

> verified: `app/Http/Middleware/SetDatabaseSessionContext.php:16-23,61-64,81-84`; `bootstrap/app.php:46,58`; policies `pgsql_admin-schema.sql:2434` (users), `:2293` (library public-or-mine), `:2067` (anon sessions self-only).

## Export paths (the data-portability claims)

Owner-only full raw ZIP per book (library/nodes/footnotes/hyperlights/hypercites/bibliography + original uploads, creator_token stripped) — `routes/web.php:293-378`. Per-book md/json endpoints — `routes/web.php:190-276`. Client-side Markdown/DOCX/EPUB generation — `resources/js/components/sourceContainer/downloads.ts:2-6`. Audiobook m4b — `routes/web.php:396`. Original PDF — `:405`. Archive/corpus export (markdown vault + SQLite), audience computed server-side — `routes/api.php:247-258` + `app/Services/Export/*`. Billing ledger export — `routes/api.php:108`.

## Public-by-choice

New books default private; publishing is an explicit confirmed action; publishing requires a verified email for accounts created after the cutoff and anonymous users can never publish; encrypted books are pinned private with no slug. Default content license CC-BY-SA-4.0-NO-AI, explained at `/license2025content` (served as a book via the catch-all).

> verified: `app/Models/PgLibrary.php:146`; `resources/js/components/sourceContainer/visibilityControl.ts:36-70`; `config/publishing.php:8-20,44-47`; `resources/js/components/sourceContainer/licenseInfo.ts:21,37`.

## Retention + deletion

Anonymous-session rows: 30 days after last use. Account deletion (profile menu → Data sovereignty → Delete account): the user chooses the fate of published books and public annotations (delete / anonymize / keep); private + unlisted + encrypted books and private annotations are always deleted; telemetry rows anonymized (`user_name → NULL`, counts preserved — dedup happened at write time); billing ledger retained against a scrubbed tombstone users row (the FK + financial-records obligation); username permanently retired (`deleted_usernames`, enforced by `UniqueUsername` + `SlugRules`); deleted public book URLs serve a 410 tombstone with content scrubbed and the slug reserved against squatting; completion confirmed by email to the pre-scrub address.

> verified: `app/Services/UserAccountDeletionService.php` (phase-by-phase disposition); endpoint `app/Http/Controllers/AccountDeletionController.php` + login guard `AuthController::login` / `FortifyServiceProvider`; 410 tombstone `TextController::show` + `resources/views/book-deleted.blade.php`; locked by `tests/Feature/Account/UserAccountDeletionServiceTest.php`, `AccountDeletionEndpointTest.php`, `tests/Feature/Auth/DeletedUsernameNotRegistrableTest.php`, `tests/Feature/Routing/DeletedBookTombstoneTest.php`, and the client flow by `tests/javascript/components/deleteAccountFlow.test.js`.

## Ownership (declared 2026-10-17)

Copyright holder: **Lib Zen Pty Ltd** (© 2024–2026), stated in `LICENSE.md` (header block), `README.md` §License & ownership, `composer.json`/`package.json` SPDX fields (`AGPL-3.0-only` — composer previously mislabelled MIT, fixed 2026-10-17), and the public privacy/terms pages. The Hyperlit name and logo are claimed as trademarks of Lib Zen Pty Ltd. Open sub-questions for the lawyer pass: (1) founder-to-company IP assignment (Sam built it with company money but may lack a formal employment contract — a one-page assignment ends the question); (2) logo artwork copyright may sit with the commissioned designer absent assignment (Sam is asking him; a repo credit is the friendly resolution); (3) confirm governing-law state in the ToS (drafted as NSW — verify against the company's registration).

## Open items before public assertions change

- Prod mail vendor: check droplet `.env`.
- Nginx/host log retention: host-level, not in repo.
- ABN: fill into the privacy + terms pages.
- Lawyer review of the public pages (AU Privacy Act / GDPR / COPPA posture, ToS, ownership sub-questions above) before DPG submission.
