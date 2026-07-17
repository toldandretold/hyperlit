/**
 * Global teardown for the pages-mode e2e sweep (E2E_READING_MODE=paginated).
 *
 * During a sweep, the app's preference seeder (utilities/preferences.ts
 * seedFromServer → uploadMissingPreferences) uploads the localStorage
 * `hyperlit_reading_mode=paginated` the fixture injected onto the SHARED e2e
 * user's server preferences. Without this teardown, every subsequent NORMAL
 * e2e run (and manual login as that user) would come up in pages mode.
 *
 * Clears it by loading the app with the auth session (so the page's own CSRF
 * meta + cookies are valid) and POSTing `{ reading_mode: null }` through the
 * same endpoint the app uses — the controller treats null as "remove key".
 */
import { chromium } from '@playwright/test';
import { resolve } from 'path';

export default async function readingModeTeardown() {
  if (process.env.E2E_READING_MODE !== 'paginated') return;

  const baseURL = process.env.E2E_BASE_URL || 'http://localhost:8000';
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      storageState: resolve(import.meta.dirname, '.auth-state.json'),
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    // Deliberately NO paginated init script here — a plain app load whose
    // csrf meta tag we can use for the clearing POST.
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    const status = await page.evaluate(async () => {
      const token = document.querySelector('meta[name="csrf-token"]')?.content;
      if (!token) return 'no-csrf-token';
      const res = await fetch('/api/user/preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': token,
          'Accept': 'application/json',
        },
        credentials: 'same-origin',
        // reading_mode is now device-scoped (preferences.ts DEVICE_KEYS): a sweep
        // writes reading_mode_desktop/_mobile, so clear the legacy key AND both
        // device variants or the leak this teardown guards against returns.
        body: JSON.stringify({ reading_mode: null, reading_mode_mobile: null, reading_mode_desktop: null }),
      });
      return res.status;
    });
    if (status !== 200) {
      console.warn(`[readingMode.teardown] clearing reading_mode returned: ${status} — `
        + `the shared e2e user may still have pages mode set on the server.`);
    } else {
      console.log('[readingMode.teardown] cleared reading_mode from the e2e user.');
    }
  } finally {
    await browser.close();
  }
}
