// @ts-check
import { defineConfig } from '@playwright/test';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// Load .env.e2e manually (avoids dotenv dependency)
try {
  const envPath = resolve(import.meta.dirname, '.env.e2e');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env.e2e not found — rely on actual env vars
}

export default defineConfig({
  testDir: './specs',
  // Pages-mode sweep hygiene: when E2E_READING_MODE=paginated, clear the
  // uploaded reading_mode preference from the shared e2e user afterwards.
  // No-ops on normal runs (the teardown checks the env var itself).
  globalTeardown: resolve(import.meta.dirname, 'fixtures/readingMode.teardown.js'),
  fullyParallel: false,        // SPA tests are stateful — run serially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,                  // Serial execution
  reporter: [['html', { outputFolder: 'report', open: 'never' }]],
  outputDir: 'test-results',

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8000',
    // Herd serves hyperlit.test over https with a locally-signed cert. Chrome
    // trusts it via the macOS keychain, but Playwright's Node-side request
    // context does not — API calls in specs die on TLS without this.
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    // Slow each action down so a --headed run is watchable. Defaults to 0 (no delay),
    // so normal/CI runs are unaffected. Usage: E2E_SLOWMO=800 npm run test:e2e:headed
    launchOptions: {
      slowMo: Number(process.env.E2E_SLOWMO) || 0,
    },
  },

  projects: [
    // Auth setup — runs first, saves session state
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
      testDir: './fixtures',
    },
    // All specs use the authenticated session
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        storageState: resolve(import.meta.dirname, 'fixtures/.auth-state.json'),
      },
      dependencies: ['setup'],
    },
  ],
});
