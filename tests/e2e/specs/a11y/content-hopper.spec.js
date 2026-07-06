/**
 * Content keyboard navigation (WCAG 2.1.1) — the hop layer + Tab-order model.
 *
 * The reader's keyboard model (docs/a11y-findings.md "Keyboard model"):
 *   - Tab is a SHORT chrome loop — content anchors are tabindex="-1" at render.
 *   - n/j and p/k hop between in-text interactables (hyperlights, hypercites,
 *     footnote refs, citations, links) with a visible focus ring; Enter opens.
 *   - Arrows/Space/PageUp/Down are never intercepted (native scroll).
 *
 * Fixture: E2E_A11Y_BOOK from `php artisan e2e:seed-fixtures` — carries one of
 * every interactable in known DOM order.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';

const A11Y_BOOK = process.env.E2E_A11Y_BOOK;

async function gotoFixture(page) {
  test.skip(!A11Y_BOOK, 'E2E_A11Y_BOOK not set — run `php artisan e2e:seed-fixtures`');
  await page.goto(`/${A11Y_BOOK}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.main-content p', { timeout: 15000 });
  await page.waitForTimeout(400); // chunk render settle
}

const activeDesc = () => ({
  tag: document.activeElement?.tagName || '(none)',
  id: document.activeElement?.id || '',
  cls: typeof document.activeElement?.className === 'string' ? document.activeElement.className : '',
  inContent: !!document.activeElement?.closest?.('.main-content'),
});

test('Tab order is a short chrome loop — content anchors are not Tab stops', async ({ page }) => {
  await gotoFixture(page);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());

  const stops = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const d = await page.evaluate(activeDesc);
    const key = `${d.tag}#${d.id}`;
    if (stops.includes(key)) break; // wrapped
    stops.push(key);
    expect(d.inContent, `Tab stop #${i + 1} (${key}) is inside .main-content — content must be hop-layer only`).toBe(false);
  }
  expect(stops.length, `chrome Tab loop too long: ${stops.join(' → ')}`).toBeLessThan(13);
});

test('n/p hop across every interactable kind in DOM order, with visible focus', async ({ page }) => {
  await gotoFixture(page);

  const seen = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('n');
    await page.waitForTimeout(150);
    const d = await page.evaluate(activeDesc);
    if (!d.inContent) break;
    seen.push(`${d.tag}${d.cls ? '.' + d.cls.split(' ')[0] : ''}`);
  }

  // The fixture carries: footnote sup, hyperlight mark, hypercite u.couple,
  // in-text citation a, external link a — all must be reachable by hopping.
  const joined = seen.join(' ');
  expect(joined, `hop sequence missed a kind: ${joined}`).toContain('SUP');
  expect(joined).toContain('MARK');
  expect(joined).toContain('U.couple');
  expect(joined).toContain('A.in-text-citation');

  // p reverses.
  const before = await page.evaluate(activeDesc);
  await page.keyboard.press('p');
  await page.waitForTimeout(150);
  const after = await page.evaluate(activeDesc);
  expect(`${after.tag}#${after.id}`).not.toBe(`${before.tag}#${before.id}`);

  // The focused annotation shows the focus ring (keyboard-initiated focus).
  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return s.outlineStyle;
  });
  expect(ring, 'hopped annotation should carry the :focus-visible ring').not.toBe('none');
});

test('Enter on a hopped footnote ref opens the footnote container', async ({ page }) => {
  await gotoFixture(page);

  // Hop until the footnote sup has focus.
  let onSup = false;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('n');
    await page.waitForTimeout(150);
    onSup = await page.evaluate(() => document.activeElement?.tagName === 'SUP');
    if (onSup) break;
  }
  expect(onSup, 'never hopped onto the footnote sup').toBe(true);

  await page.keyboard.press('Enter');
  const opened = await page.waitForFunction(
    () => document.querySelector('#hyperlit-container.open'),
    null, { timeout: 8000 }
  ).then(() => true).catch(() => false);
  expect(opened, 'Enter on the footnote ref should open the footnote container').toBe(true);
});

test('open container becomes the hop territory; Escape pops back out (WCAG 2.1.1)', async ({ page }) => {
  await gotoFixture(page);

  // Hop to the footnote ref and open its container.
  let onSup = false;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('n');
    await page.waitForTimeout(150);
    onSup = await page.evaluate(() => document.activeElement?.tagName === 'SUP');
    if (onSup) break;
  }
  expect(onSup).toBe(true);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#hyperlit-container.open', { timeout: 8000 });
  // Wait for the sub-book content (with its link) to actually mount.
  await page.waitForFunction(
    () => !!document.querySelector('#hyperlit-container a[href*="fn-link"], #hyperlit-container .sub-book-content a[href]'),
    null, { timeout: 8000 }
  );
  await page.waitForTimeout(200);

  // n now hops INSIDE the container (its links), not the main book behind it.
  let insideContainer = false;
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('n');
    await page.waitForTimeout(150);
    const d = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        inContainer: !!el?.closest?.('#hyperlit-container'),
        inMain: !!el?.closest?.('main.main-content'),
        tag: el?.tagName,
      };
    });
    expect(d.inMain, `hop #${i + 1} escaped to the main book behind the open container`).toBe(false);
    if (d.inContainer) { insideContainer = true; break; }
  }
  expect(insideContainer, 'n never landed on a link inside the open container').toBe(true);

  // Escape pops the container; hop territory returns to the main book.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#hyperlit-container.open'), null, { timeout: 5000 });
  await page.keyboard.press('n');
  await page.waitForTimeout(150);
  const backInMain = await page.evaluate(() => !!document.activeElement?.closest?.('main.main-content'));
  expect(backInMain, 'after Escape, n should hop the main book again').toBe(true);
});

test('hop keys are inert while a modal is open and while typing', async ({ page }) => {
  await gotoFixture(page);

  // Baseline: n moves focus into content.
  await page.keyboard.press('n');
  await page.waitForTimeout(150);
  expect((await page.evaluate(activeDesc)).inContent).toBe(true);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());

  // Modal open (settings) → n must not hop.
  await page.click('#settingsButton');
  await page.waitForSelector('#settings-container:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.keyboard.press('n');
  await page.waitForTimeout(150);
  const duringModal = await page.evaluate(activeDesc);
  expect(duringModal.inContent, 'n hopped into content while settings modal open').toBe(false);
  await page.keyboard.press('Escape'); // close settings
  await page.waitForTimeout(300);

  // Typing context → letters type, they don't hop. (Focus the slider label
  // isn't an input; use the in-text search input via settings is heavy — the
  // homepage isn't here, so simulate with a temp input.)
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'e2e-hop-guard-probe';
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.press('n');
  const typed = await page.evaluate(() => {
    const input = document.getElementById('e2e-hop-guard-probe');
    const v = input.value;
    input.remove();
    return v;
  });
  expect(typed, '"n" should type into inputs, not hop').toBe('n');
});
