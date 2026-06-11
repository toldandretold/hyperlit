// @ts-check
//
// Playwright config for the Stripe / billing e2e suite (specs/stripe/).
//
// Self-contained like the security config: each spec provisions its own
// throwaway account via the API, so there's no shared-auth fixture. Two kinds of
// test live here:
//   - DETERMINISTIC money-logic tests (webhook crediting, idempotency, spend,
//     refund-on-failure) — they credit via a webhook the test SIGNS itself with
//     the .env STRIPE_WEBHOOK_SECRET, so they need no external network.
//   - REAL Stripe Checkout UI tests — they drive checkout.stripe.com with test
//     cards. Slower / depend on Stripe's hosted page; tagged @stripe-ui.
//
// Run everything:
//   npx playwright test --config tests/e2e/playwright.stripe.config.js
// Just the deterministic money-logic tests (skip the external Stripe page):
//   npx playwright test --config tests/e2e/playwright.stripe.config.js --grep-invert @stripe-ui
// Just the real-card UI flow:
//   npx playwright test --config tests/e2e/playwright.stripe.config.js --grep @stripe-ui
//
// MUST be run from the project root (the helpers read ./.env for the Stripe keys).
import { defineConfig } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Same Vite-host remap trick as the security config: in dev the SPA loads its JS
// from the host pinned in public/hot, which may be an unreachable LAN IP — map it
// to 127.0.0.1 so headless Chromium can boot the reader pages.
const browserArgs = [];
try {
  const hot = readFileSync(resolve(import.meta.dirname, '../../public/hot'), 'utf-8').trim();
  const host = new URL(hot).hostname;
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    browserArgs.push(`--host-resolver-rules=MAP ${host} 127.0.0.1`);
  }
} catch {
  // built assets / not in dev mode — nothing to remap
}

export default defineConfig({
  testDir: './specs/stripe',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results-stripe',
  timeout: 90_000,        // the real Stripe page is slow
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://hyperlit.test',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', launchOptions: { args: browserArgs } },
    },
  ],
});
