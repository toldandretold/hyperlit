import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * A new book whose create handshake is REFUSED still settles on the server.
 *
 * A new book is created optimistically in IndexedDB and announced by ONE POST to
 * /api/db/library/bulk-create. nested-authoring-stress (2026-11-09) caught that
 * POST 429'ing — it sat in the shared per-user throttle bucket while licenses.spec
 * hammered reads as the same user — and the book never got a library row. The
 * client's fallback (createNewBook.queueNewBookForRetry → unified-sync) could not
 * create one either, so every later save 500'd "Book not found" and the
 * server-trouble modal covered the editor.
 *
 * The bucket is now named, but the recovery path is what this pins: refuse the
 * handshake outright and the next unified-sync must create the row itself
 * (UnifiedSyncController::ensureTopLevelLibraryRow → `library_created`).
 */
test('a 429 on the new-book create handshake is healed by the next sync', async ({ page, spa }) => {
  test.setTimeout(90_000);

  let refused = 0;
  await page.route('**/api/db/library/bulk-create', async (route) => {
    refused++;
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Too Many Attempts.' }),
    });
  });

  const healed = page.waitForResponse(async (res) => {
    if (!res.url().includes('/api/db/unified-sync') || res.request().method() !== 'POST') return false;
    try { return (await res.json())?.library_created === true; } catch { return false; }
  }, { timeout: 30_000 });

  const { bookId } = await spa.createNewBook(page, spa);
  expect(refused, 'the create handshake should have been attempted (and refused)').toBeGreaterThan(0);

  await page.click('h1[id="100"]');
  await page.keyboard.type('Handshake Refused');
  await page.keyboard.press('Enter');
  await page.keyboard.type('bodyAfterRefusedCreateXX');

  await healed;

  await page.waitForFunction(() => {
    const btn = document.getElementById('cloudRef');
    return !!btn && btn.getAttribute('data-last-sync') === 'success' && btn.getAttribute('data-save-state') !== 'saving';
  }, null, { timeout: 20_000 });

  expect(await page.locator('#integrity-failure-backdrop').count(), 'server-trouble modal must not appear').toBe(0);

  // The server holds the book: an anonymous-of-IDB read of its library row works.
  const lib = await page.evaluate(async (b) => {
    const r = await fetch(`/api/database-to-indexeddb/books/${encodeURIComponent(b)}/library`, { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, bookId);
  expect(lib.status, `library row for ${bookId} should exist server-side`).toBe(200);
});
