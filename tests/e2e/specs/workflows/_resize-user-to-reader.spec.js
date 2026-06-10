/**
 * SCRATCH repro: does the hyperlit-container resize edge work after a
 * user → reader SPA navigation, with a REAL mouse drag (no synthetic fallback)?
 *
 * Delete once the bug is understood/fixed.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

const READER_BOOK = process.env.E2E_READER_BOOK;

test('REPRO: resize after user → reader (real mouse only)', async ({ page, spa }) => {
  test.setTimeout(90_000);
  test.skip(!READER_BOOK, 'no E2E_READER_BOOK');

  // Land on the user page via the real SPA path.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spa.navigateToUserPage(page);
  await spa.waitForTransition(page);
  expect(await spa.getStructure(page)).toBe('user');

  // SPA into the reader by clicking the book's library card (user → reader).
  const card = page.locator(`.libraryCard a[href$="/${READER_BOOK}"]`).first();
  if (!(await card.count())) {
    // Fall back to the first card if the specific book isn't on this user page.
    await page.locator('.libraryCard a[href^="/book_"]').first().click();
  } else {
    await card.click();
  }
  await spa.waitForTransition(page);
  await page.waitForFunction(() => document.body.getAttribute('data-page') === 'reader', null, { timeout: 8000 });

  // Open a hyperlit-container (footnote / hypercite) so the resize edge exists.
  const trigger = page.locator('sup.footnote-ref, sup[fn-count-id], u.couple[id^="hypercite_"], a.open-icon[id^="hypercite_"]').first();
  if (!(await trigger.count())) {
    test.skip(true, 'book has no footnote/hypercite to open a container');
  }
  await trigger.click();
  await page.waitForFunction(() => {
    const c = document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
    return !!(c && c.querySelector('.resize-edge, .resize-handle'));
  }, null, { timeout: 8000 });

  // Geometry + hit-test of the edge centre.
  const geom = await page.evaluate(() => {
    const c = document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
    const edge = c.querySelector('.resize-edge, .resize-handle');
    const er = edge.getBoundingClientRect();
    const x = er.x + er.width / 2, y = er.y + er.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      width: c.getBoundingClientRect().width,
      edge: { x: er.x, y: er.y, w: er.width, h: er.height },
      x, y,
      pre_resizing: edge.classList.contains('resizing'),
      topEl: top ? `${top.tagName.toLowerCase()}#${top.id || ''}.${(top.className || '').toString().trim().split(/\s+/).join('.')}` : null,
      topIsEdge: !!(top && top.closest('.resize-edge, .resize-handle')),
      bodyResizingClass: document.body.classList.contains('container-resizing'),
      isResizingFlag: !!(window.containerDragger && window.containerDragger.isResizing),
    };
  });
  console.log('[REPRO] geom =', JSON.stringify(geom, null, 2));

  // REAL mouse drag only — exactly what a user does.
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
  console.log(`[REPRO] real-mouse drag: midResizing=${midResizing} width ${geom.width} -> ${after.width} (delta=${delta})`);

  expect(geom.pre_resizing, 'edge should not be stuck in .resizing before drag').toBe(false);
  expect(geom.topIsEdge, `the resize edge must be the topmost element at its centre (got ${geom.topEl})`).toBe(true);
  expect(midResizing || delta >= 6, 'a real-mouse drag on .resize-edge must resize the container').toBe(true);
});
