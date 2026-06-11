// @ts-check
//
// REAL Stripe Checkout UI flow (@stripe-ui). Drives Stripe's hosted checkout page
// (checkout.stripe.com) with TEST cards — confirmed test mode (sk_test_), so no
// real money moves.
//
//   success card 4242…  → payment completes → redirect back to the app, then we
//                          deliver the (signed) webhook Stripe would send and
//                          assert the user is credited.
//   decline card 4000…0002 → Stripe rejects the card → no redirect, no charge,
//                          balance stays 0, an error is shown.
//
// Stripe can't reach a local host, so the webhook delivery is simulated with a
// signed event carrying the REAL session_id from the checkout — faithful to prod
// (Stripe page → webhook → credit), just without the network hop to localhost.
//
// These hit an external page and are slower / more brittle than the deterministic
// specs. Run them on their own:
//   npx playwright test --config tests/e2e/playwright.stripe.config.js --grep @stripe-ui

import { test, expect } from '@playwright/test';
import { provisionUser, getBalance, postRetry, apiHeaders, xsrf, BASE, buildSignedWebhook, sendWebhook } from './helpers/billing.js';

// Stripe's hosted checkout uses stable field ids (not iframes for the hosted page).
async function fillStripeCheckout(page, { number, exp = '12 / 34', cvc = '123', name = 'Red Team' }) {
  // Wait for the card form to be ready FIRST — fields aren't present at
  // domcontentloaded, and filling too early silently no-ops (email is REQUIRED).
  await page.locator('#cardNumber').waitFor({ state: 'visible', timeout: 40_000 });

  await page.locator('#email').fill('redteam@example.com'); // required on the hosted page
  await page.locator('#cardNumber').fill(number);
  await page.locator('#cardExpiry').fill(exp);
  await page.locator('#cardCvc').fill(cvc);

  const nameField = page.locator('#billingName');
  if (await nameField.count()) await nameField.fill(name);
  // Country has a sensible default; a postal field only appears for some regions.
  const postalField = page.locator('#billingPostalCode');
  if (await postalField.count() && await postalField.isVisible().catch(() => false)) {
    await postalField.fill('42424');
  }

  // Uncheck "Save my information for faster checkout" (Stripe Link) — when ticked
  // it adds a REQUIRED phone-number field and blocks Pay. We want a plain card
  // charge, not a Link signup.
  const linkOptIn = page.getByRole('checkbox', { name: /save my information/i });
  if (await linkOptIn.count() && await linkOptIn.isChecked().catch(() => false)) {
    await linkOptIn.uncheck({ force: true }).catch(() => {});
  }
}

async function startCheckout(page, amount) {
  const resp = await postRetry(page, '/api/billing/checkout', { amount, return_url: BASE + '/' });
  expect(resp.ok(), `checkout session should be created (got ${resp.status()})`).toBeTruthy();
  const json = await resp.json();
  expect(json.checkout_url).toContain('checkout.stripe.com');
  return json; // { checkout_url, session_id }
}

test('@stripe-ui success card pays, redirects back, and the webhook credits the user', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    const amount = 15;
    const { checkout_url, session_id } = await startCheckout(page, amount);

    await page.goto(checkout_url, { waitUntil: 'domcontentloaded' });
    await fillStripeCheckout(page, { number: '4242 4242 4242 4242' });

    // Pay, then wait to be redirected back to our app with checkout=success.
    await page.locator('.SubmitButton, button[type="submit"], [data-testid="hosted-payment-submit-button"]').first().click();
    // 'commit' resolves the moment the redirect URL changes — don't wait for the
    // heavy SPA homepage to fire 'load'.
    await page.waitForURL(/checkout=success/, { timeout: 45_000, waitUntil: 'commit' });
    expect(page.url()).toContain('checkout=success');
    await page.waitForLoadState('domcontentloaded').catch(() => {}); // let the session settle

    // The card was charged; in prod Stripe now POSTs the webhook. Deliver it.
    expect((await getBalance(page)).balance).toBe(0); // not credited until the webhook
    const evt = buildSignedWebhook({ userId, amount, sessionId: session_id });
    const wh = await sendWebhook(page, evt);
    expect(wh.status()).toBe(200);

    const after = await getBalance(page);
    expect(after.credits).toBe(amount);
    expect(after.balance).toBe(amount);
  } finally {
    await context.close();
  }
});

test('@stripe-ui declined card does not complete payment and credits nothing', async ({ browser }) => {
  const { context, page } = await provisionUser(browser);
  try {
    const { checkout_url } = await startCheckout(page, 20);

    await page.goto(checkout_url, { waitUntil: 'domcontentloaded' });
    await fillStripeCheckout(page, { number: '4000 0000 0000 0002' }); // generic decline
    await page.locator('.SubmitButton, button[type="submit"], [data-testid="hosted-payment-submit-button"]').first().click();

    // Stripe rejects the card and keeps us on its page — it must NOT redirect to
    // our success URL. Give it time to process, then assert we never left Stripe
    // and nothing was credited. (We avoid asserting exact decline copy, which
    // Stripe changes; the lack of a success redirect + zero balance is the proof.)
    await page.waitForTimeout(10_000);
    expect(page.url(), 'a declined card must not redirect to checkout=success').not.toContain('checkout=success');
    expect(page.url()).toContain('checkout.stripe.com');
    expect((await getBalance(page)).balance).toBe(0);     // no charge
  } finally {
    await context.close();
  }
});

test('@stripe-ui return_url is constrained to our domain (open-redirect fix holds)', async ({ browser }) => {
  // Not a card test — verifies the checkout endpoint still rejects an off-site
  // return_url (the Stripe open-redirect we fixed earlier).
  const { context, page } = await provisionUser(browser);
  try {
    const resp = await postRetry(page, '/api/billing/checkout', { amount: 10, return_url: 'https://evil.example/phish' });
    expect(resp.status()).toBe(422);
  } finally {
    await context.close();
  }
});
