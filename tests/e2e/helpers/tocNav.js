/**
 * TOC (table-of-contents) helpers.
 *
 * The TOC is rendered into #toc-container with anchor links like
 * <a href="#100">. Toggle via #toc-toggle-button. Click handler in
 * resources/js/components/toc.js calls navigateToInternalId(targetId) and
 * closes the TOC. These helpers wait for the close + scroll to settle so
 * the caller can immediately assert on the landing.
 */

export async function isTocOpen(page) {
  return page.evaluate(() => !!document.querySelector('#toc-container.open'));
}

export async function openToc(page) {
  if (await isTocOpen(page)) return;
  // If the perimeter is hidden (because something earlier was outside the
  // togglePerimeterButtons ignore-list — e.g. tapping a footnote ref),
  // first tap an empty main-content area to toggle the perimeter back on.
  // Mirrors the real-user gesture: tap elsewhere to bring nav back.
  await ensurePerimeterVisible(page);
  await page.click('#toc-toggle-button');
  await page.waitForFunction(
    () => !!document.querySelector('#toc-container.open'),
    null,
    { timeout: 5000 }
  );
}

/**
 * If `#bottom-right-buttons` (or any perimeter container) has the
 * `perimeter-hidden` class, dispatch a click on an empty area of
 * `.main-content` to trigger `togglePerimeterButtons.syncPerimeterButtons()`
 * and bring them back. No-op if already visible.
 */
export async function ensurePerimeterVisible(page) {
  const wasHidden = await page.evaluate(() => {
    const hidden = !!document.querySelector('#bottom-right-buttons.perimeter-hidden');
    if (!hidden) return false;
    // Find an empty spot in .main-content to click — pick a position
    // between paragraphs (or just at the body, away from interactive
    // elements). The togglePerimeterButtons ignore list excludes buttons,
    // links, footnote refs, hypercite underlines, and a handful of UI
    // panels — anywhere else is fair game.
    const main = document.querySelector('.main-content');
    if (!main) return true;
    const r = main.getBoundingClientRect();
    // Synthesise a click at the left margin of main-content (avoids text)
    const x = Math.max(10, r.left - 20);
    const y = Math.max(10, r.top + r.height / 2);
    const target = document.elementFromPoint(x, y) || main;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return true;
  });
  if (wasHidden) {
    await page.waitForFunction(
      () => !document.querySelector('#bottom-right-buttons.perimeter-hidden'),
      null,
      { timeout: 3000 }
    ).catch(() => { /* best-effort */ });
  }
}

export async function closeToc(page) {
  if (!(await isTocOpen(page))) return;
  // While open, #toc-overlay covers #toc-toggle-button — click the overlay
  // (or fall back to Escape) to close.
  const overlayClicked = await page.evaluate(() => {
    const overlay = document.getElementById('toc-overlay');
    if (overlay && overlay.classList.contains('active')) {
      overlay.click();
      return true;
    }
    return false;
  });
  if (!overlayClicked) {
    await page.keyboard.press('Escape');
  }
  await page.waitForFunction(
    () => {
      const c = document.getElementById('toc-container');
      return !c || !c.classList.contains('open');
    },
    null,
    { timeout: 5000 }
  );
}

/**
 * Return the TOC entries currently rendered.
 * @returns {Promise<Array<{index: number, href: string, text: string, headingLevel: string}>>}
 */
export async function getTocEntries(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('#toc-container .scroller a'));
    return links.map((a, index) => {
      const heading = a.querySelector('h1,h2,h3,h4,h5,h6');
      return {
        index,
        href: a.getAttribute('href') || '',
        text: (heading?.textContent || a.textContent || '').trim(),
        headingLevel: heading?.tagName?.toLowerCase() || '',
      };
    });
  });
}

/**
 * Click a TOC entry. Predicate can be:
 *   - number: index
 *   - string: substring match against entry text
 *   - function: (entry) => boolean
 *
 * Waits for the TOC to close and the scroll to settle. Returns the entry.
 */
export async function clickTocEntry(page, predicate) {
  const entries = await getTocEntries(page);
  let target;
  if (typeof predicate === 'number') {
    target = entries[predicate];
  } else if (typeof predicate === 'function') {
    target = entries.find(predicate);
  } else if (typeof predicate === 'string') {
    target = entries.find(e => e.text.includes(predicate));
  }
  if (!target) {
    throw new Error(`No TOC entry matched predicate: ${String(predicate)}. Entries: ${JSON.stringify(entries.map(e => e.text))}`);
  }
  // Click via JS — href starts with # so a plain locator.click is safe, but
  // the entries can be clipped by the mask div. Use evaluate to be robust.
  const clicked = await page.evaluate((href) => {
    const link = document.querySelector(`#toc-container .scroller a[href="${href}"]`);
    if (!link) return false;
    link.click();
    return true;
  }, target.href);
  if (!clicked) throw new Error(`Could not click TOC entry href=${target.href}`);

  // TOC click handler closes the container; wait for that
  await page.waitForFunction(() => {
    const c = document.getElementById('toc-container');
    return !c || !c.classList.contains('open');
  }, null, { timeout: 5000 });

  // Allow scroll to settle
  await page.waitForTimeout(700);

  return target;
}

/**
 * Return whether the heading element with id matching the TOC entry's hash is
 * within the upper half of the viewport (a successful scroll-to-heading).
 */
export async function isHeadingInViewportForHref(page, href) {
  const targetId = (href || '').replace(/^#/, '');
  if (!targetId) return false;
  return page.evaluate((id) => {
    // Headings have numeric IDs; need attribute selector
    const el = document.querySelector(`[id="${id}"]`);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.top >= -10 && rect.top < window.innerHeight * 0.6;
  }, targetId);
}
