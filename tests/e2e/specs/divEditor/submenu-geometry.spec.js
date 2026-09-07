/**
 * Popover ↔ toolbar geometry probe (iPhone viewport): with a submenu open,
 * measure the vertical gap between the popover's bottom edge and the toolbar
 * trigger buttons underneath, and report which triggers sit directly below
 * which options. A near-zero gap means a thumb aiming at a trigger can land
 * on a popover option — the "tap heading, citation fires" phantom.
 */
import { test, expect } from '@playwright/test';

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  // iPhone UA so the UA-gated touch handlers (four-listener buttons, tap
  // extender, keyboard zone guards) all engage like on a real phone.
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  // While vite's hot file points at a plain-http LAN origin (phone-testing
  // mode), https://hyperlit.test pages get their vite modules BLOCKED as
  // mixed content — a silently half-loaded app. Allow it so this spec tests
  // the FULL app, matching what the (all-http) phone actually runs.
  launchOptions: { args: ['--allow-running-insecure-content'] },
});

test.describe('submenu geometry (mobile)', () => {
  test('popover options must not hug the toolbar row', async ({ page }) => {
    test.setTimeout(90_000);

    const tapLogs = [];
    page.on('console', (m) => {
      const t = m.text();
      if (/🎯|CITBTN|AT-POINT|citation mode|openCitation/.test(t)) tapLogs.push(t.slice(0, 160));
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.click('#newBookButton');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');
    await page.waitForSelector('.main-content[contenteditable="true"]', { timeout: 15000 });
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');

    // Open the insert submenu
    await page.click('#insertButton');
    await page.waitForSelector('#insert-submenu:not(.hidden)', { timeout: 5000 });

    const geo = await page.evaluate(() => {
      const menu = document.getElementById('insert-submenu').getBoundingClientRect();
      const triggers = {};
      for (const id of ['boldButton', 'italicButton', 'headingButton', 'blockquoteButton', 'insertButton', 'undoButton', 'redoButton']) {
        const el = document.getElementById(id);
        if (el) triggers[id] = el.getBoundingClientRect();
      }
      const options = {};
      for (const id of ['footnoteButton', 'citationButton', 'imageButton', 'linkButton']) {
        const el = document.getElementById(id);
        if (el) {
          const r = el.getBoundingClientRect();
          options[id] = { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) };
        }
      }
      const headingRect = triggers.headingButton;
      const overHeading = Object.entries(options).filter(([, r]) =>
        r.right > headingRect.left && r.left < headingRect.right);
      return {
        menuBottom: Math.round(menu.bottom),
        headingTop: Math.round(headingRect.top),
        gapToTriggers: Math.round(headingRect.top - menu.bottom),
        options,
        optionsAboveHeadingButton: overHeading.map(([id]) => id),
      };
    });
    console.log('[submenu-geo]', JSON.stringify(geo));

    // The regression guard: real air between the popover bottom and the
    // trigger row, so a thumb aiming at a trigger can't graze options (at the
    // old 1px offset the gap measured 14px and citation sat DIRECTLY above
    // the heading button — "tap heading, citation inserter opens").
    expect(geo.gapToTriggers, `popover hugs the toolbar (gap=${geo.gapToTriggers}px); options over heading: ${geo.optionsAboveHeadingButton}`).toBeGreaterThanOrEqual(28);

    // ── Live misfire repro ──
    // 1. Tap the OLD kill zone: 8px above the heading button's top edge
    //    (where the citation option used to sit). Nothing may fire.
    const heading = await page.evaluate(() => {
      const r = document.getElementById('headingButton').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), yAbove: Math.round(r.top - 8), y: Math.round(r.top + r.height / 2) };
    });
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      console.log('AT-POINT', x, y, el ? `${el.tagName}#${el.id}.${el.className}` : 'null');
      const cb = document.getElementById('citationButton');
      const r = cb.getBoundingClientRect();
      console.log('AT-POINT citationButton rect', Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom));
      for (const t of ['touchstart', 'touchend', 'click']) {
        cb.addEventListener(t, (e) => console.log('CITBTN', t, 'trusted=', e.isTrusted), true);
      }
    }, { x: heading.x, y: heading.yAbove });
    await page.touchscreen.tap(heading.x, heading.yAbove);
    await page.waitForTimeout(400);
    const afterGraze = await page.evaluate(() => ({
      citationOpen: !document.getElementById('citation-mode-container').classList.contains('hidden'),
      headingMenuOpen: !document.getElementById('heading-submenu').classList.contains('hidden'),
    }));
    console.log('[submenu-geo] graze result:', JSON.stringify(afterGraze), 'tap logs:', JSON.stringify(tapLogs.slice(-12)));
    expect(afterGraze.citationOpen, 'a graze above heading must NOT open citation mode').toBe(false);
    // The near-miss is correctly claimed by the button the user was aiming at
    // (the JS tap extender's job): heading's menu opens, nothing else fires.
    expect(afterGraze.headingMenuOpen, 'the graze belongs to the heading button underneath').toBe(true);

    // 2. Re-open insert, then tap DEAD CENTER on the heading button: menus
    //    must switch (insert closes, heading opens) and citation stays shut.
    await page.evaluate(() => document.getElementById('insertButton').click());
    await page.waitForSelector('#insert-submenu:not(.hidden)', { timeout: 5000 });
    await page.touchscreen.tap(heading.x, heading.y);
    await page.waitForTimeout(400);
    const afterSwitch = await page.evaluate(() => ({
      citationOpen: !document.getElementById('citation-mode-container').classList.contains('hidden'),
      headingMenuOpen: !document.getElementById('heading-submenu').classList.contains('hidden'),
      insertMenuOpen: !document.getElementById('insert-submenu').classList.contains('hidden'),
    }));
    console.log('[submenu-geo] after center tap:', JSON.stringify(afterSwitch));
    expect(afterSwitch.citationOpen, 'tapping heading must never open citation').toBe(false);
    expect(afterSwitch.insertMenuOpen, 'insert menu must close when heading is tapped').toBe(false);
    expect(afterSwitch.headingMenuOpen, 'heading menu must open on a direct tap').toBe(true);
  });
});
