/**
 * Citation modal — mobile viewport regressions.
 *
 * Two bugs the user kept hitting:
 *   1. On mobile, opening the modal showed the chips behind / cut off by the
 *      bottom of the viewport — `keyboardManager.moveToolbarAboveKeyboard`
 *      was forcing the panel to `height: 0px` when `data-state="hidden"`
 *      using the old pre-rewrite height table.
 *   2. Tapping Shelf without a keyboard up did not surface the picker —
 *      same root cause, panel collapsed to nothing.
 *
 * These tests use Playwright's viewport emulation (iPhone-sized) to verify
 * the chip bar and the shelf picker are actually visible (inside the
 * viewport rect) after each interaction.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  findCitableParagraph,
  openCitationModal,
  setCitationScope,
} from '../../helpers/citationModal.js';

const READER_BOOK = process.env.E2E_READER_BOOK || 'book_1777271888985';

// iPhone 13 viewport — narrow enough to trigger mobile CSS and the panel
// positioning code path used on phones.
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
});

test.describe('Citation modal — mobile viewport', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/${READER_BOOK}`);
    await page.evaluate(() => {
      try {
        localStorage.removeItem('hyperlit:citation:scope');
        localStorage.removeItem('hyperlit:citation:shelfId');
      } catch {}
    });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('.main-content', { timeout: 20_000 });

    const sel = await findCitableParagraph(page, 40);
    if (!sel) test.skip(true, 'no citable paragraph in test book');
    await openCitationModal(page, sel, 10);
  });

  test('chip bar is inside the visible viewport rect', async ({ page }) => {
    const viewport = page.viewportSize();
    const chipBarBox = await page.locator('.citation-scope-bar').boundingBox();

    expect(chipBarBox).not.toBeNull();
    // Must be within the visible viewport (not pushed off-screen by panel
    // collapse). Top edge must be ≥ 0; bottom edge must be ≤ viewport height.
    expect(chipBarBox.y).toBeGreaterThanOrEqual(0);
    expect(chipBarBox.y + chipBarBox.height).toBeLessThanOrEqual(viewport.height);
    // Bar height must reflect the 38px CSS — was 0 in the bug.
    expect(chipBarBox.height).toBeGreaterThan(20);
  });

  test('panel itself has non-zero rendered height on mobile open', async ({ page }) => {
    const panelBox = await page.locator('#citation-toolbar-results').boundingBox();
    expect(panelBox).not.toBeNull();
    // Was collapsing to height: 0 via the stale keyboard-manager rule.
    expect(panelBox.height).toBeGreaterThan(30);
  });

  test('tapping Shelf without keyboard reveals the picker inside the panel', async ({ page }) => {
    // Make sure shelf picker is currently hidden before the tap
    await expect(page.locator('.citation-shelf-picker')).toBeHidden();

    await setCitationScope(page, 'shelf');

    // Picker must become visible AND have non-zero height (was rendering
    // inside a collapsed-to-0 panel before the fix).
    await expect(page.locator('.citation-shelf-picker')).toBeVisible();
    const pickerBox = await page.locator('.citation-shelf-picker').boundingBox();
    expect(pickerBox).not.toBeNull();
    expect(pickerBox.height).toBeGreaterThan(15);

    // Picker must also sit within the visible viewport — not below it
    const viewport = page.viewportSize();
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(viewport.height);
  });

  test('REAL touch on Shelf chip fires the scope change (no preventDefault eating the click)', async ({ page }) => {
    // Bug regression: handleResultsScroll preventDefault'd every touchstart
    // inside the panel when it wasn't overflowing, swallowing the synthesized
    // click on the chip. Using page.tap() (real touch sequence) instead of
    // page.click() catches that — click() injects a synthetic click event
    // directly and bypasses the touchstart-preventDefault path.
    const chip = page.locator('.citation-scope-btn[data-scope="shelf"]');
    await expect(chip).toBeVisible();
    await chip.tap();

    // If the tap actually reached the click handler, the chip is now active
    // AND the shelf picker is visible.
    await expect(chip).toHaveClass(/active/);
    await expect(page.locator('.citation-shelf-picker')).toBeVisible();
  });

  test('tapping the shelf TRIGGER does NOT blur the input (keyboard stays up) — custom dropdown contract', async ({ page }) => {
    // This is the user-facing guarantee that the native <select> was breaking:
    // tapping the shelf dropdown must keep the input focused so iOS keyboard
    // stays up. Now that the dropdown is a custom <button>, mousedown.preventDefault
    // keeps focus on the input the same way the scope chips do.
    await page.evaluate(() => {
      document.getElementById('edit-toolbar')?.classList.add('visible');
      document.getElementById('citation-search-input')?.focus();
    });
    await page.waitForFunction(() => document.activeElement?.id === 'citation-search-input', null, { timeout: 2000 });

    // Open the shelf picker
    await setCitationScope(page, 'shelf');
    await expect(page.locator('.citation-shelf-trigger')).toBeVisible();

    // Refocus the input (setCitationScope may have moved focus)
    await page.evaluate(() => document.getElementById('citation-search-input')?.focus());
    await page.waitForFunction(() => document.activeElement?.id === 'citation-search-input', null, { timeout: 2000 });

    // REAL touch on the custom dropdown trigger
    await page.locator('.citation-shelf-trigger').tap();

    // Input must STILL be the active element. With the native <select> this
    // assertion always failed on iOS — the picker opening blurred the input.
    // With the custom <button>-based dropdown + mousedown.preventDefault, it
    // stays put.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('citation-search-input');

    // And the dropdown popup opened
    await expect(page.locator('.citation-shelf-options')).toBeVisible();
  });

  test('tapping a chip does NOT blur the search input (keyboard stays up)', async ({ page }) => {
    // The edit-toolbar has `visibility: hidden` by default — the `.visible`
    // class is added by EditToolbar's selection logic which doesn't fire
    // reliably under Playwright's synthetic touch. Force the class so the
    // input is actually focusable for this assertion.
    await page.evaluate(() => {
      document.getElementById('edit-toolbar')?.classList.add('visible');
      document.getElementById('citation-search-input')?.focus();
    });
    await page.waitForFunction(() => document.activeElement?.id === 'citation-search-input', null, { timeout: 2000 });

    // Tap Mine via real touch sequence
    await page.locator('.citation-scope-btn[data-scope="mine"]').tap();

    // After the chip tap the input must STILL be the active element.
    // If it isn't, the chip stole focus — on real mobile that dismisses the
    // on-screen keyboard, which was the user's complaint.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('citation-search-input');

    // And the click side-effect (scope change) still happened.
    await expect(page.locator('.citation-scope-btn[data-scope="mine"]')).toHaveClass(/active/);
  });

  test.skip('DIAGNOSTIC: simulate the EXACT iOS event sequence (picker open + dismiss with target=body)', async ({ page }) => {
    // iOS Safari quirk: when the native <select> picker dismisses, Safari
    // dispatches a synthetic click event back to the page whose target is
    // somewhere OUTSIDE the picker — often body / html / the page background.
    // That click hits handleDocumentClick which (without our guards) treats
    // it as an outside-tap and closes citation mode.
    //
    // Playwright/Chromium can't open the iOS picker, but we CAN simulate the
    // dismissal sequence event-for-event and verify every defense layer.

    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    await setCitationScope(page, 'shelf');
    await expect(page.locator('.citation-shelf-picker')).toBeVisible();
    await page.waitForTimeout(200);

    // Spy on close()
    await page.evaluate(() => {
      const tb = document.getElementById('edit-toolbar');
      const mode = tb?._editToolbarInstance?.citationMode || window.__citationModeForTest;
      if (!mode) { window.__noModeFound = true; return; }
      window.__closeCalls = [];
      const orig = mode.close.bind(mode);
      mode.close = function () {
        window.__closeCalls.push(new Error().stack);
        return orig();
      };
      window.__citationModeForTest = mode;
    });

    // Step 1: focus input (this is what keeps keyboard up on real mobile)
    await page.locator('#citation-search-input').focus();

    // Step 2: simulate iOS opening + immediately dismissing the select picker
    // by firing the synthetic events Safari would dispatch.
    await page.evaluate(() => {
      const select = document.querySelector('.citation-shelf-select');
      // Fire touch events on the select (iOS Safari dispatches these synchronously)
      select.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      select.dispatchEvent(new Event('touchstart', { bubbles: true }));
      select.focus();
      select.dispatchEvent(new Event('touchend', { bubbles: true }));
      // Native picker would open here; simulate dismissal by dispatching the
      // bad-target click that iOS Safari sends after the picker closes.
      select.blur();
      // The synthetic outside-click iOS dispatches when the picker dismisses:
      const badClick = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(badClick);
    });

    await page.waitForTimeout(100);

    const closeWasCalled = await page.evaluate(() => (window.__closeCalls || []).length);
    const stillOpen = await page.evaluate(() =>
      !document.getElementById('citation-mode-container')?.classList.contains('hidden')
    );
    const closeStacks = await page.evaluate(() => window.__closeCalls || []);

    console.log('\n----- DIAGNOSTIC RESULT -----');
    console.log('close() called', closeWasCalled, 'times');
    if (closeStacks.length) {
      console.log('Close stacks:');
      closeStacks.forEach((s, i) => console.log(`  ${i + 1}: ${s.split('\n')[1]?.trim()}`));
    }
    console.log('citation-mode-container still visible:', stillOpen);
    console.log('----- Console log tail (last 20) -----');
    logs.slice(-20).forEach(l => console.log('  ', l));
    console.log('----- END DIAGNOSTIC -----\n');

    // The modal must survive the synthetic iOS picker-dismissal click
    expect(closeWasCalled).toBe(0);
    expect(stillOpen).toBe(true);
  });

  test.skip('DIAGNOSTIC: keyboard-open scenario — shelf focus must keep citation mode open AND not trigger keyboard layout reset', async ({ page }) => {
    // Closer to the real iOS path: input is focused (keyboard "up"),
    // user taps the shelf select. iOS will fire focusout on the input.
    // keyboardManager.handleFocusOut sees relatedTarget=SELECT which is NOT
    // in the {INPUT, TEXTAREA, contenteditable} allowlist — so it considers
    // the keyboard closed and runs adjustLayout(false), which strips the
    // inline styles holding the citation panel above the keyboard. On iOS
    // this MAY drop the panel below the visible viewport (where the keyboard
    // used to sit) and make it appear "closed" even though it's still in
    // the DOM.

    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    await setCitationScope(page, 'shelf');
    await expect(page.locator('.citation-shelf-picker')).toBeVisible();

    // Simulate "keyboard is open" state on the KeyboardManager
    await page.evaluate(() => {
      if (window.activeKeyboardManager) {
        window.activeKeyboardManager.isKeyboardOpen = true;
        window.activeKeyboardManager.state.focusedElement = document.getElementById('citation-search-input');
      }
    });

    await page.locator('#citation-search-input').focus();

    // Spy on close + adjustLayout
    await page.evaluate(() => {
      const tb = document.getElementById('edit-toolbar');
      const mode = tb?._editToolbarInstance?.citationMode || window.__citationModeForTest;
      if (mode) {
        window.__closeCalls = 0;
        const orig = mode.close.bind(mode);
        mode.close = function () { window.__closeCalls++; return orig(); };
        window.__citationModeForTest = mode;
      }
      if (window.activeKeyboardManager) {
        window.__adjustLayoutCalls = [];
        const origAdj = window.activeKeyboardManager.adjustLayout.bind(window.activeKeyboardManager);
        window.activeKeyboardManager.adjustLayout = function (open, ...rest) {
          window.__adjustLayoutCalls.push({ open, at: Date.now() });
          return origAdj(open, ...rest);
        };
      }
    });

    // Now focus the SELECT (simulating the tap → focus shift iOS does)
    await page.evaluate(() => {
      document.querySelector('.citation-shelf-select').focus();
    });
    await page.waitForTimeout(200);   // give handleFocusOut deferred-close timer time

    const diag = await page.evaluate(() => ({
      closeCalls: window.__closeCalls || 0,
      adjustLayoutCalls: window.__adjustLayoutCalls || [],
      containerHidden: document.getElementById('citation-mode-container')?.classList.contains('hidden'),
      activeElement: document.activeElement?.tagName + '#' + (document.activeElement?.id || '?'),
      panelTop: getComputedStyle(document.getElementById('citation-toolbar-results')).top,
      panelBottom: getComputedStyle(document.getElementById('citation-toolbar-results')).bottom,
    }));

    console.log('\n----- KEYBOARD-OPEN DIAGNOSTIC -----');
    console.log(JSON.stringify(diag, null, 2));
    console.log('Console tail:');
    logs.slice(-15).forEach(l => console.log('  ', l));
    console.log('----- END -----\n');

    // Core assertion: citation mode must NOT close even when the keyboard
    // manager runs its close-keyboard cascade.
    expect(diag.closeCalls).toBe(0);
    expect(diag.containerHidden).toBe(false);
  });

  test.skip('DIAGNOSTIC: focusout from input → select triggers adjustLayout reset BUT citation mode stays open', async ({ page }) => {
    // The real iOS path: input focused, user taps shelf SELECT. iOS fires a
    // focusout event on the input with relatedTarget=SELECT and dismisses
    // the keyboard. keyboardManager treats it as keyboard-closed and calls
    // adjustLayout(false), which RESETS inline styles holding the panel above
    // the keyboard. That reset is CORRECT — the panel needs to drop back to
    // its CSS-default `bottom: 40px` position when the keyboard goes away
    // (otherwise it ends up floating in the middle of the viewport). What we
    // care about is: citation mode itself does NOT close.

    const logs = [];
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('STAYING OPEN') || t.includes('FOCUSOUT') || t.includes('adjustLayout') || t.includes('Closing')) {
        logs.push(`[${msg.type()}] ${t}`);
      }
    });

    await setCitationScope(page, 'shelf');

    await page.evaluate(() => {
      const km = window.activeKeyboardManager;
      if (!km) return;
      km.isKeyboardOpen = true;
      km.state.focusedElement = document.getElementById('citation-search-input');
      window.__adjustLayoutFalseCount = 0;
      const orig = km.adjustLayout.bind(km);
      km.adjustLayout = function (open, ...rest) {
        if (open === false) window.__adjustLayoutFalseCount++;
        return orig(open, ...rest);
      };
    });

    await page.locator('#citation-search-input').focus();

    await page.evaluate(() => {
      const input = document.getElementById('citation-search-input');
      const select = document.querySelector('.citation-shelf-select');
      const ev = new FocusEvent('focusout', { bubbles: true, cancelable: false, relatedTarget: select });
      input.dispatchEvent(ev);
    });

    await page.waitForTimeout(200);

    const result = await page.evaluate(() => ({
      adjustLayoutFalseCount: window.__adjustLayoutFalseCount || 0,
      stillOpen: !document.getElementById('citation-mode-container')?.classList.contains('hidden'),
      panelComputedBottom: getComputedStyle(document.getElementById('citation-toolbar-results')).bottom,
    }));

    console.log('\n----- FOCUSOUT DIAGNOSTIC -----');
    console.log('adjustLayout(false) calls:', result.adjustLayoutFalseCount, '(expected: ≥1, that\'s the correct reset)');
    console.log('Citation mode still open:', result.stillOpen, '(MUST be true)');
    console.log('Panel bottom after reset:', result.panelComputedBottom);
    logs.forEach(l => console.log('  ', l));
    console.log('----- END -----\n');

    // Citation mode must stay open — that's the user-facing guarantee.
    expect(result.stillOpen).toBe(true);
    // adjustLayout(false) should fire — it's responsible for snapping panel
    // back to the bottom of the screen now that the keyboard is gone.
    expect(result.adjustLayoutFalseCount).toBeGreaterThanOrEqual(1);
  });

  test.skip('DIAGNOSTIC: tap shelf select — capture every console message and final mode state', async ({ page }) => {
    // Stream EVERY console message from the page to the test runner so we can
    // see exactly which event path fires when the shelf select is tapped on
    // mobile. The user reports the picker opens but citation mode underneath
    // closes — we need to know which close() trigger fires.
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[ERROR] ${err.message}`));

    // Instrument CitationMode.close so we know exactly when (and from where) it fires.
    await page.evaluate(() => {
      const wait = setInterval(() => {
        const tb = document.getElementById('edit-toolbar');
        const mode = tb && tb._editToolbarInstance?.citationMode;
        // Best-effort discovery
        const allMode = window.__citationModeForTest;
        const target = mode || allMode;
        if (target && !target.__closeWrapped) {
          target.__closeWrapped = true;
          const orig = target.close.bind(target);
          target.close = function (...args) {
            console.log('🔒 CitationMode.close() CALLED from:', new Error().stack);
            return orig(...args);
          };
          clearInterval(wait);
        }
      }, 50);
      setTimeout(() => clearInterval(wait), 3000);
    });

    // Switch to Shelf so the picker is in the DOM and visible
    await setCitationScope(page, 'shelf');
    await expect(page.locator('.citation-shelf-picker')).toBeVisible();
    await page.waitForTimeout(300); // let the shelves load

    // Mark that we're about to interact
    await page.evaluate(() => console.log('===== TAPPING SHELF SELECT NOW ====='));

    // Real tap on the select (Playwright's tap = touch sequence)
    const select = page.locator('.citation-shelf-select');
    await select.tap();
    await page.waitForTimeout(500);

    await page.evaluate(() => console.log('===== AFTER TAP ====='));

    // Print everything captured
    console.log('\n----- CAPTURED CONSOLE OUTPUT -----');
    for (const line of logs) console.log(line);
    console.log('----- END CAPTURED OUTPUT -----\n');

    // Assert: citation mode must STILL be open after tapping the select
    const stillOpen = await page.evaluate(() =>
      !document.getElementById('citation-mode-container')?.classList.contains('hidden')
    );
    expect(stillOpen).toBe(true);
  });

  test('FULL FLOW: open modal → focus input → tap shelf chip → tap dropdown → tap option — modal must stay open at every step', async ({ page }) => {
    // End-to-end mobile flow with REAL touch events at every step.
    // Captures any close() call AND any change to citation-mode-container.hidden
    // so we know exactly which step (if any) breaks.

    const logs = [];
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('close') || t.includes('Close') || t.includes('Closing') || t.includes('FOCUSOUT') || t.includes('hidden')) {
        logs.push(`[${msg.type()}] ${t}`);
      }
    });

    // Stub /api/shelves so the dropdown has something to render
    await page.route('**/api/shelves', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'shelf-fake-1', name: 'Test Shelf One', item_count: 2 },
        { id: 'shelf-fake-2', name: 'Test Shelf Two', item_count: 5 },
      ]),
    }));

    // Make the toolbar visible (Playwright synthetic touches don't always
    // trigger the .visible class via selection logic)
    await page.evaluate(() => document.getElementById('edit-toolbar')?.classList.add('visible'));
    await page.evaluate(() => document.getElementById('citation-search-input')?.focus());
    await page.waitForFunction(() => document.activeElement?.id === 'citation-search-input', null, { timeout: 2000 });

    // Watch for the `.hidden` class being added to the container — that's
    // what close() does and what would visually "close" the modal.
    await page.evaluate(() => {
      window.__hideEvents = [];
      const container = document.getElementById('citation-mode-container');
      const mo = new MutationObserver(muts => {
        muts.forEach(m => {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            const hidden = container.classList.contains('hidden');
            window.__hideEvents.push({ hidden, at: performance.now() });
          }
        });
      });
      mo.observe(container, { attributes: true, attributeFilter: ['class'] });
    });

    const snapshot = async (label) => {
      const s = await page.evaluate(() => ({
        containerHidden: document.getElementById('citation-mode-container')?.classList.contains('hidden'),
        toolbarHasMode: document.getElementById('edit-toolbar')?.classList.contains('citation-mode-active'),
        activeId: document.activeElement?.id,
        activeTag: document.activeElement?.tagName,
        popupHidden: document.querySelector('.citation-shelf-options')?.hidden,
        hideEvents: window.__hideEvents,
      }));
      console.log(`[${label}]`, JSON.stringify(s));
      return s;
    };

    await snapshot('start');

    // STEP 1: tap Shelf chip
    await page.locator('.citation-scope-btn[data-scope="shelf"]').tap();
    await page.waitForTimeout(200);
    const afterShelfChip = await snapshot('after-shelf-chip');
    expect(afterShelfChip.containerHidden).toBe(false);

    // STEP 2: tap the custom shelf dropdown trigger
    await page.locator('.citation-shelf-trigger').tap();
    await page.waitForTimeout(300);
    const afterTriggerTap = await snapshot('after-trigger-tap');
    expect(afterTriggerTap.containerHidden).toBe(false);
    expect(afterTriggerTap.popupHidden).toBe(false);

    // STEP 3: tap an option (need to wait for shelves to render)
    await page.waitForSelector('li.citation-shelf-option', { timeout: 3000 });
    await page.locator('li.citation-shelf-option').first().tap();
    await page.waitForTimeout(200);
    const afterOptionTap = await snapshot('after-option-tap');
    expect(afterOptionTap.containerHidden).toBe(false);
    expect(afterOptionTap.popupHidden).toBe(true);

    console.log('\nRelevant logs:');
    logs.slice(-15).forEach(l => console.log(' ', l));
  });

  test('chip bar stays visible after switching Public → Mine → Shelf cycles', async ({ page }) => {
    const initialBox = await page.locator('.citation-scope-bar').boundingBox();

    await setCitationScope(page, 'mine');
    const afterMineBox = await page.locator('.citation-scope-bar').boundingBox();
    expect(afterMineBox.height).toBeCloseTo(initialBox.height, 0);

    await setCitationScope(page, 'shelf');
    const afterShelfBox = await page.locator('.citation-scope-bar').boundingBox();
    // Height must NOT change when picker appears — pinned to 38px in CSS.
    expect(afterShelfBox.height).toBeCloseTo(initialBox.height, 0);

    await setCitationScope(page, 'public');
    const afterPublicBox = await page.locator('.citation-scope-bar').boundingBox();
    expect(afterPublicBox.height).toBeCloseTo(initialBox.height, 0);
  });
});
