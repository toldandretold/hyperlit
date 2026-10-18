/**
 * List-item gestures — the full lifecycle, with the two invariants that the
 * terms-book corruption (2026-10-16) violated checked after EVERY gesture:
 *
 *   1. No <p>/<h1>–<h6> may hold block content. `<h3>Warning<ol>…</ol></h3>`
 *      survives in the live DOM but collapses to an EMPTY node on the next
 *      parse, and ids minted inside such a wrapper restart at "1" (the
 *      integrity report's `<p id="2162"><p id="1">` with an empty IDB record).
 *   2. DOM order equals id order — a node whose id doesn't sort where it sits
 *      is silently relocated on the next render.
 *
 * Gestures driven with real clicks/keystrokes: convert a paragraph to a list,
 * merge neighbours into it, Enter to extend, Enter-on-empty to escape (last
 * and middle), list item → heading (flat AND nested — the reported bug), and
 * remove-list. Ends with a reload: the re-parse is where illegal nesting
 * becomes data loss, so surviving it is the real assertion.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

/** Both invariants, evaluated in the page. Call after every gesture. */
async function auditStructure(page, label) {
  const audit = await page.evaluate(() => {
    const mc = document.querySelector('.main-content');
    const illegal = [];
    for (const el of mc.querySelectorAll('p, h1, h2, h3, h4, h5, h6')) {
      if (el.querySelector('p, div, ul, ol, li, blockquote, pre, table, figure, h1, h2, h3, h4, h5, h6')) {
        illegal.push(el.outerHTML.slice(0, 160));
      }
    }
    const ids = Array.from(mc.querySelectorAll('.chunk > [id]'))
      .map((el) => el.id)
      .filter((id) => /^\d+(\.\d+)?$/.test(id));
    const sorted = [...ids].sort((a, b) => parseFloat(a) - parseFloat(b));
    return {
      illegal,
      ids,
      inOrder: JSON.stringify(ids) === JSON.stringify(sorted),
      hasDuplicates: new Set(ids).size !== ids.length,
    };
  });
  expect(audit.illegal, `${label}: block content trapped inside <p>/<h*>: ${audit.illegal.join(' | ')}`).toEqual([]);
  expect(audit.inOrder, `${label}: DOM order diverged from id order: ${audit.ids.join(',')}`).toBe(true);
  expect(audit.hasDuplicates, `${label}: duplicate ids minted: ${audit.ids.join(',')}`).toBe(false);
  return audit;
}

async function openNewBook(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.click('#newBookButton');
  await page.waitForFunction(() => {
    const c = document.getElementById('newbook-container');
    return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
  }, null, { timeout: 5000 });
  await page.click('#createNewBook');
  await spa.waitForTransition(page);
  await spa.waitForEditMode(page);
  await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
}

async function clickBlockType(page, type) {
  await page.click('#blockquoteButton');
  await page.waitForSelector('#blockquote-submenu:not(.hidden)', { timeout: 5000 });
  await page.click(`#blockquote-submenu [data-block-type="${type}"]`);
  await page.waitForTimeout(400);
}

async function clickHeadingLevel(page, level) {
  await page.click('#headingButton');
  await page.waitForSelector('#heading-submenu:not(.hidden)', { timeout: 5000 });
  await page.click(`#heading-submenu [data-heading="${level}"]`);
  await page.waitForTimeout(400);
}

/** Click into the element containing `text` and seat the caret at its end. */
async function caretIn(page, text) {
  const handle = await page.evaluateHandle((t) => {
    // Strip zero-width caret anchors (placeCaretInEmptyListItem) before matching.
    const clean = (s) => s.replace(/\u200B/g, '').trim();
    return Array.from(document.querySelectorAll('.main-content p, .main-content li, .main-content h1, .main-content h2, .main-content h3'))
      .find((el) => clean(el.textContent) === t) || null;
  }, text);
  expect(await handle.evaluate((el) => !!el), `no element with text "${text}"`).toBe(true);
  await handle.asElement().click();
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
}

test.describe('divEditor — list item gestures keep structure legal and ids ordered', () => {
  test('convert, extend, escape, heading, remove-list — every step audited', async ({ page, spa }) => {
    test.setTimeout(180_000);

    await openNewBook(page, spa);

    // Three paragraphs to work with.
    await page.click('h1[id="100"]');
    await page.keyboard.press('End');
    for (const text of ['alpha', 'beta', 'gamma']) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await page.keyboard.type(text);
    }
    await auditStructure(page, 'after typing three paragraphs');

    // "change one to list item, and change others to list item" — the user's
    // actual gesture: each line converted at the caret, one at a time.
    for (const text of ['alpha', 'beta', 'gamma']) {
      await caretIn(page, text);
      await clickBlockType(page, 'ul');
      expect(await page.locator('.main-content ul li', { hasText: text }).count()).toBe(1);
      await auditStructure(page, `after converting ${text} to a list`);
    }

    // Enter at the end of a non-empty item extends the list…
    await caretIn(page, 'gamma');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type('delta');
    await auditStructure(page, 'after extending the list with delta');

    // …and Enter on the EMPTY item it leaves behind escapes after the list.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('escaped tail');
    await auditStructure(page, 'after escaping from the last item');

    // Escape from the MIDDLE: empty item between gamma and delta, then Enter —
    // the split path that minted +100 ids in the 2026-09-18 incident.
    await caretIn(page, 'gamma');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('escaped middle');
    await auditStructure(page, 'after escaping from a middle item');

    // List item → heading: must mint a real heading, never a <pre>, and split the list.
    await caretIn(page, 'delta');
    await clickHeadingLevel(page, 'h3');
    const h3Count = await page.locator('.main-content h3', { hasText: 'delta' }).count();
    expect(h3Count, 'li→heading must produce a heading').toBe(1);
    expect(await page.locator('.main-content pre', { hasText: 'delta' }).count()).toBe(0);
    await auditStructure(page, 'after converting a list item to h3');

    // Remove-list unwraps what remains back to paragraphs.
    await caretIn(page, 'alpha');
    await clickBlockType(page, 'p');
    expect(await page.locator('.main-content ul li', { hasText: 'alpha' }).count()).toBe(0);
    await auditStructure(page, 'after remove-list');

    // The re-parse is where illegal nesting becomes data loss.
    await page.waitForTimeout(2500); // let debounced saves flush
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    for (const text of ['alpha', 'beta', 'gamma', 'delta', 'escaped tail', 'escaped middle']) {
      expect(await page.locator('.main-content').textContent(), `"${text}" lost on reload`).toContain(text);
    }
    await auditStructure(page, 'after reload');
  });

  test('heading on an item carrying a NESTED list hoists the sublist (terms 2026-10-16)', async ({ page, spa }) => {
    test.setTimeout(120_000);

    await openNewBook(page, spa);

    // One real list item via gestures, then nest a sublist inside it the way
    // the content actually arrives (paste/import produce nested lists; moves
    // never re-parse, so appending keeps it inside the <li>).
    await page.click('h1[id="100"]');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type('Warning');
    await caretIn(page, 'Warning');
    await clickBlockType(page, 'ol');
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      const li = Array.from(document.querySelectorAll('.main-content li'))
        .find((el) => el.textContent.trim() === 'Warning');
      const sub = document.createElement('ol');
      for (const t of ['Event', 'Consequence', 'Repair']) {
        const item = document.createElement('li');
        item.textContent = t;
        sub.appendChild(item);
      }
      li.appendChild(sub);
    });
    await page.waitForTimeout(1500); // let the mutation observer persist the list

    // The reported gesture: cursor on the "Warning" line, make it a heading.
    const li = page.locator('.main-content li').filter({ hasText: 'Warning' }).first();
    await li.click({ position: { x: 30, y: 8 } }); // top line of the item, not the sublist
    await page.waitForTimeout(200);
    await clickHeadingLevel(page, 'h3');

    // The heading holds ONLY the line; the sublist survives as a sibling node.
    const shape = await page.evaluate(() => {
      const h3 = Array.from(document.querySelectorAll('.main-content h3'))
        .find((el) => el.textContent.includes('Warning'));
      if (!h3) return { h3: false };
      return {
        h3: true,
        headingText: h3.textContent.trim(),
        listInsideHeading: !!h3.querySelector('ol, ul'),
        nextTag: h3.nextElementSibling?.tagName,
        nextText: h3.nextElementSibling?.textContent || '',
      };
    });
    expect(shape.h3, 'the heading was never created').toBe(true);
    expect(shape.headingText).toBe('Warning');
    expect(shape.listInsideHeading, 'the whole list was swallowed into the heading').toBe(false);
    expect(shape.nextTag).toBe('OL');
    expect(shape.nextText).toContain('Repair');
    await auditStructure(page, 'after converting a nested-list item to h3');

    // Survives the re-parse with nothing lost.
    await page.waitForTimeout(2500);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    for (const text of ['Warning', 'Event', 'Consequence', 'Repair']) {
      expect(await page.locator('.main-content').textContent(), `"${text}" lost on reload`).toContain(text);
    }
    await auditStructure(page, 'after reload (nested case)');
  });
});
