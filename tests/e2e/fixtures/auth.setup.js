import { test as setup } from '@playwright/test';
import { resolve } from 'path';

const authFile = resolve(import.meta.dirname, '.auth-state.json');

setup('authenticate', async ({ page }) => {
  const baseURL = process.env.E2E_BASE_URL || 'http://localhost:8000';

  // Navigate to the app
  await page.goto(baseURL);

  // Click the user button to open login form
  await page.click('#userButton');

  // Wait for the login form to appear
  await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 10000 });

  // Fill login credentials
  await page.fill('input[name="email"], input[type="email"]', process.env.E2E_USER_EMAIL || 'test@example.com');
  await page.fill('input[name="password"], input[type="password"]', process.env.E2E_USER_PASSWORD || 'password');

  // Submit the form
  await page.click('button[type="submit"]');

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
