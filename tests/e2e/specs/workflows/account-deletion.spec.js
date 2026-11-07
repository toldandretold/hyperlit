import { test, expect } from '../../fixtures/navigation.fixture.js';
import { waitForCloudGreen } from '../../helpers/pageVerifiers.js';
import { readLibrary } from '../../helpers/backendRead.js';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const APP_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Account deletion end-to-end, real gestures only: a brand-new user registers
 * through the real signup form, authors a real (private) book, then deletes
 * their account through the Data sovereignty overlay — choice dialogs, typed
 * challenge, password — and the spec verifies the aftermath the way the world
 * would see it: login refused, the username permanently retired (re-signup
 * refused with the server's message), /u/{name} a 404, and the local device
 * wiped.
 *
 * The heavy cleanup runs in a QUEUED job (default queue). The spec drains the
 * queue itself via `queue:work --stop-when-empty`, so it passes whether or not
 * a dev worker happens to be running (if one grabbed the job first, the drain
 * exits immediately). Everything in its own browser context: the suite's
 * logged-in user must never be the one deleted.
 *
 * Private-book-only on purpose: with zero public books and zero annotations
 * the flow skips both choice dialogs, which keeps the dialog walk
 * deterministic. The choice-matrix behaviour is covered per-table by
 * tests/Feature/Account/UserAccountDeletionServiceTest.php — this spec's job
 * is the JOURNEY, not the matrix.
 */

const PASSWORD = 'password-e2e-1';

/**
 * Where #user-container is in its lifecycle, read from the INLINE styles its
 * manager writes (userContainer/index.ts), not from computed ones. Computed
 * opacity and offsetWidth stay non-zero for the whole close transition (it
 * fades opacity AND shrinks width/height), so the old `opacity !== '0' &&
 * offsetWidth > 0` probe read a CLOSING panel as open: the helper declined to
 * re-click, and a partly-visible control passed `toBeInViewport()` (default
 * ratio > 0) on its way off screen. Every later click then found its target
 * "outside of the viewport" until the test timed out. The inline writes flip
 * at the START of each transition, so they name the intent:
 *   open → openContainer set opacity '1' (in its rAF) and a real width
 *   closing → closeContainer set opacity '0' + width '0', `.hidden` not yet added
 *   closed → `.hidden` (or never opened)
 * A panel caught between openContainer's sync writes and its rAF reads as
 * 'opening' and is waited out like 'closing': clicking then would toggle it.
 */
const userPanelState = (page) => page.evaluate(() => {
  const c = document.getElementById('user-container');
  if (!c || c.classList.contains('hidden') || c.style.visibility === 'hidden') return 'closed';
  if (c.style.width === '0' || c.style.width === '0px') return 'closing';
  if (c.style.opacity === '1') return 'open';
  return 'opening';
});

/**
 * Open the user container until `bottomControl` is fully on screen. Clicks ONLY
 * while the container is settled-closed: a click during either transition
 * TOGGLES it (or is dropped by the isAnimating guard), which is how the old
 * blind retry oscillated.
 */
async function openUserPanel(page, bottomControl) {
  await page.waitForSelector('#userButton', { timeout: 15000 });
  await expect(async () => {
    const state = await userPanelState(page);
    if (state === 'closing' || state === 'opening') {
      throw new Error(`user panel is ${state}; waiting for it to settle`);
    }
    if (state === 'closed') {
      await page.click('#userButton');
    }
    try {
      // ratio 1: the WHOLE control, so a panel sliding away can't pass. Also
      // check the state again afterwards: a close that started during the
      // wait must not be accepted.
      await expect(page.locator(bottomControl)).toBeInViewport({ ratio: 1, timeout: 2500 });
      expect(await userPanelState(page)).toBe('open');
    } catch (e) {
      // Open but empty/wrong state (clicked before auth state resolved): close
      // so a later iteration re-clicks into a settled container. Only close an
      // OPEN panel; Escape on a closing one does nothing useful.
      if (await userPanelState(page) === 'open') await page.keyboard.press('Escape');
      throw e;
    }
  }).toPass({ timeout: 30000 });
}

/** Open the user container until the login form shows. */
const openLoginForm = (page) => openUserPanel(page, '#showRegister');

/** Open the logged-in profile menu until the Data row shows. */
const openProfileMenu = (page) => openUserPanel(page, '#dataSovereigntyBtn');

/** Register a brand-new user through the real signup form (fresh, logged-out context). */
async function registerUser(page, name) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await openLoginForm(page);
  await page.click('#showRegister');
  await expect(page.locator('#registerName')).toBeInViewport({ timeout: 5000 });
  await page.fill('#registerName', name);
  await page.fill('#registerEmail', `${name}@test.local`);
  await page.fill('#registerPassword', PASSWORD);
  await expect(async () => {
    await page.evaluate(() => document.getElementById('registerSubmit')?.click());
    await page.waitForFunction(() => !document.querySelector('#registerPassword'), null, { timeout: 4000 });
  }).toPass({ timeout: 20000 });
}

/** Author a fresh private book as the current user (grand-tour recipe, no publish). */
async function authorPrivateBook(page, spa, title) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.evaluate(() => document.getElementById('newBookButton')?.click());
  await page.waitForFunction(() => {
    const c = document.getElementById('newbook-container');
    return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
  }, null, { timeout: 5000 });
  await page.evaluate(() => document.getElementById('createNewBook')?.click());

  await spa.waitForTransition(page);
  await spa.waitForEditMode(page);
  const bookId = await spa.getCurrentBookId(page);
  expect(bookId).toMatch(/^book_\d+$/);

  await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
  await page.click('h1[id="100"]');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.type('A private book that must not survive its author.');
  await page.waitForTimeout(500);
  await waitForCloudGreen(page);

  return bookId;
}

test.describe('account deletion', () => {
  test('a user can delete their account through the Data sovereignty overlay, and the deletion is total', async ({ browser, spa }) => {
    test.setTimeout(180000);

    const name = `DelE2e${Date.now().toString().slice(-8)}`;
    // browser.newContext() INHERITS the project's storageState (the logged-in
    // suite user — see notifications.spec's anon-context note). Explicitly
    // empty, or this spec would delete the SUITE USER'S account.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    // ── Build a life worth deleting ─────────────────────────────────────
    await registerUser(page, name);
    const bookId = await authorPrivateBook(page, spa, 'Doomed Book');

    // The book reached Postgres (not just IndexedDB) before we destroy it.
    await expect(async () => {
      const lib = await readLibrary(page, bookId);
      expect(lib.ok).toBe(true);
    }).toPass({ timeout: 10000 });

    // ── The deletion journey: profile menu → Data → Delete account ──────
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await openProfileMenu(page);
    await page.click('#dataSovereigntyBtn');

    // The overlay (same skeleton as Stats): rows present, then Delete.
    await page.waitForSelector('#data-sovereignty-overlay .datasov-panel', { timeout: 8000 });
    await expect(page.locator('.datasov-panel-title')).toHaveText('Data sovereignty');
    await page.click('#datasovDeleteBtn');

    // Private-only account ⇒ no choice dialogs; first stop is the
    // consequences screen. Its confirm must spell out irreversibility.
    await page.waitForSelector('.app-dialog-overlay', { timeout: 8000 });
    await expect(page.locator('.app-dialog-card')).toContainText('irreversible');
    await page.click('.app-dialog-overlay [data-act="confirm"]');

    // Typed challenge + password. Wrong phrase first — must refuse and POST nothing.
    await page.waitForSelector('#fd-text-challenge', { timeout: 8000 });
    await page.fill('#fd-text-challenge', 'delete something else');
    await page.fill('#fd-text-password', PASSWORD);
    await page.click('.app-dialog-overlay [data-act="confirm"]');
    await page.waitForSelector('.app-dialog-card', { timeout: 8000 });
    await expect(page.locator('.app-dialog-card')).toContainText('did not match');
    await page.click('.app-dialog-overlay [data-act="ok"]');

    // Round two, for real. (The phrase check is case-insensitive by design.)
    await openProfileMenu(page);
    await page.click('#dataSovereigntyBtn');
    await page.waitForSelector('#datasovDeleteBtn', { timeout: 8000 });
    await page.click('#datasovDeleteBtn');
    await page.waitForSelector('.app-dialog-overlay [data-act="confirm"]', { timeout: 8000 });
    await page.click('.app-dialog-overlay [data-act="confirm"]');
    await page.waitForSelector('#fd-text-challenge', { timeout: 8000 });
    await page.fill('#fd-text-challenge', 'delete my account');
    await page.fill('#fd-text-password', PASSWORD);
    const deletionResponse = page.waitForResponse(
      (r) => r.url().includes('/api/user/account-deletion') && r.request().method() === 'POST',
      { timeout: 20000 },
    );
    await page.click('.app-dialog-overlay [data-act="confirm"]');
    const delResp = await deletionResponse;
    expect(delResp.status(), `deletion POST body: ${await delResp.text()}`).toBe(202);

    // Success alert, then the hard redirect home as a logged-out visitor.
    await page.waitForSelector('.app-dialog-overlay [data-act="ok"]', { timeout: 20000 });
    await expect(page.locator('.app-dialog-card')).toContainText('Account deleted');
    await page.click('.app-dialog-overlay [data-act="ok"]');
    await page.waitForURL('**/', { timeout: 15000 });

    // Local device wiped + logged out: the user button must now offer the
    // LOGIN form (the logged-in profile menu would show #dataSovereigntyBtn).
    await openLoginForm(page);
    await expect(page.locator('#dataSovereigntyBtn')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // ── Drain the queued job, then verify the world's view ──────────────
    // A dev worker may have grabbed the job already — the drain then exits
    // instantly, so completion is confirmed by POLLING the first visible
    // effect of the job's tombstone phase: the profile URL going 404.
    execSync('php artisan queue:work --queue=default --stop-when-empty', {
      cwd: APP_ROOT, stdio: 'pipe', timeout: 120000,
    });
    await expect(async () => {
      const profile = await page.request.get(`/u/${name}`);
      expect(profile.status()).toBe(404);
    }).toPass({ timeout: 60000 });

    // Old credentials are dead (generic refusal, not an oracle).
    const login = await page.evaluate(async (creds) => {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(creds),
      });
      return res.status;
    }, { email: `${name}@test.local`, password: PASSWORD });
    expect(login).toBe(422);

    // The username is retired forever — the real signup form refuses it.
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await openLoginForm(page);
    await page.click('#showRegister');
    await page.fill('#registerName', name);
    await page.fill('#registerEmail', `again-${name}@test.local`);
    await page.fill('#registerPassword', PASSWORD);
    await page.evaluate(() => document.getElementById('registerSubmit')?.click());
    await expect(page.getByText(/not available|reserved/i).first()).toBeVisible({ timeout: 10000 });

    // The private book is gone from the server. The /data endpoint is the one
    // that 404s for a book with no rows (the /library sibling 200s empty —
    // see backendRead.js); hard-deleted means NO rows, so 404 it is.
    const bookResp = await page.request.get(`/api/database-to-indexeddb/books/${bookId}/data`);
    expect(bookResp.status()).toBe(404);

    await context.close();
  });
});
