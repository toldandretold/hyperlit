# Stripe / billing e2e suite

End-to-end tests for the money path: Stripe checkout → webhook → credits, and
every paid feature's deduction + failure behaviour. Run with the dedicated
config (`tests/e2e/playwright.stripe.config.js`), from the **project root**
(helpers read `./.env` for the Stripe keys).

```bash
# Everything except the external Stripe page (fast, deterministic, free):
npx playwright test --config tests/e2e/playwright.stripe.config.js --grep-invert "@stripe-ui"

# The real Stripe Checkout page with test cards (slower, external):
npx playwright test --config tests/e2e/playwright.stripe.config.js --grep @stripe-ui

# The opt-in real-LLM spend test (BILLS YOUR PROVIDER):
RUN_LIVE_SPEND=1 npx playwright test --config tests/e2e/playwright.stripe.config.js spend-live

# A single file:
npx playwright test --config tests/e2e/playwright.stripe.config.js webhook-credit
```

## How it works

Stripe's servers can't reach a local host, so the checkout→webhook→credit loop is
closed by the test **signing the webhook itself** with the `.env`
`STRIPE_WEBHOOK_SECRET` (HMAC-SHA256, `t=…,v1=…`, exactly as Stripe does). That
exercises the real signature-verification + crediting code path deterministically.
State is asserted through the public billing API (`/api/billing/balance`,
`/api/billing/ledger`) — no DB driver needed.

Each test provisions its own throwaway account (`@redteam.local` email) via the
API. **Confirmed test mode** (`sk_test_`/`pk_test_`) — the card tests move no real
money.

## The money model (what the tests pin)

- **1 credit = $1.** Checkout `amount` is passed through 1:1 as `credit_amount`.
- **`balance = users.credits − users.debits`** (computed accessor).
- **Top-up** adds a `billing_ledger` row `{category:'stripe_topup', type:'credit',
  metadata.stripe_session_id}` and bumps `credits`.
- **Idempotency** is keyed on `billing_ledger.metadata->>'stripe_session_id'` — a
  redelivered session returns `{duplicate:true}` and never double-credits.
- **Spend is POST-SUCCESS.** Features check `canProceed()` (balance > 0 → else
  **402**) *before* the work, and only `charge()` (write a `debit` row + bump
  `debits`) *after* success. There is **no refund logic** — so any failure/cancel
  simply never charges. Citation pipeline is balance-gated but **free** (never
  debits).

## Files

- **`webhook-credit.spec.js`** — Valid top-up credits 1:1 + ledger row; idempotency; bad signature → 400; missing metadata → 400; non-checkout event → 200 no-credit; cross-user isolation.
- **`spend-gates.spec.js`** — Every paid feature refuses on a zero balance (402 "Insufficient balance") and writes no debit. (Whole-book translation's 402 lives in `translation-billing.spec.js` instead — its gate needs a TRANSLATABLE book, which this table's probe payloads can't provide.)
- **`failure-no-charge.spec.js`** — A process that fails after the balance gate leaves credits intact (post-success model); citation pipeline never debits.
- **`translation-billing.spec.js`** — Whole-book translation END TO END through the real pipeline (reservation → `TranslateBookJob` → copy → charge → hold release) against a FAKE Fireworks; see the section below. 402 gate, exact token charge, and the fail/retry economics (a failed run pays only for the paragraphs it translated; the retry re-sends only the remainder).
- **`checkout-ui.spec.js`** (`@stripe-ui`; needs network → checkout.stripe.com) — Real test card 4242 pays → redirect → webhook credits; 4000…0002 declines → no charge; off-site `return_url` rejected (422).
- **`spend-live.spec.js`** (needs `RUN_LIVE_SPEND=1` + LLM key) — Real vibe-css generation actually debits the user + writes a `vibe_css` ledger row. **Costs money.**
- **`helpers/billing.js`** — `provisionUser`, `getBalance`, `getLedger`, `buildSignedWebhook`, `sendWebhook`, `creditViaWebhook`.

## The translation-billing harness (fake Fireworks + a spec-spawned worker)

`translation-billing.spec.js` is the one suite here that runs a QUEUE JOB for real. Three pieces:

- **Fake Fireworks** — `tests/e2e/fixtures/fake-fireworks.mjs`, an OpenAI-compatible server started IN the Playwright process. It answers HtmlTranslator's batch prompts from a literal map keyed to the fixture book's node text, with fixed usage (1000/500 tokens per request) so the expected charge is exactly computable, plus `setOmit()` fault injection and a request log the assertions read.
- **The fixture book** — `php artisan e2e:seed-translation-fixture` (run in `beforeEach`): a public Chinese book whose text IS the fake's answers map. Every seed purges prior translation copies, run dirs and stale queued/reserved jobs — the commons dedupe (one visible translation blocks a second) would otherwise 409 re-runs.
- **The worker** — the spec spawns `php artisan queue:work --queue=translation --once` with `LLM_BASE_URL` pointed at the fake. Spawn ASYNC, never `execFileSync`: the fake lives in this process, and a synchronous wait blocks the event loop so the fake can never answer the worker (a deadlock that burns the whole test timeout).

Two skip guards, both load-bearing: the suite SKIPS when a long-lived translation worker is already running (`dev:all`'s TRAN pane would grab the job with the REAL Fireworks key and bill real money — stop it first), and when the Laravel config is cached (the spawned worker would ignore `LLM_BASE_URL`; run `php artisan config:clear`).

Possible follow-up (not built): an opt-in `RUN_LIVE_TRANSLATION=1` case against real Kimi K3, following `spend-live.spec.js`'s pattern. The fake path already covers the full pipeline, so the live case would only verify Fireworks itself.

## Cleanup

Tests hit the **real dev DB** (not a transactional test DB), so throwaway users +
ledger rows accumulate. They all use `@redteam.local` emails — purge with:

```bash
php artisan tinker --execute="
  \$a = DB::connection('pgsql_admin');
  \$ids = \$a->table('users')->where('email','like','%@redteam.local')->pluck('id');
  \$a->table('billing_ledger')->whereIn('user_id',\$ids)->delete();
  \$a->table('users')->where('email','like','%@redteam.local')->delete();
  echo 'purged '.\$ids->count().' billing test users'.PHP_EOL;
"
```

## Notes

- `config/services.php` reads `env('STRIPE_KEY')` but `.env` has `STRIPE_Key`
  (case mismatch) — the publishable key may resolve to null. Harmless for hosted
  checkout (which only needs the secret key), but worth fixing for any future
  client-side Stripe.js.
- The `@stripe-ui` tests depend on Stripe's hosted-page DOM (field ids
  `#cardNumber`/`#cardExpiry`/`#cardCvc`). If Stripe changes that markup the
  selectors may need updating — the deterministic specs don't have this exposure.
