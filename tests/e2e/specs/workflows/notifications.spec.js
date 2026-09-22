import { test, expect } from '../../fixtures/navigation.fixture.js';
import { findParagraphByText, waitForCloudGreen } from '../../helpers/pageVerifiers.js';
import { readLibrary } from '../../helpers/backendRead.js';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const APP_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Notifications end-to-end: real engagement by OTHER identities surfaces for
 * the book owner as feed rows + the pink unread dot, via real gestures only.
 *
 *  1. Owner (the suite's logged-in user) authors a book (grand-tour recipe),
 *     flips it PUBLIC through the source container's visibility control.
 *  2. An ANONYMOUS context hyperlights it → owner sees "Someone highlighted
 *     your book …" with the pink dot on #userButton and the Notifications row.
 *  3. A REGISTERED second user (created through the real signup form) likes
 *     the book via the source container's #like-book — the first e2e coverage
 *     that button has ever had — and mints + pastes a hypercite (pairing) →
 *     owner sees "liked your book" and "cited".
 *
 * Opening the panel marks everything read: the dot must be gone on re-open.
 */

/** Author a fresh book as the CURRENT page's user and make it public. */
async function authorPublicBook(page, spa, title) {
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
  await page.keyboard.type('Notification source text for highlight and quote. Some content worth engaging with.');
  await page.waitForTimeout(500);
  await waitForCloudGreen(page);

  // Public, via the real visibility control in the source container.
  await page.click('#cloudRef');
  await page.waitForSelector('#source-container.open', { timeout: 8000 });
  await page.waitForSelector('#visibility-control .visibility-trigger', { timeout: 8000 });
  await page.click('#visibility-control .visibility-trigger');
  await page.waitForSelector('#visibility-control.vis-open', { timeout: 4000 });
  await page.click('#visibility-control .visibility-option[data-target="public"]');
  // "Make this book public?" confirm dialog (components/dialog).
  await page.waitForSelector('.app-dialog-overlay [data-act="confirm"]', { timeout: 5000 });
  await page.click('.app-dialog-overlay [data-act="confirm"]');
  await page.waitForSelector('#visibility-control[data-state="public"]', { timeout: 10000 });

  // Confirm the flip reached Postgres before another identity tries to read it.
  await expect(async () => {
    const lib = await readLibrary(page, bookId);
    expect(lib.ok).toBe(true);
    expect(lib.body?.visibility ?? lib.body?.library?.visibility).toBe('public');
  }).toPass({ timeout: 10000 });

  await page.keyboard.press('Escape'); // close the source container
  return bookId;
}

/** Open a book and wait until its content (containing `needle`) is actually rendered. */
async function openBookWithContent(page, bookId, needle) {
  await page.goto(`/${bookId}`, { waitUntil: 'domcontentloaded' });
  // A freshly-navigated (esp. just-registered / anonymous) context can hold a
  // boot connection open past networkidle while the content is long usable —
  // wait on the CONTENT, generously, not the network.
  await page.waitForFunction(
    (text) => (document.querySelector('.main-content')?.textContent || '').includes(text),
    needle,
    { timeout: 45000 },
  );
  await page.waitForTimeout(1000); // let annotations + session settle
}

/** Select `needle` in the paragraph containing `anchorText` and hyperlight it. */
async function hyperlightAs(page, spa, needle, anchorText) {
  const sel = await findParagraphByText(page, anchorText);
  expect(sel).not.toBeNull();
  const text = await page.locator(sel).textContent();
  const start = text.indexOf(needle);
  expect(start).toBeGreaterThanOrEqual(0);
  await spa.selectTextInElement(page, sel, start, start + needle.length);
  await spa.waitForHyperlightButtons(page);
  await page.click('#copy-hyperlight');
  await page.waitForFunction(() => {
    const marks = document.querySelectorAll('.main-content mark.user-highlight, .main-content mark.highlight');
    return marks.length >= 1;
  }, null, { timeout: 10000 });
  await waitForCloudGreen(page);
}

/** Register a brand-new user through the real signup form (page must be a fresh, logged-out context). */
async function registerUser(page, name) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await expect(async () => {
    if (!(await page.locator('input[type="email"]').first().isVisible())) {
      await page.click('#userButton');
    }
    await expect(page.locator('input[type="email"]').first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await page.click('#showRegister');
  await page.fill('#registerName', name);
  await page.fill('#registerEmail', `${name}@test.local`);
  await page.fill('#registerPassword', 'password-e2e-1');
  await expect(async () => {
    await page.evaluate(() => document.getElementById('registerSubmit')?.click());
    await page.waitForFunction(() => !document.querySelector('#registerPassword'), null, { timeout: 4000 });
  }).toPass({ timeout: 20000 });

  // The publishing gate (config/publishing.php) requires a verified email for
  // accounts created after the cutoff — which is every user this spec registers.
  // @test.local has no mailbox, so verify through the dev-only artisan seam.
  execSync(`php artisan e2e:verify-user ${name}`, { cwd: APP_ROOT, stdio: 'pipe' });
}

/**
 * Mark everything read for the CURRENT page's logged-in user (the suite owner).
 * Test-isolation hygiene: a previous test that died before opening the panel
 * leaves unread rows behind, and every "no dot" assertion downstream then fails
 * on residue instead of what it's testing. In-page fetch, not page.request —
 * Sanctum stateful auth needs the app's own Origin + session cookie.
 */
async function markAllNotificationsRead(page) {
  await page.evaluate(async () => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    const token = m ? decodeURIComponent(m[1]) : '';
    const res = await fetch('/api/notifications/read', {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-XSRF-TOKEN': token },
      credentials: 'include',
    });
    try { await res.text(); } catch { /* drained best-effort */ }
  });
}

/** Open the account menu; return whether #userButton currently carries the dot. */
async function openAccountMenu(page) {
  await expect(async () => {
    if (!(await page.locator('#user-container .user-profile, #user-container input[type="email"]').first().isVisible())) {
      await page.click('#userButton');
    }
    await expect(page.locator('#user-container .user-profile, #user-container input[type="email"]').first())
      .toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/** Open the notifications panel from the profile menu and return its locator. */
async function openNotificationsPanel(page) {
  await openAccountMenu(page);
  await page.waitForSelector('#notificationsBtn', { timeout: 5000 });
  await page.click('#notificationsBtn');
  await page.waitForSelector('#notifications-overlay .notifications-panel', { timeout: 8000 });
  // Rows (or the empty state) rendered — loading placeholder replaced.
  await page.waitForFunction(() => {
    const body = document.querySelector('#notifications-overlay .notifications-panel-body');
    return body && !/Loading/.test(body.textContent || '');
  }, null, { timeout: 8000 });
  return page.locator('#notifications-overlay');
}

test.describe('Notifications', () => {
  // Every test asserts on the owner's unread state, so start each from a clean
  // slate — otherwise one test dying before its panel-open (which is what marks
  // things read) poisons every later "no dot" assertion with its residue.
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await markAllNotificationsRead(page);
  });

  test('anonymous highlight → owner sees "Someone highlighted", pink dot appears and clears', async ({ page, spa, browser }) => {
    test.setTimeout(240_000);

    const bookId = await authorPublicBook(page, spa, 'Notif Tour Alpha');

    // ── Anonymous reader highlights the owner's book ──
    // browser.newContext() INHERITS the project's storageState (the logged-in
    // suite user) — pass an explicitly empty state or the "anon" actor is the
    // owner and every event self-suppresses.
    const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage = await anonCtx.newPage();
    await openBookWithContent(anonPage, bookId, 'Notification source text');
    await hyperlightAs(anonPage, spa, 'highlight', 'Notification source text');
    await anonCtx.close();

    // ── Owner returns: fresh page entry refreshes the badge ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Pink dot on the Account button (JS-injected, unread > 0).
    await page.waitForSelector('#userButton .notif-dot-anchor.has-unread', { timeout: 10000 });

    // Menu row carries it too.
    await openAccountMenu(page);
    await page.waitForSelector('#notificationsBtn .notif-dot-anchor.has-unread', { timeout: 5000 });

    // Panel: the anonymous actor renders as "Someone", the row links to the highlight.
    const overlay = await openNotificationsPanel(page);
    const row = overlay.locator('.notif-row', { hasText: 'Someone highlighted' }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('your book');
    expect(await row.getAttribute('href')).toContain(`/${bookId}#`);

    // Opening marked everything read: dots are gone, and stay gone on re-open.
    await expect(page.locator('.notif-dot-anchor.has-unread')).toHaveCount(0);
    await page.click('#notifications-overlay .notifications-panel-close');
    await openAccountMenu(page);
    await expect(page.locator('#notificationsBtn .notif-dot-anchor.has-unread')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('a second registered user likes + cites → owner notified with actor name', async ({ page, spa, browser }) => {
    test.setTimeout(300_000);

    const bookId = await authorPublicBook(page, spa, 'Notif Tour Beta');

    // ── Register user B through the real signup form (fresh context) ──
    // Explicitly empty storageState — see the anon-context note above.
    const bCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const bPage = await bCtx.newPage();
    const bName = `notif_e2e_${Date.now().toString(36)}`;
    await registerUser(bPage, bName);

    // ── B likes the owner's book via the source container ──
    await openBookWithContent(bPage, bookId, 'Notification source text');
    await bPage.click('#cloudRef');
    await bPage.waitForSelector('#source-container.open', { timeout: 8000 });
    await bPage.waitForSelector('#like-book', { timeout: 8000 });
    await bPage.click('#like-book');
    await bPage.waitForFunction(() =>
      document.getElementById('like-book')?.getAttribute('aria-pressed') === 'true', null, { timeout: 8000 });
    await bPage.keyboard.press('Escape');

    // ── B mints a hypercite on the owner's book and pastes it into B's own book (PAIRING) ──
    const hcSel = await findParagraphByText(bPage, 'Notification source text');
    expect(hcSel).not.toBeNull();
    const hcText = await bPage.locator(hcSel).textContent();
    const hcStart = hcText.indexOf('quote');
    expect(hcStart).toBeGreaterThanOrEqual(0);
    await spa.selectTextInElement(bPage, hcSel, hcStart, hcStart + 'quote'.length);
    await spa.waitForHyperlightButtons(bPage);
    await bPage.click('#copy-hypercite');
    await bPage.waitForSelector('u[id^="hypercite_"].single', { timeout: 8000 });
    await waitForCloudGreen(bPage);

    const clipboard = await bPage.evaluate((ownerBook) => {
      const uEl = document.querySelector('u[id^="hypercite_"].single');
      const href = `${window.location.origin}/${ownerBook}#${uEl.id}`;
      return {
        html: `'${uEl.textContent}'⁠<a href="${href}" id="${uEl.id}" class="open-icon">↗</a>`,
        text: uEl.textContent,
      };
    }, bookId);

    // B's own book to paste into — PUBLIC, deliberately: pairing from a
    // private citing book must stay silent (the private book's id would be a
    // leak), so a notification only fires when B's book is public.
    await authorPublicBook(bPage, spa, 'B quotes things');
    const bPara = await findParagraphByText(bPage, 'Notification source text');
    expect(bPara).not.toBeNull();
    await bPage.click(bPara);
    await bPage.keyboard.press('End');
    await bPage.keyboard.press('Enter');
    await bPage.waitForTimeout(300);
    await spa.pasteHyperciteContent(bPage, clipboard.html, clipboard.text);
    await bPage.waitForTimeout(1000);
    await waitForCloudGreen(bPage);
    await bCtx.close();

    // ── Owner: both events, attributed to B by name ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('#userButton .notif-dot-anchor.has-unread', { timeout: 10000 });

    const overlay = await openNotificationsPanel(page);
    const likeRow = overlay.locator('.notif-row', { hasText: `${bName} liked` }).first();
    await expect(likeRow).toBeVisible();
    await expect(likeRow).toContainText('your book');

    const citeRow = overlay.locator('.notif-row', { hasText: `${bName} cited` }).first();
    await expect(citeRow).toBeVisible();
    // The cite row links to B's citation — B's book, not the owner's.
    expect(await citeRow.getAttribute('href')).not.toContain(`/${bookId}`);
  });

  test('a cite pasted into a PRIVATE book is silent until the book is published, then notifies', async ({ page, spa, browser }) => {
    test.setTimeout(360_000);

    const bookId = await authorPublicBook(page, spa, 'Notif Tour Delta');

    // B registers, mints a hypercite on the owner's book, copies it.
    const bCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const bPage = await bCtx.newPage();
    const bName = `notif_fan_${Date.now().toString(36)}`;
    await registerUser(bPage, bName);
    await openBookWithContent(bPage, bookId, 'Notification source text');

    const hcSel = await findParagraphByText(bPage, 'Notification source text');
    const hcText = await bPage.locator(hcSel).textContent();
    const hcStart = hcText.indexOf('quote');
    await spa.selectTextInElement(bPage, hcSel, hcStart, hcStart + 'quote'.length);
    await spa.waitForHyperlightButtons(bPage);
    await bPage.click('#copy-hypercite');
    await bPage.waitForSelector('u[id^="hypercite_"].single', { timeout: 8000 });
    await waitForCloudGreen(bPage);
    const clipboard = await bPage.evaluate((ownerBook) => {
      const uEl = document.querySelector('u[id^="hypercite_"].single');
      const href = `${window.location.origin}/${ownerBook}#${uEl.id}`;
      return { html: `'${uEl.textContent}'⁠<a href="${href}" id="${uEl.id}" class="open-icon">↗</a>`, text: uEl.textContent };
    }, bookId);

    // B creates a NEW book (born PRIVATE by default) and pastes the cite into it.
    await bPage.goto('/');
    await bPage.waitForLoadState('networkidle');
    await bPage.evaluate(() => document.getElementById('newBookButton')?.click());
    await bPage.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await bPage.evaluate(() => document.getElementById('createNewBook')?.click());
    await spa.waitForTransition(bPage);
    await spa.waitForEditMode(bPage);
    const bBookId = await spa.getCurrentBookId(bPage);
    await bPage.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await bPage.click('h1[id="100"]');
    await bPage.keyboard.type('Private citer');
    await bPage.keyboard.press('Enter');
    await bPage.waitForTimeout(300);
    await spa.pasteHyperciteContent(bPage, clipboard.html, clipboard.text);
    await bPage.waitForTimeout(1000);
    await waitForCloudGreen(bPage);

    // ── Owner: nothing yet — B's citing book is private ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await expect(page.locator('#userButton .notif-dot-anchor.has-unread')).toHaveCount(0);

    // ── B publishes their book ──
    await bPage.click('#cloudRef');
    await bPage.waitForSelector('#source-container.open', { timeout: 8000 });
    await bPage.waitForSelector('#visibility-control .visibility-trigger', { timeout: 8000 });
    await bPage.click('#visibility-control .visibility-trigger');
    await bPage.waitForSelector('#visibility-control.vis-open', { timeout: 4000 });
    await bPage.click('#visibility-control .visibility-option[data-target="public"]');
    await bPage.waitForSelector('.app-dialog-overlay [data-act="confirm"]', { timeout: 5000 });
    await bPage.click('.app-dialog-overlay [data-act="confirm"]');
    await bPage.waitForSelector('#visibility-control[data-state="public"]', { timeout: 10000 });
    await bPage.waitForTimeout(1500); // let the publish + fan-out land
    await bCtx.close();

    // ── Owner: NOW the belated cite notification appears ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('#userButton .notif-dot-anchor.has-unread', { timeout: 10000 });
    const overlay = await openNotificationsPanel(page);
    const citeRow = overlay.locator('.notif-row', { hasText: `${bName} cited` }).first();
    await expect(citeRow).toBeVisible();
    expect(await citeRow.getAttribute('href')).toContain(`/${bBookId}`); // links to B's now-public book
  });

  test('a PRIVATE highlight never notifies the owner and 404s on the owner\'s deep-link pull', async ({ page, spa, browser }) => {
    test.setTimeout(300_000);

    const bookId = await authorPublicBook(page, spa, 'Notif Tour Gamma');

    // ── B registers, highlights the owner's book, flips the highlight PRIVATE ──
    const bCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const bPage = await bCtx.newPage();
    await registerUser(bPage, `notif_priv_${Date.now().toString(36)}`);
    await openBookWithContent(bPage, bookId, 'Notification source text');
    await hyperlightAs(bPage, spa, 'highlight', 'Notification source text');

    // The hyperlit-container is open from the highlight; flip via its per-highlight control.
    await bPage.waitForSelector('#hyperlit-container.open .hl-visibility-control .visibility-trigger', { timeout: 8000 });
    await bPage.click('#hyperlit-container .hl-visibility-control .visibility-trigger');
    await bPage.click('#hyperlit-container .hl-visibility-control .visibility-option[data-target="private"]');
    await bPage.waitForSelector('#hyperlit-container .hl-visibility-control[data-state="private"]', { timeout: 10000 });

    // Grab the private highlight id for the owner's deep-link probe.
    const hlId = await bPage.evaluate(() =>
      document.querySelector('#hyperlit-container .hl-visibility-control')?.getAttribute('data-highlight-id'));
    expect(hlId).toBeTruthy();
    await bPage.waitForTimeout(1000); // let the flip sync

    // ── STICKY DEFAULT: B's NEXT highlight is born PRIVATE (reads the sticky
    //    the flip above just set) — its OWN per-highlight control shows private
    //    with no flip. Target highlight #2 specifically (the container lists #1
    //    too, which is also private), by its distinct id. ──
    await bPage.keyboard.press('Escape'); // close the container
    await hyperlightAs(bPage, spa, 'quote', 'Notification source text');
    // The newly-created highlight's control is the one whose id differs from #1.
    const hlId2 = await bPage.evaluate((firstId) => {
      const ctrls = Array.from(document.querySelectorAll('#hyperlit-container .hl-visibility-control'));
      const fresh = ctrls.find((c) => c.getAttribute('data-highlight-id') !== firstId);
      return fresh?.getAttribute('data-highlight-id') || null;
    }, hlId);
    expect(hlId2).toBeTruthy();
    // Born private without any flip — the sticky default carried into create.
    await expect(bPage.locator(`#hyperlit-container .hl-visibility-control[data-highlight-id="${hlId2}"][data-state="private"]`))
      .toBeVisible({ timeout: 8000 });
    await bPage.waitForTimeout(1000); // let it sync
    await bCtx.close();

    // ── Owner: NO dot, NO notification about the private highlight ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Give the badge poll a beat; then assert no dot.
    await page.waitForTimeout(1500);
    await expect(page.locator('#userButton .notif-dot-anchor.has-unread')).toHaveCount(0);

    // ── Owner: the deep-link pull for the private highlight 404s ──
    const status = await page.evaluate(async ({ book, id }) => {
      const res = await fetch(`/api/db/hyperlights/find/${book}/${id}`, { headers: { Accept: 'application/json' } });
      return res.status;
    }, { book: bookId, id: hlId });
    expect(status).toBe(404);
  });
});
