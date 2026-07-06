// @ts-check
//
// Dedicated Playwright config for the security PoC(s) under specs/security/.
//
// Unlike the main e2e config, this has NO auth-setup dependency and does not
// load a stored session: each security spec provisions its own throwaway
// accounts via the API and drives fresh browser contexts (attacker builds the
// payload, an anonymous "victim" context loads it). That keeps the PoC
// self-contained and runnable against any environment.
//
// Run it:
//   npx playwright test --config tests/e2e/playwright.security.config.js
//   E2E_BASE_URL=http://localhost:8000 npx playwright test --config tests/e2e/playwright.security.config.js
//
// Default target is the local Herd host (where Vite dev assets are served).
import { defineConfig } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// In Vite dev mode the SPA loads its JS from the host pinned in `public/hot`
// (e.g. http://192.168.1.56:5173). That LAN IP is often unreachable from a
// headless browser (machine IP changed, VPN, etc.), which leaves the reader
// stuck on its loading overlay and makes any XSS result meaningless. So we read
// that host and add a Chromium host-resolver rule mapping it to 127.0.0.1, where
// Vite actually listens — no edits to public/hot, no disruption to the dev setup.
const browserArgs = [];
try {
  const hot = readFileSync(resolve(import.meta.dirname, '../../public/hot'), 'utf-8').trim();
  const host = new URL(hot).hostname;
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    browserArgs.push(`--host-resolver-rules=MAP ${host} 127.0.0.1`);
  }
} catch {
  // No hot file (built assets / not in dev mode) — nothing to remap.
}

export default defineConfig({
  testDir: './specs/security',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results-security',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://hyperlit.test',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { args: browserArgs },
      },
    },
  ],
});
