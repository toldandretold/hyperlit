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

| File | Tag | Needs | What it checks |
|---|---|---|---|
| `webhook-credit.spec.js` | — | — | Valid top-up credits 1:1 + ledger row; idempotency; bad signature → 400; missing metadata → 400; non-checkout event → 200 no-credit; cross-user isolation. |
| `spend-gates.spec.js` | — | — | Every paid feature refuses on a zero balance (402 "Insufficient balance") and writes no debit. |
| `failure-no-charge.spec.js` | — | — | A process that fails after the balance gate leaves credits intact (post-success model); citation pipeline never debits. |
| `checkout-ui.spec.js` | `@stripe-ui` | network → checkout.stripe.com | Real test card 4242 pays → redirect → webhook credits; 4000…0002 declines → no charge; off-site `return_url` rejected (422). |
| `spend-live.spec.js` | — | `RUN_LIVE_SPEND=1` + LLM key | Real vibe-css generation actually debits the user + writes a `vibe_css` ledger row. **Costs money.** |
| `helpers/billing.js` | — | — | `provisionUser`, `getBalance`, `getLedger`, `buildSignedWebhook`, `sendWebhook`, `creditViaWebhook`. |

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
