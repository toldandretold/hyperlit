# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/citations/citation-modal-mobile.spec.js >> Citation modal — mobile viewport >> chip bar stays visible after switching Public → Mine → Shelf cycles
- Location: tests/e2e/specs/citations/citation-modal-mobile.spec.js:392:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/book_1777271888985", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * Citation modal — mobile viewport regressions.
  3   |  *
  4   |  * Two bugs the user kept hitting:
  5   |  *   1. On mobile, opening the modal showed the chips behind / cut off by the
  6   |  *      bottom of the viewport — `keyboardManager.moveToolbarAboveKeyboard`
  7   |  *      was forcing the panel to `height: 0px` when `data-state="hidden"`
  8   |  *      using the old pre-rewrite height table.
  9   |  *   2. Tapping Shelf without a keyboard up did not surface the picker —
  10  |  *      same root cause, panel collapsed to nothing.
  11  |  *
  12  |  * These tests use Playwright's viewport emulation (iPhone-sized) to verify
  13  |  * the chip bar and the shelf picker are actually visible (inside the
  14  |  * viewport rect) after each interaction.
  15  |  */
  16  | 
  17  | import { test, expect } from '../../fixtures/navigation.fixture.js';
  18  | import {
  19  |   findCitableParagraph,
  20  |   openCitationModal,
  21  |   setCitationScope,
  22  | } from '../../helpers/citationModal.js';
  23  | 
  24  | const READER_BOOK = process.env.E2E_READER_BOOK || 'book_1777271888985';
  25  | 
  26  | // iPhone 13 viewport — narrow enough to trigger mobile CSS and the panel
  27  | // positioning code path used on phones.
  28  | test.use({
  29  |   viewport: { width: 390, height: 844 },
  30  |   hasTouch: true,
  31  | });
  32  | 
  33  | test.describe('Citation modal — mobile viewport', () => {
  34  |   test.beforeEach(async ({ page }) => {
> 35  |     await page.goto(`/${READER_BOOK}`);
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  36  |     await page.evaluate(() => {
  37  |       try {
  38  |         localStorage.removeItem('hyperlit:citation:scope');
  39  |         localStorage.removeItem('hyperlit:citation:shelfId');
  40  |       } catch {}
  41  |     });
  42  |     await page.waitForLoadState('networkidle').catch(() => {});
  43  |     await page.waitForSelector('.main-content', { timeout: 20_000 });
  44  | 
  45  |     const sel = await findCitableParagraph(page, 40);
  46  |     if (!sel) test.skip(true, 'no citable paragraph in test book');
  47  |     await openCitationModal(page, sel, 10);
  48  |   });
  49  | 
  50  |   test('chip bar is inside the visible viewport rect', async ({ page }) => {
  51  |     const viewport = page.viewportSize();
  52  |     const chipBarBox = await page.locator('.citation-scope-bar').boundingBox();
  53  | 
  54  |     expect(chipBarBox).not.toBeNull();
  55  |     // Must be within the visible viewport (not pushed off-screen by panel
  56  |     // collapse). Top edge must be ≥ 0; bottom edge must be ≤ viewport height.
  57  |     expect(chipBarBox.y).toBeGreaterThanOrEqual(0);
  58  |     expect(chipBarBox.y + chipBarBox.height).toBeLessThanOrEqual(viewport.height);
  59  |     // Bar height must reflect the 38px CSS — was 0 in the bug.
  60  |     expect(chipBarBox.height).toBeGreaterThan(20);
  61  |   });
  62  | 
  63  |   test('panel itself has non-zero rendered height on mobile open', async ({ page }) => {
  64  |     const panelBox = await page.locator('#citation-toolbar-results').boundingBox();
  65  |     expect(panelBox).not.toBeNull();
  66  |     // Was collapsing to height: 0 via the stale keyboard-manager rule.
  67  |     expect(panelBox.height).toBeGreaterThan(30);
  68  |   });
  69  | 
  70  |   test('tapping Shelf without keyboard reveals the picker inside the panel', async ({ page }) => {
  71  |     // Make sure shelf picker is currently hidden before the tap
  72  |     await expect(page.locator('.citation-shelf-picker')).toBeHidden();
  73  | 
  74  |     await setCitationScope(page, 'shelf');
  75  | 
  76  |     // Picker must become visible AND have non-zero height (was rendering
  77  |     // inside a collapsed-to-0 panel before the fix).
  78  |     await expect(page.locator('.citation-shelf-picker')).toBeVisible();
  79  |     const pickerBox = await page.locator('.citation-shelf-picker').boundingBox();
  80  |     expect(pickerBox).not.toBeNull();
  81  |     expect(pickerBox.height).toBeGreaterThan(15);
  82  | 
  83  |     // Picker must also sit within the visible viewport — not below it
  84  |     const viewport = page.viewportSize();
  85  |     expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(viewport.height);
  86  |   });
  87  | 
  88  |   test('REAL touch on Shelf chip fires the scope change (no preventDefault eating the click)', async ({ page }) => {
  89  |     // Bug regression: handleResultsScroll preventDefault'd every touchstart
  90  |     // inside the panel when it wasn't overflowing, swallowing the synthesized
  91  |     // click on the chip. Using page.tap() (real touch sequence) instead of
  92  |     // page.click() catches that — click() injects a synthetic click event
  93  |     // directly and bypasses the touchstart-preventDefault path.
  94  |     const chip = page.locator('.citation-scope-btn[data-scope="shelf"]');
  95  |     await expect(chip).toBeVisible();
  96  |     await chip.tap();
  97  | 
  98  |     // If the tap actually reached the click handler, the chip is now active
  99  |     // AND the shelf picker is visible.
  100 |     await expect(chip).toHaveClass(/active/);
  101 |     await expect(page.locator('.citation-shelf-picker')).toBeVisible();
  102 |   });
  103 | 
  104 |   test('tapping a chip does NOT blur the search input (keyboard stays up)', async ({ page }) => {
  105 |     // Focus the input first (this is what brings up the keyboard on real mobile)
  106 |     await page.locator('#citation-search-input').focus();
  107 |     expect(await page.evaluate(() => document.activeElement?.id)).toBe('citation-search-input');
  108 | 
  109 |     // Tap Mine via real touch sequence
  110 |     await page.locator('.citation-scope-btn[data-scope="mine"]').tap();
  111 | 
  112 |     // After the chip tap the input must STILL be the active element.
  113 |     // If it isn't, the chip stole focus — on real mobile that dismisses the
  114 |     // on-screen keyboard, which was the user's complaint.
  115 |     expect(await page.evaluate(() => document.activeElement?.id)).toBe('citation-search-input');
  116 | 
  117 |     // And the click side-effect (scope change) still happened.
  118 |     await expect(page.locator('.citation-scope-btn[data-scope="mine"]')).toHaveClass(/active/);
  119 |   });
  120 | 
  121 |   test('DIAGNOSTIC: simulate the EXACT iOS event sequence (picker open + dismiss with target=body)', async ({ page }) => {
  122 |     // iOS Safari quirk: when the native <select> picker dismisses, Safari
  123 |     // dispatches a synthetic click event back to the page whose target is
  124 |     // somewhere OUTSIDE the picker — often body / html / the page background.
  125 |     // That click hits handleDocumentClick which (without our guards) treats
  126 |     // it as an outside-tap and closes citation mode.
  127 |     //
  128 |     // Playwright/Chromium can't open the iOS picker, but we CAN simulate the
  129 |     // dismissal sequence event-for-event and verify every defense layer.
  130 | 
  131 |     const logs = [];
  132 |     page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  133 | 
  134 |     await setCitationScope(page, 'shelf');
  135 |     await expect(page.locator('.citation-shelf-picker')).toBeVisible();
```