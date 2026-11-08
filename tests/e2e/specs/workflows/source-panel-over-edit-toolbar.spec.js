import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * The source panel's bottom action bar must be reachable while the book is in
 * edit mode.
 *
 * #edit-toolbar is z-index 9999 (999999 on mobile) and #source-container is
 * 1001, so opening the panel in edit mode left the toolbar painted over the
 * panel's #source-action-bar — like / shelf / share / edit-card were dead under
 * a pointer. The toolbar now steps aside while the panel is open
 * (editToolbar.css, `body:has(#source-container.open)`), and comes back on close.
 */

const ACTION_BUTTONS = ['#like-book', '#shelf-book', '#share-book', '#edit-source'];

for (const viewport of [{ width: 1280, height: 800, label: 'desktop' }, { width: 390, height: 844, label: 'mobile' }]) {
  test(`source action bar is on top of the edit toolbar (${viewport.label})`, async ({ page, spa }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await spa.createNewBook(page, spa);
    await expect(page.locator('#edit-toolbar.visible')).toHaveCount(1);

    await page.evaluate(() => document.getElementById('cloudRef')?.click());
    await page.waitForFunction(() => !!document.querySelector('#source-container.open'), null, { timeout: 5000 });
    await page.waitForSelector('#source-action-bar', { timeout: 10_000 });
    await page.waitForTimeout(400); // slide-in transition

    // Probe the centre AND the lower edge of each button: the toolbar rises from
    // the bottom, so on a tall panel it clips only the bottom few px — a
    // centre-only probe passes while the bar is visibly cut in half.
    const hits = await page.evaluate((sels) => sels.flatMap((sel) => {
      const el = document.querySelector(sel);
      if (!el) return [{ sel, ok: false, why: 'missing' }];
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      return [r.top + r.height / 2, r.bottom - 2].map((y) => {
        const top = document.elementFromPoint(x, y);
        return { sel: `${sel} @y=${Math.round(y)}`, ok: !!top && (top === el || el.contains(top)), why: top ? (top.id || top.className || top.tagName) : 'nothing' };
      });
    }), ACTION_BUTTONS);
    for (const h of hits) {
      expect(h.ok, `${h.sel} should be the topmost element under the pointer, got ${h.why}`).toBe(true);
    }

    // A real click lands (edit-card opens the form).
    await page.click('#edit-source');
    await page.waitForSelector('#edit-form-container', { state: 'visible', timeout: 5000 });

    // Closing the panel brings the toolbar back.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#source-container.open'), null, { timeout: 5000 });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('edit-toolbar')).visibility))
      .toBe('visible');
  });
}
