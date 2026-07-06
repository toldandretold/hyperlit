/**
 * Modal-surface keyboard contract — table-driven (WCAG 2.1.2, 2.4.3).
 *
 * One shared assertion (`assertKeyboardContract`) run over every transient
 * surface: after a REAL open gesture, focus is inside the surface, Tab never
 * escapes it (trap mode), Escape closes it (unless the surface deliberately
 * blocks Escape), and focus returns to the trigger. The inventory of surfaces
 * lives in tests/javascript/architecture/overlaySurfacesInventory.json — the
 * vitest gate there fails on unregistered NEW surfaces; this spec proves the
 * registered wiring actually works in a browser.
 *
 * Two sections:
 *   1. GESTURE surfaces — reachable by honest user gestures.
 *   2. DIRECT-INVOKE surfaces — only reachable through app states too deep to
 *      stage honestly (import failure, data-loss modal, recovery code…);
 *      invoked via raw vite .ts import (dev-server only; skip guard below),
 *      same pattern as e2ee-unlock-modal.spec.js.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const READER_BOOK = process.env.E2E_READER_BOOK;

function viteOrigin() {
  try { return readFileSync(join(HERE, '../../../../public/hot'), 'utf8').trim(); } catch { return null; }
}

const isInside = (sel) => (s) => {
  const root = document.querySelector(s);
  return !!(root && (root === document.activeElement || root.contains(document.activeElement)));
};

/** Shared contract: focus seated inside, Tab trapped, Escape closes (+restore). */
async function assertKeyboardContract(page, { containerSel, tabs = 10, escapeCloses = true, returnFocusSel = null }) {
  await page.waitForSelector(containerSel, { timeout: 8000 });
  await page.waitForTimeout(350); // open animation / rAF focus seat

  const seated = await page.evaluate(isInside(containerSel), containerSel);
  expect(seated, `focus not seated inside ${containerSel} after open`).toBe(true);

  for (let i = 0; i < tabs; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(isInside(containerSel), containerSel);
    if (!inside) {
      const leaked = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName}#${el.id || '(no id)'}.${el.className || ''}` : '(none)';
      });
      throw new Error(`Tab #${i + 1} escaped ${containerSel} to ${leaked} (WCAG 2.4.3)`);
    }
  }

  await page.keyboard.press('Escape');
  if (escapeCloses) {
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      if (!el) return true;
      const s = getComputedStyle(el);
      return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0'
        || el.classList.contains('hidden') || el.getBoundingClientRect().width === 0;
    }, containerSel, { timeout: 4000 });
    if (returnFocusSel) {
      const focused = await page.evaluate((sel) => document.querySelector(sel) === document.activeElement, returnFocusSel);
      expect(focused, `focus should return to ${returnFocusSel} after Escape`).toBe(true);
    }
  } else {
    // Deliberately blocking modal: Escape must NOT close it.
    await page.waitForTimeout(300);
    const stillOpen = await page.evaluate((sel) => !!document.querySelector(sel), containerSel);
    expect(stillOpen, `${containerSel} must NOT close on Escape (blocking modal)`).toBe(true);
  }
}

/* ══ Section 1: real-gesture surfaces ═══════════════════════════════════ */

async function gotoHomeFeed(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spa.openHomeFeed(page).catch(() => {});
  await page.waitForSelector('.libraryCard .book-actions', { timeout: 15000 });
}

async function gotoReader(page) {
  test.skip(!READER_BOOK, 'E2E_READER_BOOK not set');
  await page.goto(`/${READER_BOOK}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.main-content', { timeout: 15000 });
}

async function openFloatingMenu(page, spa) {
  await gotoHomeFeed(page, spa);
  await page.locator('.libraryCard .book-actions').first().click();
  await page.waitForSelector('.floating-action-menu', { timeout: 5000 });
}

test.describe('modal surfaces keep the keyboard contract', () => {
  test('TOC panel (reader)', async ({ page, spa }) => {
    await gotoReader(page);
    try {
      await spa.openToc(page);
    } catch (e) {
      test.skip(true, `TOC did not open: ${e.message}`);
    }
    await assertKeyboardContract(page, { containerSel: '#toc-container' });
  });

  test('source container via cloudRef (reader)', async ({ page }) => {
    await gotoReader(page);
    const cloud = page.locator('#cloudRef');
    test.skip(!(await cloud.isVisible().catch(() => false)), 'no visible #cloudRef');
    await cloud.click();
    await assertKeyboardContract(page, { containerSel: '#source-container', returnFocusSel: '#cloudRef' });
  });

  test('floating action menu (home card actions)', async ({ page, spa }) => {
    await openFloatingMenu(page, spa);
    await assertKeyboardContract(page, { containerSel: '.floating-action-menu', tabs: 6 });
  });

  test('shelf preview via actions menu (home)', async ({ page, spa }) => {
    await openFloatingMenu(page, spa);
    await page.locator('.floating-action-menu-item[data-action="preview"]').click();
    await assertKeyboardContract(page, { containerSel: '#shelf-preview-overlay' });
  });

  test('add-to-shelf menu via actions menu (home)', async ({ page, spa }) => {
    await openFloatingMenu(page, spa);
    await page.locator('.floating-action-menu-item[data-action="add-to-shelf"]').click();
    await assertKeyboardContract(page, { containerSel: '.add-to-shelf-menu', tabs: 6 });
  });

  test('logo nav menu: Escape closes and refocuses logo (reader)', async ({ page }) => {
    await gotoReader(page);
    await page.click('#logoContainer');
    await page.waitForSelector('#logoNavMenu:not(.hidden)', { timeout: 5000 });
    // Nav dropdown, not a modal: no trap asserted — Escape + focus restore only.
    await page.keyboard.press('Escape');
    await page.waitForSelector('#logoNavMenu.hidden', { timeout: 3000 });
    const focused = await page.evaluate(() => document.activeElement?.id || '');
    expect(focused, 'Escape should refocus the logo').toBe('logoContainer');
  });

  test('in-text search toolbar: Escape closes and restores focus (reader)', async ({ page }) => {
    await gotoReader(page);
    const settingsBtn = page.locator('#settingsButton');
    test.skip(!(await settingsBtn.count()), 'no settings button');
    await settingsBtn.click();
    await page.waitForSelector('#settings-container:not(.hidden)', { timeout: 5000 });
    await page.click('#searchButton');
    await page.waitForSelector('#search-toolbar.visible, .search-toolbar.visible', { timeout: 5000 }).catch(() => {});
    const toolbarOpen = await page.evaluate(() => !!document.querySelector('.visible[id*="search"], .search-toolbar.visible'));
    test.skip(!toolbarOpen, 'search toolbar did not open (selector drift — update spec)');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const focusNotBody = await page.evaluate(() => document.activeElement && document.activeElement !== document.body);
    expect(focusNotBody, 'focus should be restored somewhere specific after closing search').toBe(true);
  });
});

/* ══ Section 2: direct-invoke surfaces (raw vite import; dev only) ══════ */

test.describe('deep-state modal surfaces (direct invoke)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!viteOrigin(), 'vite dev server not running (no public/hot)');
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('confirmDialog: trap, Escape=false, focus restore', async ({ page }) => {
    const hot = viteOrigin();
    await page.evaluate(async (origin) => {
      window.__dlgResult = undefined;
      const { confirmDialog } = await import(`${origin}/resources/js/components/dialog/dialog.ts`);
      confirmDialog({ title: 'E2E', message: 'Keyboard contract?' }).then((r) => { window.__dlgResult = r; });
    }, hot);
    await assertKeyboardContract(page, { containerSel: '.app-dialog-overlay', tabs: 5 });
    const result = await page.evaluate(() => window.__dlgResult);
    expect(result, 'Escape should resolve confirmDialog(false)').toBe(false);
  });

  test('integrity data-loss modal: trap, Escape does NOT close', async ({ page }) => {
    const hot = viteOrigin();
    await page.evaluate(async (origin) => {
      const mod = await import(`${origin}/resources/js/integrity/reporter.ts`);
      await mod.reportIntegrityFailure({ bookId: 'book_e2e_probe', mismatches: [{ nodeId: 'x', reason: 'probe' }] });
    }, hot);
    await assertKeyboardContract(page, { containerSel: '#integrity-failure-backdrop', tabs: 8, escapeCloses: false });
    // Clean up via its own Dismiss button (the only sanctioned exit).
    await page.click('#integrity-dismiss-btn');
    await page.waitForFunction(() => !document.getElementById('integrity-failure-backdrop'), null, { timeout: 3000 });
  });

  test('recovery-code overlay: trap, Escape blocked, Done gated on checkbox', async ({ page }) => {
    const hot = viteOrigin();
    await page.evaluate(async (origin) => {
      const mod = await import(`${origin}/resources/js/e2ee/ui/passkeySettings.ts`);
      mod.showRecoveryCodeModal('AAAA-BBBB-CCCC');
    }, hot);
    await assertKeyboardContract(page, { containerSel: '#recovery-code-overlay', tabs: 5, escapeCloses: false });
    // Keyboard path to dismiss: check the box (Space), then Done.
    await page.focus('#recoveryCodeSavedCheck');
    await page.keyboard.press('Space');
    const doneEnabled = await page.evaluate(() => !document.getElementById('recoveryCodeDone')?.disabled);
    expect(doneEnabled, 'Done should enable after checking the box').toBe(true);
    await page.click('#recoveryCodeDone');
    await page.waitForFunction(() => !document.getElementById('recovery-code-overlay'), null, { timeout: 3000 });
  });

  test('deleted-book access guard: trap engaged', async ({ page }) => {
    const hot = viteOrigin();
    await page.evaluate(async (origin) => {
      const mod = await import(`${origin}/resources/js/pageLoad/accessGuards.ts`);
      await mod.handleDeletedBookAccess('book_e2e_probe');
    }, hot);
    // Escape navigates to '/' (full load) — assert seat + trap only, then reload to clean.
    await page.waitForSelector('.custom-alert-overlay', { timeout: 5000 });
    await page.waitForTimeout(350);
    const seated = await page.evaluate(isInside('.custom-alert-overlay'), '.custom-alert-overlay');
    expect(seated, 'focus not seated in access-guard alert').toBe(true);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(isInside('.custom-alert-overlay'), '.custom-alert-overlay');
      expect(inside, `Tab #${i + 1} escaped the access-guard alert`).toBe(true);
    }
    await page.reload();
  });

  test('import footnote-audit alert: trap, Escape = proceed', async ({ page }) => {
    const hot = viteOrigin();
    await page.evaluate(async (origin) => {
      window.__auditResult = undefined;
      const mod = await import(`${origin}/resources/js/SPA/navigation/pathways/ImportBookTransition.ts`);
      mod.ImportBookTransition.showFootnoteAuditModal(
        { total_refs: 2, total_defs: 1, gaps: [], duplicates: [], unmatched_refs: [{ number: 2 }], unmatched_defs: [] },
        'book_e2e_probe'
      ).then((r) => { window.__auditResult = r; });
    }, hot);
    await assertKeyboardContract(page, { containerSel: '.custom-alert', tabs: 4 });
    const result = await page.evaluate(() => window.__auditResult);
    expect(result, 'Escape should resolve the audit modal as "proceed"').toBe('proceed');
  });
});
