/**
 * Per-page-type "everything works here" verifiers.
 *
 * Each verifier is called like `verifyHomePage(page, spa)` and throws on
 * failure. They're designed to:
 *   - Be idempotent (running twice in a row doesn't leave state behind).
 *   - Exercise the actually-interactive components on that page, not just
 *     assert "the registry says we're active". A button can be in the
 *     registry yet have its listeners broken; these verifiers click/drop/type
 *     to surface that.
 *   - Be composed by spaTour.js for full SPA cycle testing.
 *
 * Used by:
 *   - specs/workflows/spa-grand-tour.spec.js (the grand tour)
 *   - Available for any future spec that needs page-level functional checks.
 */

import { expect } from '@playwright/test';
import {
  probeBookActionsMenu,
  probeDropListenerBalance,
} from './elementProbes.js';

/* ── synthetic file drop on window ────────────────────────────────────── */
/**
 * Dispatch a synthetic file drop on the window. Mirrors what an OS file drag
 * triggers — the same dataTransfer.types/files surface that our window listeners
 * read in fileDropTarget.js.
 */
export async function dropFileOnWindow(page, { name, type, content }) {
  await page.evaluate(({ name, type, content }) => {
    const dt = new DataTransfer();
    const file = new File([content], name, { type });
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { name, type, content });
}

/**
 * Close the newbook container (the import form) if it's open. No-op if not.
 *
 * Clear button only clears fields — it does NOT close the container or
 * dismiss `#source-overlay`. To actually dismiss we use the container
 * manager's `closeContainer()` exposed on `window.newBookManager`.
 */
async function closeImportFormIfOpen(page) {
  const isOpen = await page.evaluate(() => !!document.getElementById('cite-form'));
  if (!isOpen) return;
  await page.evaluate(() => {
    // 1. Close via manager (preferred — fires the full close lifecycle).
    if (window.newBookManager && typeof window.newBookManager.closeContainer === 'function') {
      window.newBookManager.closeContainer();
    }
    // 2. Belt + braces: directly clear `.active` from the source-overlay so it
    //    stops intercepting pointer events immediately. The container's CSS
    //    transition can otherwise leave the overlay "active" while the
    //    container animates out — long enough to block our next click.
    const overlay = document.getElementById('source-overlay');
    if (overlay) overlay.classList.remove('active');
    // 3. Clear persisted form fields too (so re-opening on the next verifier
    //    iteration starts blank — pure hygiene, not strictly required).
    try { localStorage.removeItem('formData'); localStorage.removeItem('newbook-form-data'); } catch (_) {}
  });
  // Wait briefly for any open-class animation to settle.
  try {
    await page.waitForFunction(() => {
      const o = document.getElementById('source-overlay');
      return !o || !o.classList.contains('active');
    }, null, { timeout: 2000 });
  } catch { /* fall through — direct-clear above should have done it */ }
}

/* ── verifyHomePage ───────────────────────────────────────────────────── */
/**
 * Run every interactive check that applies to a fresh home page.
 * Page should already be at `/` and SPA-loaded.
 */
export async function verifyHomePage(page, spa) {
  const _consoleSnapshot = spa.filterConsoleErrors(page.consoleErrors).length;
  // Baseline: structure + registry + console
  expect(await spa.getStructure(page)).toBe('home');
  await spa.assertRegistryHealthy(page, 'home');

  // Lava-lamp background is actually rendered AND animating (rAF running), not
  // dead HTML. This is the "cooked when returning" guard: verifyHomePage runs at
  // EVERY home landing in the grand tour — including the back-button/forward
  // replay phases — so a blank mount after SPA re-entry fails here.
  const lavaPath = page.locator('.lava-lamp-bg path').first();
  await expect(lavaPath).toBeAttached();
  const lavaD1 = await lavaPath.getAttribute('d');
  await page.waitForTimeout(1500);
  const lavaD2 = await lavaPath.getAttribute('d');
  expect(lavaD2, 'lava-lamp background is not animating (rAF dead / stale singleton after SPA return)').not.toBe(lavaD1);

  // Drop overlay element exists and is hidden by default
  const overlayState = await page.evaluate(() => {
    const el = document.getElementById('page-drop-overlay');
    return el ? { exists: true, display: window.getComputedStyle(el).display } : { exists: false };
  });
  expect(overlayState.exists).toBe(true);
  expect(overlayState.display).toBe('none');

  // Synthetic file drop opens the import form with the file pre-attached
  await dropFileOnWindow(page, {
    name: 'tour-home.md',
    type: 'text/markdown',
    content: '# Tour drop on home\n\nE2E grand tour synthetic drop.',
  });
  await page.waitForSelector('#cite-form', { timeout: 5000 });
  const homeFileName = await page.evaluate(() => {
    const i = document.getElementById('markdown_file');
    return i && i.files && i.files[0] ? i.files[0].name : null;
  });
  expect(homeFileName).toBe('tour-home.md');

  // Clean up — close the form so subsequent verifications start fresh
  await closeImportFormIfOpen(page);

  // Search input accepts text + clears cleanly
  const searchInput = page.locator('#homepage-search-input');
  if (await searchInput.count()) {
    await searchInput.fill('a');
    await page.waitForTimeout(200);
    await searchInput.fill('');
  }

  // Arranger tabs switch (Most Recent ↔ Most Connected ↔ Most Lit).
  // Switching tabs briefly shows a navigation overlay; wait for it to clear
  // before we run the SPA health check below.
  const connectedTab = page.locator('.arranger-button[data-content="most-connected"]');
  if (await connectedTab.count()) {
    await connectedTab.click();
    await waitForNavigationOverlayClear(page);
    await page.click('.arranger-button[data-content="most-recent"]');
    await waitForNavigationOverlayClear(page);
  }

  // Drop overlay still hidden at the end
  const overlayStillHidden = await page.evaluate(() => {
    const el = document.getElementById('page-drop-overlay');
    return el && window.getComputedStyle(el).display === 'none';
  });
  expect(overlayStillHidden).toBe(true);

  // Post-nav interactive probes: .book-actions menu still wired, and the
  // window drop listeners are bound with exactly one overlay (no leak).
  await probeBookActionsMenu(page, spa, { expectPage: 'home', clickPreview: false });
  await probeDropListenerBalance(page);

  spa.assertHealthy(await spa.healthCheck(page));
  // Check only NEW console errors since this verifier was called — the
  // `consoleErrors` array on the fixture accumulates across the whole test,
  // so asserting length === 0 fails on the second tour lap if anything ever
  // logged an error in lap 1, even when this verifier added nothing new.
  const newErrors = spa.filterConsoleErrors(page.consoleErrors).slice(_consoleSnapshot);
  if (newErrors.length > 0) {
    throw new Error(`New console errors during verifier:\n${newErrors.join('\n---\n')}`);
  }
}

/**
 * Wait for every `.navigation-overlay` element to become hidden (display:none
 * or visibility:hidden). The SPA shows these during transitions / content
 * reloads, and they intermittently linger long enough to trip `healthCheck`.
 */
async function waitForNavigationOverlayClear(page, timeoutMs = 3000) {
  try {
    await page.waitForFunction(() => {
      const els = document.querySelectorAll('.navigation-overlay');
      for (const el of els) {
        const s = window.getComputedStyle(el);
        if (s.display !== 'none' && s.visibility !== 'hidden') return false;
      }
      return true;
    }, null, { timeout: timeoutMs });
  } catch {
    // Continue anyway — healthCheck will surface a real lingering overlay.
  }
}

/* ── verifyUserPage ───────────────────────────────────────────────────── */
export async function verifyUserPage(page, spa) {
  const _consoleSnapshot = spa.filterConsoleErrors(page.consoleErrors).length;
  expect(await spa.getStructure(page)).toBe('user');
  await spa.assertRegistryHealthy(page, 'user');

  // Drop overlay should exist on user pages too (registered for both home + user)
  expect(await page.evaluate(() => !!document.getElementById('page-drop-overlay'))).toBe(true);

  // Synthetic drop on the user page — same flow as home
  await dropFileOnWindow(page, {
    name: 'tour-user.md',
    type: 'text/markdown',
    content: '# Tour drop on user\n\nE2E grand tour synthetic drop.',
  });
  await page.waitForSelector('#cite-form', { timeout: 5000 });
  const userFileName = await page.evaluate(() => {
    const i = document.getElementById('markdown_file');
    return i && i.files && i.files[0] ? i.files[0].name : null;
  });
  expect(userFileName).toBe('tour-user.md');
  await closeImportFormIfOpen(page);

  // Tabs (Library / Account) exist
  const tabCount = await page.locator('.arranger-button').count();
  expect(tabCount).toBeGreaterThanOrEqual(2);

  // Post-nav interactive probes: .book-actions menu still wired (user-page
  // handler this time), plus drop listener balance.
  await probeBookActionsMenu(page, spa, { expectPage: 'user', clickPreview: false });
  await probeDropListenerBalance(page);

  spa.assertHealthy(await spa.healthCheck(page));
  // Check only NEW console errors since this verifier was called — the
  // `consoleErrors` array on the fixture accumulates across the whole test,
  // so asserting length === 0 fails on the second tour lap if anything ever
  // logged an error in lap 1, even when this verifier added nothing new.
  const newErrors = spa.filterConsoleErrors(page.consoleErrors).slice(_consoleSnapshot);
  if (newErrors.length > 0) {
    throw new Error(`New console errors during verifier:\n${newErrors.join('\n---\n')}`);
  }
}

/* ── verifyReaderPage ─────────────────────────────────────────────────── */
export async function verifyReaderPage(page, spa) {
  const _consoleSnapshot = spa.filterConsoleErrors(page.consoleErrors).length;
  expect(await spa.getStructure(page)).toBe('reader');
  await spa.assertRegistryHealthy(page, 'reader');

  // Drop target must NOT be active on reader (registry exclusion)
  const registry = await spa.getRegistryStatus(page);
  expect(registry?.activeComponents || []).not.toContain('fileDropTarget');
  // No overlay element either
  expect(await page.evaluate(() => !!document.getElementById('page-drop-overlay'))).toBe(false);

  // Edit mode toggles cleanly — but ONLY on books this user can edit. The
  // tour can legitimately land on a read-only / locked book (e.g. another
  // user's book reached via a card or a book-to-book hypercite), where
  // #editButton is hidden/locked. That's a valid reader state, so skip the
  // toggle there rather than failing.
  //
  // The lock verdict is ASYNC (canUserEditBook: IDB read + a server
  // confirmation on the can't-edit path) — probing before it settles races
  // the lock swap and a click can hit a button that locks mid-click. Wait for
  // the settled marker lock.ts sets after the check completes; fall through
  // on timeout (e.g. button absent) and let the probe decide as before.
  await page.waitForFunction(
    () => document.getElementById('editButton')?.getAttribute('data-edit-perm-checked') === 'true',
    null, { timeout: 10_000 },
  ).catch(() => {});
  const editable = await page.evaluate(() => {
    const b = document.getElementById('editButton');
    if (!b) return false;
    if (b.getAttribute('data-is-locked') === 'true' || b.classList.contains('locked-state')) return false;
    return window.getComputedStyle(b).display !== 'none' && b.offsetParent !== null;
  });
  if (editable) {
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5000 });
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
  }

  // Logo nav menu exposes the new-book + button on reader pages.
  // The button is registered + present in the menu, hidden until the user
  // taps the logo. Open the menu, verify the + is visible, then close it
  // via a second tap on the logo.
  expect(await page.locator('#newBookButton').count()).toBe(1);
  expect(await page.evaluate(() => !!document.getElementById('newBookButton')?.closest('#logoNavMenu'))).toBe(true);
  await expect(page.locator('#newBookButton')).toBeHidden();
  await page.click('#logoContainer');
  await page.waitForSelector('#logoNavMenu:not(.hidden)', { timeout: 3000 });
  await expect(page.locator('#newBookButton')).toBeVisible();
  await page.click('#logoContainer');
  await page.waitForSelector('#logoNavMenu.hidden', { timeout: 3000 });

  // TOC button click — just verify it doesn't throw or break the page.
  // (Some books have no TOC content, so we don't strictly assert a panel opened.)
  const tocEl = page.locator('#toc');
  if (await tocEl.count() && await tocEl.isVisible().catch(() => false)) {
    await tocEl.click();
    await page.waitForTimeout(200);
    // Close it (Escape, or click again if it stayed open)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }

  // Settings button — open then close
  const settingsBtn = page.locator('#settingsButton');
  if (await settingsBtn.count() && await settingsBtn.isVisible().catch(() => false)) {
    await settingsBtn.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }

  // In-text search button — open then close
  const searchBtn = page.locator('#searchButton');
  if (await searchBtn.count() && await searchBtn.isVisible().catch(() => false)) {
    await searchBtn.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }

  // NOTE: the resize-handle probe is intentionally NOT run here. It opens a
  // hyperlit-container (footnote/hypercite), whose history/overlay residue
  // varies per book and can wedge the next logo-nav click — too fragile for
  // the generic tour, which lands on arbitrary books. Resize-after-SPA-nav is
  // covered against the controlled E2E_READER_BOOK by the dedicated grand-tour
  // phase ('resize handle survives SPA nav') and by post-nav-buttons.spec.js.

  spa.assertHealthy(await spa.healthCheck(page));
  // Check only NEW console errors since this verifier was called — the
  // `consoleErrors` array on the fixture accumulates across the whole test,
  // so asserting length === 0 fails on the second tour lap if anything ever
  // logged an error in lap 1, even when this verifier added nothing new.
  const newErrors = spa.filterConsoleErrors(page.consoleErrors).slice(_consoleSnapshot);
  if (newErrors.length > 0) {
    throw new Error(`New console errors during verifier:\n${newErrors.join('\n---\n')}`);
  }
}

/* ── Authoring helpers (heavyweight — used in deep-lap phase only) ────── */

/**
 * Move the cursor to the end of the very last block element in document order.
 * Lifted from authoring-workflow.spec.js so the grand tour can reuse it.
 */
export async function moveCursorToEnd(page) {
  await page.evaluate(() => {
    const blocks = document.querySelectorAll('.main-content p, .main-content h1, .main-content h2, .main-content h3, .main-content h4, .main-content h5, .main-content h6, .main-content li, .main-content blockquote, .main-content pre');
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock) return;
    const range = document.createRange();
    range.selectNodeContents(lastBlock);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    lastBlock.focus();
  });
}

/**
 * Find a paragraph/block by its text content and return a CSS selector for it.
 * Lifted from authoring-workflow.spec.js.
 */
export async function findParagraphByText(page, searchText) {
  return page.evaluate((text) => {
    const blocks = document.querySelectorAll('.main-content p, .main-content h1, .main-content h2, .main-content h3, .main-content h4, .main-content h5, .main-content h6, .main-content li, .main-content blockquote');
    for (const el of blocks) {
      if (el.textContent.includes(text)) {
        if (el.id) return `${el.tagName.toLowerCase()}[id="${el.id}"]`;
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        const siblings = parent.querySelectorAll(`:scope > ${tag}`);
        const idx = Array.from(siblings).indexOf(el);
        return `.main-content ${tag}:nth-of-type(${idx + 1})`;
      }
    }
    return null;
  }, searchText);
}

/**
 * Wait for cloud-sync indicator to go green, with a fallback timeout.
 * Lifted from authoring-workflow.spec.js.
 */
export async function waitForCloudGreen(page, fallbackMs = 3000) {
  try {
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 5000 });
  } catch {
    await page.waitForTimeout(fallbackMs);
  }
}
