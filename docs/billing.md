# Billing: how users are charged, and how it's tested

This is the map of every dollar that moves through hyperlit: what we charge for, the math, where charges are recorded, what the user sees, what happens when a paid job fails, and exactly which automated tests lock each piece. Core engine: `app/Services/BillingService.php`. Rate card + tiers: `config/services.php`.

## The money model

- **1 credit = $1 USD.** Users buy credits through Stripe checkout; a webhook adds them to `users.credits`.
- **Charges are raw cost × tier multiplier.** Every priced feature computes its RAW cost (what the API actually cost us) and hands it to `BillingService::charge()`, which multiplies by the user's tier and rounds to 4 decimals.
- **`users.debits` is the running spend** for pay-as-you-go users; balance = `credits - debits` (the `balance` accessor on `App\Models\User`). Premium users are NEVER debited — their charges go to the ledger only, so their balance stays clean on downgrade.
- **`billing_ledger` is the single source of truth** — an immutable, append-only table (no `updated_at`). One row per charge or credit: `type` (debit/credit), `amount` (post-multiplier), `description`, `category`, `line_items` (itemized receipt), `metadata` (always carries `raw_cost`, `multiplier`, `tier`), `balance_after`. There is no separate transactions table; the ledger IS the transaction log.
- **Charges happen AFTER the work succeeds** (post-success model). Pre-flight there is only a gate: `canProceed()` (premium always yes; pay-as-you-go needs balance > 0) and, for audio, an atomic `reserveCredits()` hold.

### Tiers (`config/services.php` → `billing_tiers`, keyed by `users.status`)

- **premium** — ×1.0, ledger-only (never debited); the subscription absorbs usage.
- **budget** — ×1.5, pay-as-you-go with overhead.
- **solidarity** — ×2.0, voluntary higher rate.
- **capitalist** — ×5.0, institutional.
- Unknown status falls back to budget's 1.5× (`User::getBillingMultiplier`).

## What is charged

### PDF import OCR (`category: ocr`)

- **Rate** — pages / 1000 × the per-1k-pages price of the SERVED model recorded in `ocr_response.json` (`BillingService::ocrPricePerKPages`): `mistral-ocr-2512` (OCR 3, the pinned production model) $2.00/1k, `mistral-ocr-4-0` $4.00/1k. Unknown/absent model falls back to the pinned config model (`services.mistral_ocr.model`).
- **When** — at the very END of `ProcessDocumentImportJob`, after conversion + all DB saves succeeded, via `BillingService::billOcrForBook`.
- **Idempotency** — the `ocr_charged.json` marker next to the book's markdown; a job retry or reconvert-from-cache never re-bills. `ImportController::reconvert` clears the marker only when a NEW source file will be OCR'd fresh.
- **Free paths** — client-side OCR (the Mac app's native engine, or the user's own Mistral key) is server-stamped with a `hyperlit-` model prefix and never billed, belt-and-braces even if the zero-charge marker is lost; server-side native OCR writes the zero-charge marker itself (`PdfProcessor::runNativeOcrIfConfigured`); non-OCR lanes (epub/md/html/docx) have no `ocr_response.json` and bill nothing.

### Source harvest (`category: ocr`, one charge per harvested work)

- Same `billOcrForBook` engine as import — each freshly converted work is billed after ITS conversion succeeds (`HarvestRunner::chargeWorkOcr`); already-wired stubs and failed fetches bill nothing.
- The pre-run estimate (`SourceHarvestController::estimateCost`) prices eligible works × `source_harvest.avg_pages_per_work` × the PINNED model rate × tier — an estimate only, never a charge; the user-chosen `max_spend` cap is enforced at work boundaries during the run.

### AI citation review (`category: ai_review`)

- **Rate** — one aggregate charge when the review completes: OCR pages from the pipeline's `step_timings` (priced per served model) + per-model LLM token costs from `llm_usage` (config `services.llm.pricing`, per-1M-token input/output). Itemized in `line_items`.
- **Where** — `CitationReviewCommand::billReview`, reached via `CitationPipelineJob` → `Artisan::call('citation:pipeline')` with `--user-id`.
- **BYO waiver** — when the pipeline ran in client-inference mode (`citation_pipelines.inference_mode = 'client'`), the LLM lines are WAIVED (the user's own key already paid for the tokens); server-side OCR of sources still bills.
- A failed review never reaches `billReview` (it runs after report + sub-book import), so failures cost the user nothing.

### AI brain — quick chat + archivist (`category: ai_brain`)

- **Rate** — real LLM token costs (`calculateCost` over `LlmService::getUsageStats`), plus embedding pennies for archivist searches; floor $0.0001.
- **When** — after the LLM answered AND the sub-book/highlight rows were written (`AiBrainController`). Any earlier exit — validation 422, empty retrieval, all models down, cross-user shelf — charges nothing.
- **BYO waiver** — `client_inference` requests run on the user's own key via inference tickets; the charge is logged as waived.

### Vibe CSS theme generator (`category: vibe_css`)

- LLM token cost, charged only after the response parsed into valid CSS overrides; unparseable output = 422 and no charge. BYO path gets an inference ticket and no server charge.

### TTS audiobooks (`category: tts`, hold: `tts_reservation`)

- **Rate** — synthesized characters / 1M × `services.tts.pricing.billed_per_million_chars` ($1.00 raw; our DeepInfra cost is $0.80).
- **Reservation** — the generate endpoint takes an atomic `reserveCredits()` hold (estimate × multiplier, row-locked) so N simultaneous requests can't all pass the non-locking balance gate. The hold is NOT the charge: `GenerateBookAudioJob` releases it in a `finally` (and in `failed()`), then `chargeFor()` bills only the characters actually synthesized. A leaked hold was the pre-2026-07 double-debit bug — `releaseReservation()` is idempotent and refuses to touch non-reservation rows.
- **Partial runs bill partially** — per-node hash-skip makes re-runs bill only the gap; a fully failed run (zero chars) bills nothing.

### Free features (deliberately unbilled)

- **Vibe convert** (the AI re-conversion fixer) is FREE — it's an experimental dead end that rarely produces a usable fix, so charging was removed 2026-07 (`VibeConversionJob`). The `canProceed` gate stays (it still costs hyperlit LLM money, so zero-balance accounts can't spam it).
- **Everything else** — reading, editing, EPUB/MD/HTML/DOCX imports, highlights, hypercites, search.

## Stripe top-ups (`category: stripe_topup`)

- `StripeController::createCheckoutSession` validates $5–$500 and stamps `user_id` + `credit_amount` into session metadata.
- The `checkout.session.completed` webhook credits `users.credits` 1:1 and writes a credit ledger row; idempotent on `metadata->stripe_session_id` (a redelivered webhook never double-credits); signature-verified (forged = 400).

## The accounts book (what the user sees)

- Every user has a pre-rendered pseudo-book `{sanitizedUsername}Account` shown in the Account tab of their profile: a balance card (balance, credits, debits, tier + tier switcher, top-up button) plus the latest 50 ledger rows rendered as entries.
- It regenerates EAGERLY after every `charge()` / `addCredits()` / Stripe webhook / tier change (`BillingService::refreshAccountBook`, best-effort — a regen failure never fails the billing write) and a freshness guard on profile visits self-heals any miss (`UserHomeServerController::generateAccountBookIfNeeded`).
- Failed jobs do NOT appear in the accounts book — the ledger records money movements only. Failure reporting lives in the progress UI and the failure emails; the import-failure email explicitly states whether the user was charged.

## Failure semantics

- The universal rule: **no successful work, no charge.** Gates reject up-front (402), and every charge site sits AFTER the success point of its feature, so a crash/timeout/validation failure simply never reaches `charge()`.
- **Failed PDF import** — not charged by default, even though the Mistral OCR call may have already cost us money (we eat it). The env toggle `BILLING_CHARGE_OCR_ON_FAILED_IMPORT=true` (`services.billing.charge_ocr_on_failed_import`) flips this: `ProcessDocumentImportJob::failed()` then bills the OCR that actually ran — marker-idempotent, and a crash BEFORE the OCR still bills nothing (no `ocr_response.json` = nothing to charge). The failure email tells the user which way it went ("You were not charged" vs the OCR amount).
- **No refunds exist** — the ledger is append-only and nothing reverses a posted charge; correctness relies on charging after success. The one reversal-like operation is `releaseReservation`, which only undoes reservation HOLDS, never real debits.

## The queue-worker RLS gotcha (read this before adding a charge site)

- `charge()` re-reads the user on the DEFAULT connection, whose `users_select_policy` requires BOTH `app.current_user` AND `app.current_token` session vars. HTTP middleware sets them; a QUEUE WORKER does not — so a worker-side charge (or even a worker-side `User::find`) silently matches zero rows and billing never happens, with no error anywhere.
- This exact silent no-op shipped twice: every async PDF import went unbilled (`ProcessDocumentImportJob` looked its user up on the default connection) and every async citation review did too (`CitationReviewCommand`'s `--user-id` lookup). Both fixed 2026-07: read the user via `User::on('pgsql_admin')`, set both vars around the charge, and RESTORE the previous values after (not blank them — the same code can run synchronously inside an HTTP request, whose own RLS context must survive).
- Any NEW job that charges must follow the same pattern — see `GenerateBookAudioJob::chargeFor`, `HarvestRunner::chargeWorkOcr`, `ProcessDocumentImportJob::billOcrAsWorker` — and get a worker-context test (clear the session vars, run the job path, assert the ledger row landed; `ImportWorkerBillingTest` is the template).

## Running the billing tests

- **PHP suites** — `php artisan test tests/Feature/Billing` for the core money suite, or the full run `php artisan test --testsuite=Feature`. Tests seed users past RLS with the `SeedsRlsFixtures` trait (bound to `Feature/Billing` in `tests/Pest.php`) and read the ledger on the default connection with the RLS session vars set — the charge happens inside the test's `RefreshDatabase` transaction, invisible to `pgsql_admin`.
- **Stripe e2e (deterministic, no real money)** — `npx playwright test --config tests/e2e/playwright.stripe.config.js --grep-invert "@stripe-ui"`; self-signs webhooks with the `.env` secret.
- **Stripe real-checkout UI** — add `--grep @stripe-ui` (drives Stripe's hosted test-card page).
- **Opt-in real LLM spend** — `RUN_LIVE_SPEND=1 … spend-live` (bills the provider; the only test that drives a paid feature to live completion).

### What each test file locks

- `tests/Feature/Billing/BillingServiceTest.php` — charge() math across ALL tiers (debit column + ledger row + `balance_after` + metadata), premium ledger-only, unknown-tier fallback, addCredits, the reserve/release hold lifecycle (idempotent, refuses real debits), per-served-model OCR pricing, and `billOcrForBook` end-to-end (pages × model rate × tier, marker idempotency, `hyperlit-` free path).
- `tests/Feature/Billing/ImportWorkerBillingTest.php` — the worker-context regression (charge lands with NO RLS session vars; mutation-verified: reverting the fix turns it red), failed import = no charge by default, the `BILLING_CHARGE_OCR_ON_FAILED_IMPORT` toggle (bills exactly once, nothing when OCR never ran).
- `tests/Feature/Billing/CitationReviewBillingTest.php` — the OCR+LLM aggregate math with itemized line_items, the worker-context regression, the BYO LLM-waiver (OCR still billed), and zero-usage = no charge.
- `tests/Feature/Billing/VibeCssChargeTest.php` — happy-path charge at LLM cost × tier in CI (previously only the opt-in live-spend e2e covered success), unparseable output = no charge.
- `tests/Feature/AiBrain/BillingFailurePathsTest.php` — quick-chat happy-path charge (real BillingService, mocked LLM) plus the four no-charge failure paths (empty retrieval, all models down, validation, cross-user shelf).
- `tests/Feature/BookAudio/BookAudioTest.php` — per-node TTS charge math, hash-skip idempotency (re-run = no new charge), gap-only billing after edits, and the reservation hold being released on job success AND failure.
- `tests/Feature/Import/OcrBillingIdempotencyTest.php` + `NativeOcrImportTest.php` — the marker guard through the real import route, and the client/native OCR zero-charge contract (model stamp can't be forged to a paid one).
- `tests/Feature/Api/HarvestRunnerBillingTest.php` + `SourceHarvestLifecycleTest.php` — one charge per harvested work, spend-cap + cancel stop charging, estimate math per tier.
- `tests/Feature/AccountBookTest.php` — the accounts book bakes correct balance/tier/ledger, eager regen on every billing mutation, freshness-guard self-heal, regen failure never fails the billing write, Stripe webhook end-to-end, AND the full delivery hop: a real owner GET of `/u/{username}` (the page the browser loads) triggers the guard, and the reader's own pull endpoint (`/api/database-to-indexeddb/books/{book}/data`, what loadHyperText fetches) serves the regenerated ledger + balance.
- `tests/Feature/Security/BillingRaceConditionTest.php` — the reservation blocks concurrent generation races; premium bypass.
- `tests/e2e/specs/stripe/` — webhook credit idempotency + signature auth + cross-user isolation, the 402 spend gates on every paid endpoint, post-gate failures leave balances untouched, real-checkout UI, opt-in live spend.
