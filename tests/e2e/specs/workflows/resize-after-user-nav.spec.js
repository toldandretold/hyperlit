/**
 * Resize edge works after a user → reader SPA navigation — REAL mouse drag.
 *
 * Coverage gap this fills: the grand tour's resize phase only exercises
 * reader → home → reader. The user → reader pathway (DifferentTemplate, full
 * body swap) was never resize-tested. And unlike probeResizeHandle (which falls
 * back to dispatching a synthetic mousedown ON the edge element — bypassing
 * hit-testing — and would PASS even if a real drag is blocked), this test does
 * ONLY a real press-hold-drag, so it fails if anything covers/eats the edge,
 * which is exactly the "I can't drag it" symptom a user reports.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

const READER_BOOK = process.env.E2E_READER_BOOK;

test('resize edge works after user → reader SPA nav (real mouse only)', async ({ page, spa }) => {
  test.setTimeout(90_000);
  test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in .env.e2e');

  // Land on the user page via the real SPA path.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spa.navigateToUserPage(page);
  await spa.waitForTransition(page);
  expect(await spa.getStructure(page)).toBe('user');

  // SPA into the reader by clicking the book's library card (user → reader).
  const card = page.locator(`.libraryCard a[href$="/${READER_BOOK}"]`).first();
  if (await card.count()) {
    await card.click();
  } else {
    await page.locator('.libraryCard a[href^="/book_"]').first().click();
  }
  await spa.waitForTransition(page);
  await page.waitForFunction(() => document.body.getAttribute('data-page') === 'reader', null, { timeout: 8000 });

  // Open a hyperlit-container (footnote / hypercite) so the resize edge exists.
  const trigger = page.locator('sup.footnote-ref, sup[fn-count-id], u.couple[id^="hypercite_"], a.open-icon[id^="hypercite_"]').first();
  test.skip(!(await trigger.count()), 'book has no footnote/hypercite to open a container');
  await trigger.click();
  // Wait until the container has slid fully in — the panel is right-docked and
  // animates via transform: translateX(100%)→translateX(0), so for the first few
  // hundred ms the resize edge sits partly OFF the right of the viewport and a
  // hit-test at its centre returns null (not "covered" — simply off-screen).
  // Wait for the edge centre to be in-viewport AND the topmost element there
  // before measuring, so we test a settled panel, not a mid-transition one.
  await page.waitForFunction(() => {
    const c = document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
    const edge = c && c.querySelector('.resize-edge, .resize-handle');
    if (!edge) return false;
    // The slide-in transform must have reached REST (translateX(0)) first — `.open`
    // is set at animation START, so the edge is hit-testable mid-slide on a moving
    // target. Mirror helpers/elementProbes.js probeResizeHandle's settle guard.
    const t = getComputedStyle(c).transform;
    const tx = t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : 0;
    if (Math.abs(tx) > 1) return false;
    const r = edge.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    const top = document.elementFromPoint(x, y);
    return !!(top && top.closest('.resize-edge, .resize-handle'));
  }, null, { timeout: 8000 });

  // Geometry + hit-test of the edge centre (what's actually on top there?).
  const geom = await page.evaluate(() => {
    const c = document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
    const edge = c.querySelector('.resize-edge, .resize-handle');
    const er = edge.getBoundingClientRect();
    const x = er.x + er.width / 2, y = er.y + er.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      width: c.getBoundingClientRect().width,
      x, y,
      preResizing: edge.classList.contains('resizing'),
      topEl: top ? `${top.tagName.toLowerCase()}#${top.id || ''}.${(top.className || '').toString().trim().split(/\s+/).join('.')}` : null,
      topIsEdge: !!(top && top.closest('.resize-edge, .resize-handle')),
      isResizingStuck: !!(window.containerDragger && window.containerDragger.isResizing),
    };
  });

  // The reported symptom is "nothing happens on drag" — assert the preconditions
  // a real drag needs, then the drag itself, with the geometry in the message.
  const diag = JSON.stringify(geom);
  expect(geom.preResizing, `edge stuck in .resizing before drag — ${diag}`).toBe(false);
  expect(geom.isResizingStuck, `containerDragger.isResizing stuck true before drag — ${diag}`).toBe(false);
  expect(geom.topIsEdge, `resize edge is NOT the topmost element at its centre (something covers it) — ${diag}`).toBe(true);

  // REAL mouse drag only — exactly what a user does. No synthetic fallback.
  await page.mouse.move(geom.x, geom.y);
  await page.mouse.down();
  await page.mouse.move(geom.x - 80, geom.y, { steps: 10 });
  const midResizing = await page.evaluate(() => !!document.querySelector('.resize-edge.resizing, .resize-handle.resizing'));
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const c = document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
    return { width: c ? c.getBoundingClientRect().width : null };
  });
  const delta = after.width != null ? Math.abs(after.width - geom.width) : 0;

  expect(
    midResizing || delta >= 6,
    `real-mouse drag on .resize-edge did nothing (midResizing=${midResizing}, width ${geom.width}→${after.width}) — ${diag}`,
  ).toBe(true);
});
