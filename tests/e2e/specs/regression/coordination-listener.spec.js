import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Multi-tab "Edited in another tab" overlay regression
 * (BroadcastListener.js / saveQueue.js).
 *
 * Three guards:
 *
 *  1. ACCUMULATION — registerBookOpen() runs on every reader init (it is called
 *     from initializePage.js, which fires on each SPA home→reader navigation).
 *     It used to attach a fresh, never-removed 'message' listener to the
 *     singleton 'hyperlit-tab-coordination' BroadcastChannel each time; the fix
 *     attaches it once for the tab's lifetime. (Teeth-checked: with the guard
 *     removed this grows by one per navigation.)
 *
 *  2. CONTROL — a genuine edit from a *different* tab must still raise the
 *     overlay, so a regression that disables the feature is caught.
 *
 *  3. SUPPRESSION — an echo of an edit this tab made itself must NOT raise the
 *     overlay (saveQueue records it in window.__hyperlitLocalEdits before
 *     broadcasting, 10s TTL), so the editor is never blocked mid-keystroke.
 *
 * Behavioural tests open the reader via a FULL page load so the book id is
 * resolvable and registerBookOpen() has armed the guard.
 */

const CHANNEL = 'hyperlit-tab-coordination';
const SEED_BOOK = 'book_1755338940';

// Precisely count 'message' listeners attached to the coordination channel,
// independent of the shared listener monitor's lumped bucket. Must run before
// any app script.
async function instrumentCoordinationChannel(page) {
  await page.addInitScript((channelName) => {
    const OrigBC = window.BroadcastChannel;
    window.__coordMsgListeners = 0;
    window.BroadcastChannel = class extends OrigBC {
      constructor(name) {
        super(name);
        this.__hlChannelName = name;
      }
      addEventListener(type, ...rest) {
        if (this.__hlChannelName === channelName && type === 'message') {
          window.__coordMsgListeners++;
        }
        return super.addEventListener(type, ...rest);
      }
      removeEventListener(type, ...rest) {
        if (this.__hlChannelName === channelName && type === 'message') {
          window.__coordMsgListeners--;
        }
        return super.removeEventListener(type, ...rest);
      }
    };
  }, CHANNEL);
}

// Open the reader by clicking the first book on home (SPA path).
async function openReaderSpa(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(await spa.getStructure(page)).toBe('home');
  await spa.clickFirstBookLink(page);
  await spa.waitForTransition(page);
  expect(await spa.getStructure(page)).toBe('reader');
}

// Open the reader via a FULL page load so initializePage() runs registerBookOpen()
// and the book id is resolvable.
async function openReaderFullLoad(page) {
  await page.goto(`/${SEED_BOOK}`);
  await page.waitForFunction(
    () => document.body.getAttribute('data-page') === 'reader',
    null,
    { timeout: 15000 }
  );
  await page.waitForTimeout(600); // let initializePage() run registerBookOpen()
}

// Resolve the book id the reader registered with registerBookOpen().
// The reader root carries the id on .main-content#book_… (window.book may be unset).
async function currentBookId(page) {
  return page.evaluate(() =>
    window.book ||
    document.querySelector('.main-content')?.id ||
    document.querySelector('[data-book-id]')?.getAttribute('data-book-id') ||
    null
  );
}

// Post a BOOK_EDITED for the given book, as if from another tab (foreign TAB_ID).
async function postForeignEdit(page, book, tabId = 'pw-foreign-tab') {
  await page.evaluate(
    ({ book, tabId, channel }) => {
      const bc = new BroadcastChannel(channel);
      bc.postMessage({ type: 'BOOK_EDITED', book, tabId });
      bc.close();
    },
    { book, tabId, channel: CHANNEL }
  );
}

test.describe('Coordination-channel overlay (multi-tab warning)', () => {
  test('coordination listener does not accumulate across home→reader cycles', async ({ page, spa }) => {
    await instrumentCoordinationChannel(page);

    // First reader entry registers the coordination listener once.
    await openReaderSpa(page, spa);
    const baseline = await page.evaluate(() => window.__coordMsgListeners || 0);

    // Cycle reader → home → reader several times via the SPA router.
    for (let i = 0; i < 3; i++) {
      await spa.navigateToHome(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('home');

      await spa.clickFirstBookLink(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('reader');
    }

    const after = await page.evaluate(() => window.__coordMsgListeners || 0);

    // With the leak this grew by one per reader entry (~3). The fix keeps it flat.
    expect(
      after - baseline,
      `coordination 'message' listeners grew by ${after - baseline} across 3 reader entries`
    ).toBeLessThanOrEqual(1);
  });

  test('a genuine edit from another tab raises the overlay (control)', async ({ page }) => {
    await openReaderFullLoad(page);
    const book = await currentBookId(page);
    expect(book, 'reader must expose a book id').toBeTruthy();

    await postForeignEdit(page, book);

    await expect(page.locator('#stale-tab-overlay')).toBeVisible({ timeout: 4000 });
  });

  test('an echo of this tab\'s own edit does NOT interrupt the editor', async ({ page }) => {
    await openReaderFullLoad(page);
    const book = await currentBookId(page);
    expect(book, 'reader must expose a book id').toBeTruthy();

    // Simulate the save path having just recorded a local edit for this book,
    // exactly as saveQueue.markBookEditedLocally() does before broadcasting.
    await page.evaluate((book) => {
      const root = String(book).split('/')[0];
      window.__hyperlitLocalEdits = window.__hyperlitLocalEdits || {};
      window.__hyperlitLocalEdits[root] = Date.now();
    }, book);

    // The echo carries a foreign TAB_ID; the local-edit record must still
    // suppress it so the editing tab is never blocked mid-keystroke.
    await postForeignEdit(page, book);

    await page.waitForTimeout(1500);
    await expect(page.locator('#stale-tab-overlay')).toHaveCount(0);
  });
});
