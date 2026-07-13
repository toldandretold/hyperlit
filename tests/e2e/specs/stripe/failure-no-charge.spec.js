// @ts-check
//
// DETERMINISTIC: the spend model is POST-SUCCESS — credits are only deducted
// AFTER a feature completes successfully. So a process that fails (or is rejected)
// after passing the balance gate must leave the user's credits fully intact, with
// NO debit row. There is no refund logic in the app, so "never charged in the
// first place" is the guarantee we assert.
//
// These tests credit a real balance first (via a signed webhook), then make the
// feature fail BEFORE the paid work runs (input rejected after the balance check),
// so no LLM is actually called — fast and free.
//
// Run: npx playwright test --config tests/e2e/playwright.stripe.config.js failure-no-charge

import { test, expect } from '@playwright/test';
import { provisionUser, getBalance, getLedger, creditViaWebhook, apiHeaders, xsrf, BASE } from './helpers/billing.js';

async function rawPost(page, path, data) {
  return page.request.post(BASE + path, { headers: apiHeaders(await xsrf(page)), data });
}

test('vibe CSS: a request that fails validation after the balance check is not charged', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    await creditViaWebhook(page, { userId, amount: 10 });
    expect((await getBalance(page)).balance).toBe(10);

    // Balance check passes (10 > 0), THEN validation rejects an over-length prompt.
    const resp = await rawPost(page, '/api/vibe-css/generate', { prompt: 'x'.repeat(2000) });
    expect(resp.status()).toBe(422);                 // failed before any LLM work

    const after = await getBalance(page);
    expect(after.balance).toBe(10);                  // credits fully intact
    expect(after.debits).toBe(0);
    expect((await getLedger(page)).filter((e) => e.type === 'debit').length).toBe(0);
  } finally {
    await context.close();
  }
});

test('AI brain: a request that fails validation after the balance check is not charged', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    await creditViaWebhook(page, { userId, amount: 10 });
    expect((await getBalance(page)).balance).toBe(10);

    // canProceed() runs first (passes), then validation fails on the empty body.
    const resp = await rawPost(page, '/api/ai-brain/query', {});
    expect(resp.status()).toBe(422);

    const after = await getBalance(page);
    expect(after.balance).toBe(10);
    expect((await getLedger(page)).filter((e) => e.type === 'debit').length).toBe(0);
  } finally {
    await context.close();
  }
});

test('citation pipeline is free: triggering it never writes a debit', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    await creditViaWebhook(page, { userId, amount: 10 });
    expect((await getBalance(page)).balance).toBe(10);

    // Passes validation + balance gate; the book doesn't exist so the pipeline
    // bails — but even a full run never charges (citation is a free feature).
    await rawPost(page, '/api/citation-pipeline/trigger', { book: 'rt_nonexistent_book' });

    const after = await getBalance(page);
    expect(after.balance).toBe(10);                  // untouched
    expect((await getLedger(page)).filter((e) => e.type === 'debit').length).toBe(0);
  } finally {
    await context.close();
  }
});

test('vibe convert: a start that fails (missing book) does not deduct the fixed fee', async ({ browser }) => {
  const { context, page, userId } = await provisionUser(browser);
  try {
    await creditViaWebhook(page, { userId, amount: 10 });
    expect((await getBalance(page)).balance).toBe(10);

    // Valid id format passes validation + balance gate, then the missing working
    // dir aborts the start. (Vibe convert is FREE since 2026-07 — experimental
    // dead end, never billed — but the gate + no-debit contract still holds.)
    const resp = await rawPost(page, '/api/vibe-convert/start', { bookId: 'rt_nonexistent_book' });
    expect([400, 404, 409, 422, 500]).toContain(resp.status()); // some failure, not a charged success

    const after = await getBalance(page);
    expect(after.balance).toBe(10);
    expect((await getLedger(page)).filter((e) => e.type === 'debit').length).toBe(0);
  } finally {
    await context.close();
  }
});
