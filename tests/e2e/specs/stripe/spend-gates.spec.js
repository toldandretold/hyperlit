// @ts-check
//
// DETERMINISTIC: every paid feature must REFUSE to run on an empty balance and
// must NOT record a charge. No LLM is called here — the balance gate returns 402
// before any paid work, so these are fast and free.
//
// Run: npx playwright test --config tests/e2e/playwright.stripe.config.js spend-gates

import { test, expect } from '@playwright/test';
import { provisionUser, getBalance, getLedger, postRetry } from './helpers/billing.js';

// path, body, and the message the 402 should carry. Payloads are crafted to pass
// each controller's input validation so the request actually reaches the balance
// gate (vibe-convert / citation validate their id BEFORE checking balance).
const PAID_ENDPOINTS = [
  { name: 'vibe CSS',          path: '/api/vibe-css/generate',          body: { prompt: 'make it dark' } },
  { name: 'AI brain',          path: '/api/ai-brain/query',             body: { selectedText: 'hello world', question: 'what?', bookId: 'rt_x', highlightId: 'h1', nodeIds: ['n1'] } },
  { name: 'vibe convert',      path: '/api/vibe-convert/start',         body: { bookId: 'rt_nonexistent_book' } },
  { name: 'citation pipeline', path: '/api/citation-pipeline/trigger',  body: { book: 'rt_nonexistent_book' } },
];

for (const ep of PAID_ENDPOINTS) {
  test(`${ep.name}: refuses on a zero balance (402) and records no charge`, async ({ browser }) => {
    const { context, page } = await provisionUser(browser);
    try {
      expect((await getBalance(page)).balance).toBe(0);

      const token = await page.evaluate(() => {
        const m = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      });
      const resp = await page.request.post('http://hyperlit.test' + ep.path, {
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-XSRF-TOKEN': token, Origin: 'http://hyperlit.test', Referer: 'http://hyperlit.test/' },
        data: ep.body,
      });

      // The balance gate should answer 402 "Insufficient balance".
      expect(resp.status(), `${ep.name} should 402 on empty balance`).toBe(402);
      expect((await resp.json()).message).toContain('Insufficient');

      // And absolutely nothing should have been charged.
      const after = await getBalance(page);
      expect(after.balance).toBe(0);
      expect(after.debits).toBe(0);
      const debits = (await getLedger(page)).filter((e) => e.type === 'debit');
      expect(debits.length, `${ep.name} must not write a debit row when blocked`).toBe(0);
    } finally {
      await context.close();
    }
  });
}
