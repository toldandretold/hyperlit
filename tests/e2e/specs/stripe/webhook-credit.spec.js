// @ts-check
//
// DETERMINISTIC money-integrity tests for the Stripe webhook → credit path.
// No external network: we sign webhooks ourselves with the .env secret and assert
// via the billing API. These are the "did money appear correctly / only once /
// only when legitimately signed" guarantees.
//
// Run: npx playwright test --config tests/e2e/playwright.stripe.config.js webhook-credit

import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import {
  WEBHOOK_SECRET, provisionUser, getBalance, getLedger,
  buildSignedWebhook, sendWebhook, creditViaWebhook,
} from './helpers/billing.js';

test.beforeAll(() => {
  expect(WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET must be set in .env to run the Stripe suite').toBeTruthy();
});

test('a valid signed top-up credits the user 1:1 and writes a ledger row', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    const before = await getBalance(page);
    expect(before.balance).toBe(0);

    const { response, sessionId } = await creditViaWebhook(page, { userId, amount: 25 });
    expect(response.status()).toBe(200);
    expect((await response.json()).received).toBe(true);

    const after = await getBalance(page);
    expect(after.credits).toBe(25);          // 1 credit == $1
    expect(after.debits).toBe(0);
    expect(after.balance).toBe(25);

    // A stripe_topup ledger row exists, tagged with the session id, balance_after correct.
    const ledger = await getLedger(page);
    const row = ledger.find((e) => (e.category === 'stripe_topup') && Number(e.amount) === 25);
    expect(row, 'a stripe_topup credit row should exist').toBeTruthy();
    expect(row.type).toBe('credit');
    expect(Number(row.balance_after)).toBe(25);
    const sidInMeta = JSON.stringify(row.metadata || {}).includes(sessionId);
    expect(sidInMeta, 'ledger row metadata should carry the stripe_session_id').toBeTruthy();
  } finally {
    await context.close();
  }
});

test('the same session id is idempotent — never double-credits', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    const sid = 'cs_test_' + crypto.randomBytes(6).toString('hex');

    const first = await creditViaWebhook(page, { userId, amount: 40, sessionId: sid });
    expect(first.response.status()).toBe(200);
    expect((await getBalance(page)).balance).toBe(40);

    // Re-deliver the SAME session (Stripe retries webhooks) — must not stack.
    const dup = await creditViaWebhook(page, { userId, amount: 40, sessionId: sid });
    expect(dup.response.status()).toBe(200);
    expect((await dup.response.json()).duplicate).toBe(true);
    expect((await getBalance(page)).balance).toBe(40);   // still 40, not 80
  } finally {
    await context.close();
  }
});

test('a forged (bad-signature) webhook is rejected 400 and credits nothing', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    const evt = buildSignedWebhook({ userId, amount: 999999, sessionId: 'cs_test_forged', badSignature: true });
    const resp = await sendWebhook(page, evt);
    expect(resp.status()).toBe(400);
    expect((await getBalance(page)).balance).toBe(0);
  } finally {
    await context.close();
  }
});

test('a validly-signed event with missing metadata is 400 and credits nothing', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    const evt = buildSignedWebhook({ userId, amount: 100, sessionId: 'cs_test_nometa', omitMetadata: true });
    const resp = await sendWebhook(page, evt);
    expect(resp.status()).toBe(400);
    expect((await getBalance(page)).balance).toBe(0);
  } finally {
    await context.close();
  }
});

test('a non-checkout event is acknowledged 200 but credits nothing', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    const evt = buildSignedWebhook({ userId, amount: 500, sessionId: 'cs_test_other', type: 'payment_intent.created' });
    const resp = await sendWebhook(page, evt);
    expect(resp.status()).toBe(200);                 // acknowledged...
    expect((await getBalance(page)).balance).toBe(0); // ...but not credited
  } finally {
    await context.close();
  }
});

test('crediting one user never touches another user\'s balance', async ({ browser }) => {
  const victim   = await provisionUser(browser);
  const attacker = await provisionUser(browser);
  try {
    // Credit the attacker; the victim's balance must stay 0.
    await creditViaWebhook(attacker.page, { userId: attacker.userId, amount: 30 });
    expect((await getBalance(attacker.page)).balance).toBe(30);
    expect((await getBalance(victim.page)).balance).toBe(0);
  } finally {
    await victim.context.close();
    await attacker.context.close();
  }
});
