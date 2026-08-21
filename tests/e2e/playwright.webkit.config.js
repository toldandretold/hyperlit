// @ts-check
// WebKit (Safari-engine) variant of the main config — for specs whose
// behaviour differs in Safari (iframe navigation timing, IndexedDB). Run:
//   npx playwright test -c playwright.webkit.config.js specs/maintainer/...
// Chromium remains the default suite; this exists because the hypercite
// console's panes shipped Chromium-green and arrived Safari-blank.
import { defineConfig } from '@playwright/test';
import { resolve } from 'path';
import { readFileSync } from 'fs';

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
  // rely on real env vars
}

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8000',
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
      testDir: './fixtures',
      use: { browserName: 'webkit' },
    },
    {
      name: 'webkit',
      use: {
        browserName: 'webkit',
        storageState: resolve(import.meta.dirname, 'fixtures/.auth-state.json'),
      },
      dependencies: ['setup'],
    },
  ],
});
