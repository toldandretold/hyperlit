// @ts-check
//
// OPT-IN, COSTS REAL MONEY. This is the only spec that drives a paid feature to a
// SUCCESSFUL completion so you can watch credits actually leave the table. It
// makes a real LLM call (your provider key is billed), so it's skipped unless you
// opt in:
//
//   RUN_LIVE_SPEND=1 npx playwright test --config tests/e2e/playwright.stripe.config.js spend-live
//
// Flow: credit the user via a signed webhook → call vibe-css/generate (cheapest
// real spend: one LLM call, no book setup) → assert credits dropped, a 'vibe_css'
// debit row was written, and balance == credits - debits.

import { test, expect } from '@playwright/test';
import { provisionUser, getBalance, getLedger, creditViaWebhook, apiHeaders, xsrf, BASE } from './helpers/billing.js';

test.skip(!process.env.RUN_LIVE_SPEND, 'set RUN_LIVE_SPEND=1 to run real-LLM spend tests (bills your provider)');

test('vibe CSS: a successful generation debits the user and writes a vibe_css ledger row', async ({ browser }) => {
  test.setTimeout(120_000); // a real LLM round-trip
  const { context, page, userId } = await provisionUser(browser);
  try {
    await creditViaWebhook(page, { userId, amount: 10 });
    const before = await getBalance(page);
    expect(before.balance).toBe(10);

    const resp = await page.request.post(BASE + '/api/vibe-css/generate', {
      headers: apiHeaders(await xsrf(page)),
      data: { prompt: 'make the page background a dark navy blue' },
      timeout: 90_000,
    });
    expect(resp.ok(), `vibe-css should succeed (got ${resp.status()}: ${await resp.text()})`).toBeTruthy();

    const after = await getBalance(page);
    // Credits unchanged, debits rose, balance fell — and not below what we paid.
    expect(after.credits).toBe(10);
    expect(after.debits).toBeGreaterThan(0);
    expect(after.balance).toBeLessThan(10);
    expect(after.balance).toBeCloseTo(after.credits - after.debits, 4);

    const charge = (await getLedger(page)).find((e) => e.type === 'debit' && e.category === 'vibe_css');
    expect(charge, 'a vibe_css debit row should exist').toBeTruthy();
    expect(Number(charge.amount)).toBeGreaterThan(0);
    // Sanity: a single CSS generation should be cents, not dollars.
    expect(Number(charge.amount)).toBeLessThan(5);

    console.log(`[spend-live] vibe_css charged ${charge.amount} credits; balance ${before.balance} → ${after.balance}`);
  } finally {
    await context.close();
  }
});
