import { test as setup } from '@playwright/test';
import { resolve } from 'path';

const authFile = resolve(import.meta.dirname, '.auth-state.json');

setup('authenticate', async ({ page }) => {
  const baseURL = process.env.E2E_BASE_URL || 'http://localhost:8000';

  // Navigate to the app.
  // Wait only for DOMContentLoaded, not the full `load` event: the SPA fires an
  // on-boot fetch (e.g. /api/vibe-convert/review/most-recent) that can keep a
  // request in flight, so `load` may never settle within the navigation timeout.
  // The app shell (and #userButton below) is interactive well before `load`, so
  // DOMContentLoaded is the correct readiness signal here.
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

  // Click the user button to open login form
  await page.click('#userButton');

  // Wait for the login form to appear
  await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 10000 });

  // Fill login credentials
  await page.fill('input[name="email"], input[type="email"]', process.env.E2E_USER_EMAIL || 'test@example.com');
  await page.fill('input[name="password"], input[type="password"]', process.env.E2E_USER_PASSWORD || 'password');

  // Submit the form. Dispatch the click via page.evaluate so this works in
  // --headed mode where the actual OS window may be shorter than the form,
  // pushing the submit button below the viewport. Playwright's locator.click
  // refuses to click elements outside the viewport even after scrolling
  // (it auto-fails when scroll-into-view doesn't move them into the visible
  // area, which happens when the form lives in a fixed-height non-scrolling
  // panel). A JS click bypasses that actionability check.
  await page.evaluate(() => {
    const btn = document.querySelector('#loginSubmit')
      || document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });

  // Wait for successful login — user container should change state
  await page.waitForFunction(() => {
    // After login the user button area typically updates
    return document.querySelector('.user-logged-in') ||
           document.querySelector('[data-authenticated]') ||
           // Fallback: wait for the login form to disappear
           !document.querySelector('input[name="password"]');
  }, { timeout: 15000 });

  // Give the app time to settle after login
  await page.waitForTimeout(1000);

  // Save storage state for reuse
  await page.context().storageState({ path: authFile });
});
