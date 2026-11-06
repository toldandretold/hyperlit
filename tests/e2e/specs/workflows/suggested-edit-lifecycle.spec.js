/**
 * Suggested edits — the full owner lifecycle, end to end through real gestures.
 *
 * A self-suggestion (the book's creator is also the suggester) lets ONE session
 * drive every transition: create a highlight → suggest an edit → Accept (and
 * verify the book's body text actually changes) → Revert (body restored) → Like
 * → Reconsider → Decline → Reconsider. Exercises the full-container editor, the
 * bottom Save bar, the confirm dialogs, the client-side splice, and every
 * resolve/reopen transition.
 *
 * Manual only (npm run test:e2e) — not in CI, like the rest of this folder.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { findParagraphByText, waitForCloudGreen } from '../../helpers/pageVerifiers.js';

const HL_SEL = '#hyperlit-container blockquote.highlight-text';

async function waitContainerOpen(page) {
  await page.waitForFunction(() => {
    const c = document.getElementById('hyperlit-container');
    return c && c.classList.contains('open');
  }, null, { timeout: 10000 });
}

/** Click a confirm dialog's Confirm button (accept / revert flows use it). */
async function confirmDialog(page) {
  await page.waitForSelector('[data-act="confirm"]', { timeout: 5000 });
  await page.click('[data-act="confirm"]');
  await page.waitForSelector('[data-act="confirm"]', { state: 'detached', timeout: 5000 });
}

async function paragraphText(page, sel) {
  return page.locator(sel).first().evaluate((el) => el.textContent || '');
}

/**
 * Wait until the SERVER reflects a suggestion status. The resolve endpoint
 * validates against the DB, so a same-session create→accept must let the
 * suggestion sync land first — exactly what a real cross-user flow guarantees
 * (the owner only ever acts on a server-served suggestion).
 *
 * expect.poll (NOT page.waitForFunction): an async predicate returns a Promise,
 * which waitForFunction treats as a truthy value and resolves on the first poll
 * without ever checking — expect.poll awaits the callback properly.
 */
async function waitServerStatus(page, book, hlId, expected) {
  await expect.poll(
    () => page.evaluate(async ([b, id]) => {
      try {
        const r = await fetch(`/api/db/hyperlights/find/${b}/${id}`, {
          credentials: 'include', headers: { Accept: 'application/json' },
        });
        if (!r.ok) return `http_${r.status}`;
        const j = await r.json();
        return j?.hyperlight?.suggestion_status ?? 'null';
      } catch { return 'err'; }
    }, [book, hlId]),
    { timeout: 25000, intervals: [400] },
  ).toBe(expected);
}

test.describe('suggested edit lifecycle', () => {
  test('create → suggest → accept/revert/like/reconsider/decline/reconsider', async ({ page, spa }) => {
    test.setTimeout(180_000);

    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    // ── Create a book with one paragraph of source text ──
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
    await page.keyboard.type('Suggested Edit Lifecycle');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('The library is wonderful for everyone everywhere.');
    await page.waitForTimeout(500);

    // ── Highlight the word "wonderful" ──
    const paraSel = await findParagraphByText(page, 'wonderful');
    expect(paraSel).not.toBeNull();
    const text = await page.locator(paraSel).textContent();
    const start = text.indexOf('wonderful');
    await spa.selectTextInElement(page, paraSel, start, start + 'wonderful'.length);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hyperlight');
    await waitContainerOpen(page);
    await page.waitForSelector('#hyperlit-container .highlight-annotation .sub-book-content', { timeout: 8000 });
    await spa.closeHyperlitContainer(page);
    await waitForCloudGreen(page);

    // Exit main edit mode — suggestions are reviewed in plain read mode.
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // ── Reopen the highlight; the ✎ "suggest an edit" offer is present ──
    await page.click('.main-content mark.user-highlight, .main-content mark.highlight');
    await waitContainerOpen(page);
    const hlId = await page.locator(`${HL_SEL}`).first().getAttribute('data-highlight-id');
    expect(hlId).toMatch(/^HL_/);
    await page.waitForSelector(`${HL_SEL} .suggest-edit-btn`, { timeout: 8000 });

    // ── Open the full-container editor, replace the text, Save ──
    await page.click(`${HL_SEL} .suggest-edit-btn`);
    await page.waitForFunction(
      () => document.querySelector('#hyperlit-container')?.classList.contains('suggestion-editing-mode'),
      null, { timeout: 5000 });
    await page.waitForSelector('#hyperlit-container textarea.suggestion-segment', { timeout: 5000 });
    await page.fill('#hyperlit-container textarea.suggestion-segment', 'spectacular');
    // Save lives in the bar pinned to the container bottom (not under the textarea).
    await page.click('#hyperlit-container .suggestion-editor-bar .suggestion-save');

    // ── Pending diff: before/after visible, owner gets Accept/Like/Decline ──
    await page.waitForSelector(`${HL_SEL}.suggestion-diff`, { timeout: 8000 });
    await page.waitForSelector(`${HL_SEL} [data-action="accept"]`, { timeout: 5000 });
    expect(await page.locator(`${HL_SEL} ins.se-add`).first().textContent()).toContain('spectacular');
    expect(await page.locator(`${HL_SEL} del.se-del`).first().textContent()).toContain('wonderful');
    await waitForCloudGreen(page);
    // The suggestion must be on the server before the owner can resolve it.
    await waitServerStatus(page, bookId, hlId, 'pending');

    // ── ACCEPT → the book's body text actually changes ──
    await page.click(`${HL_SEL} [data-action="accept"]`);
    await confirmDialog(page);
    await page.waitForSelector(`${HL_SEL} .suggestion-badge-accepted`, { timeout: 10000 });
    await page.waitForSelector(`${HL_SEL} .suggestion-revert`, { timeout: 5000 });
    await page.waitForFunction((s) => {
      const el = document.querySelector(s);
      return el && el.textContent.includes('spectacular') && !el.textContent.includes('wonderful');
    }, paraSel, { timeout: 10000 });
    expect(await paragraphText(page, paraSel)).toContain('spectacular');
    await waitForCloudGreen(page);

    // ── REVERT → the original text comes back, suggestion returns to pending ──
    await page.click(`${HL_SEL} .suggestion-revert`);
    await confirmDialog(page);
    await page.waitForSelector(`${HL_SEL} [data-action="accept"]`, { timeout: 10000 });
    await page.waitForFunction((s) => document.querySelector(s)?.textContent.includes('wonderful'),
      paraSel, { timeout: 10000 });
    expect(await paragraphText(page, paraSel)).toContain('wonderful');
    expect(await paragraphText(page, paraSel)).not.toContain('spectacular');
    await waitForCloudGreen(page);

    // ── LIKE → "Liked by the author" badge, no body change ──
    await page.click(`${HL_SEL} [data-action="liked"]`);
    await page.waitForSelector(`${HL_SEL} .suggestion-badge-liked`, { timeout: 8000 });
    expect(await page.locator(`${HL_SEL} .suggestion-badge-liked`).textContent()).toContain('author');
    expect(await paragraphText(page, paraSel)).toContain('wonderful'); // body untouched

    // ── RECONSIDER → back to pending ──
    await page.click(`${HL_SEL} .suggestion-reopen`);
    await page.waitForSelector(`${HL_SEL} [data-action="accept"]`, { timeout: 8000 });

    // ── DECLINE → "Edit declined" badge ──
    await page.click(`${HL_SEL} [data-action="rejected"]`);
    await page.waitForSelector(`${HL_SEL} .suggestion-badge-rejected`, { timeout: 8000 });
    expect(await paragraphText(page, paraSel)).toContain('wonderful');

    // ── RECONSIDER → back to pending, full cycle intact ──
    await page.click(`${HL_SEL} .suggestion-reopen`);
    await page.waitForSelector(`${HL_SEL} [data-action="accept"]`, { timeout: 8000 });

    // ── Survives a reload: the pending suggestion is still there with its diff.
    // The #HL_ deep-link hash auto-reopens the container on load; if it doesn't,
    // open from the mark (mark[class*="HL_"] — applyHighlights always stamps the
    // HL_id as a class). ──
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.main-content mark[class*="HL_"]', { timeout: 15000 });
    const autoOpened = await page.waitForFunction(
      () => document.getElementById('hyperlit-container')?.classList.contains('open'),
      null, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!autoOpened) {
      await page.click('.main-content mark[class*="HL_"]');
      await waitContainerOpen(page);
    }
    await page.waitForSelector(`${HL_SEL}.suggestion-diff`, { timeout: 8000 });
    expect(await page.locator(`${HL_SEL} ins.se-add`).first().textContent()).toContain('spectacular');

    // No splice/suggestion failures logged on any transition.
    const suggestionErrors = consoleErrors.filter((e) =>
      /suggest|splice|resolve failed/i.test(e));
    expect(suggestionErrors, `suggestion errors: ${suggestionErrors.join(' | ')}`).toHaveLength(0);
  });
});
