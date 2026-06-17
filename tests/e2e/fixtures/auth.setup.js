import { test as setup, expect } from '@playwright/test';
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

  // Click the user button to open the login form.
  //
  // #userButton's click handler is attached by ButtonRegistry during SPA
  // bootstrap, which completes a few hundred ms AFTER domcontentloaded. A click
  // fired before then hits a button with no listener and is silently dropped —
  // so we retry the click until the login form actually appears. The guard
  // (only click when the form isn't already open) prevents a stray retry from
  // toggling an already-open form shut.
  const emailInput = page.locator('input[name="email"], input[type="email"]');
  await expect(async () => {
    if (!(await emailInput.isVisible())) {
      await page.click('#userButton');
    }
    await expect(emailInput).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });

  // Fill login credentials
  await page.fill('input[name="email"], input[type="email"]', process.env.E2E_USER_EMAIL || 'test@example.com');
  await page.fill('input[name="password"], input[type="password"]', process.env.E2E_USER_PASSWORD || 'password');

  // Submit the form, retrying until login actually takes.
  //
  // handleLogin() does `await fetch('/sanctum/csrf-cookie')` then reads the
  // XSRF cookie before POSTing /api/login. That cookie fetch races with the
  // home page's still-in-flight boot (the "Connecting to database…" feed
  // load); when the server is slow the fetch is aborted, and on a fresh
  // browser with no prior XSRF cookie the /api/login POST then goes out
  // CSRF-less and fails silently — leaving the form up. A single dropped
  // submit would otherwise time out the whole suite, so retry the
  // submit+success-check together until it sticks.
  //
  // We dispatch the click via page.evaluate (not locator.click) so this works
  // in --headed mode where the OS window may be shorter than the form, pushing
  // the submit button below the viewport — Playwright refuses to click
  // elements outside the viewport even after scrolling (the form lives in a
  // fixed-height non-scrolling panel). A JS click bypasses that check.
  await expect(async () => {
    // Re-fill in case a prior failed attempt re-rendered/cleared the form.
    await page.fill('input[name="email"], input[type="email"]', process.env.E2E_USER_EMAIL || 'test@example.com');
    await page.fill('input[name="password"], input[type="password"]', process.env.E2E_USER_PASSWORD || 'password');
    await page.evaluate(() => {
      const btn = document.querySelector('#loginSubmit')
        || document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    });

    // Wait for successful login — user container should change state.
    await page.waitForFunction(() => {
      // After login the user button area typically updates
      return document.querySelector('.user-logged-in') ||
             document.querySelector('[data-authenticated]') ||
             // Fallback: wait for the login form to disappear
             !document.querySelector('input[name="password"]');
    }, { timeout: 5000 });
  }).toPass({ timeout: 20000 });

  // Give the app time to settle after login
  await page.waitForTimeout(1000);

  // Save storage state for reuse
  await page.context().storageState({ path: authFile });
});
