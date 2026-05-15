/**
 * Stress helpers — drive the app through interaction sequences that prime
 * history.state.containerStack and exercise hyperlit-container lifecycle.
 */

/**
 * Open N footnote refs in sequence, waiting for each container open, then
 * closing each before moving on. Returns { attempted, opened, available }.
 * If the imported book has no footnote refs, returns { ..., opened: 0 } and
 * the caller can decide whether to skip downstream assertions.
 */
export async function openAndCloseFootnotes(page, n = 5) {
  const available = await page.evaluate(() => {
    return document.querySelectorAll(
      '.main-content sup.footnote-ref, .main-content a.footnote-ref, .main-content sup[fn-count-id]'
    ).length;
  });

  const actual = Math.min(available, n);
  let opened = 0;

  for (let i = 0; i < actual; i++) {
    // Re-query each iteration in case DOM mutated
    const ref = await page.locator(
      '.main-content sup.footnote-ref, .main-content a.footnote-ref, .main-content sup[fn-count-id]'
    ).nth(i);

    try {
      await ref.scrollIntoViewIfNeeded({ timeout: 3000 });
      await ref.click({ force: true, timeout: 5000 });
      await page.waitForFunction(() => {
        const c = document.getElementById('hyperlit-container');
        return c && c.classList.contains('open');
      }, null, { timeout: 8000 });
      opened++;
    } catch (err) {
      // Footnote ref couldn't be clicked or container didn't open — log and continue
      // (we want stress to be best-effort, not a failure mode)
      // eslint-disable-next-line no-console
      console.warn(`stress: footnote ${i} skipped: ${err.message}`);
      continue;
    }

    await page.waitForTimeout(150);

    // Close the container via overlay click
    await page.evaluate(() => {
      const overlay = document.getElementById('ref-overlay');
      if (overlay) overlay.click();
    });
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return !c || !c.classList.contains('open');
    }, null, { timeout: 5000 }).catch(() => { /* best-effort */ });
    await page.waitForTimeout(100);
  }

  return { attempted: actual, opened, available };
}

/**
 * Open N footnotes WITHOUT closing them — produces a stacked container
 * cascade so history.state.containerStack ends up with multiple layers.
 * Used to set up the "lots of history state" scenario before testing
 * navigation away.
 */
export async function openFootnoteStack(page, n = 3) {
  const opened = [];
  for (let i = 0; i < n; i++) {
    const refs = await page.evaluate(() => {
      // Look for footnote refs in the CURRENT TOP container if one is open,
      // otherwise in main-content
      const topStacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')].pop();
      const root = topStacked || document.getElementById('hyperlit-container')?.classList.contains('open')
        ? (topStacked || document.getElementById('hyperlit-container'))
        : document.querySelector('.main-content');
      if (!root) return [];
      return [...root.querySelectorAll('sup.footnote-ref, a.footnote-ref, sup[fn-count-id]')].map((el, idx) => idx);
    });
    if (!refs.length) break;

    const beforeDepth = await page.evaluate(() => {
      return document.querySelectorAll('.hyperlit-container-stacked').length
        + (document.querySelector('#hyperlit-container.open') ? 1 : 0);
    });

    const ok = await page.evaluate(() => {
      const topStacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')].pop();
      const root = topStacked
        || (document.getElementById('hyperlit-container')?.classList.contains('open')
              ? document.getElementById('hyperlit-container')
              : document.querySelector('.main-content'));
      if (!root) return false;
      const ref = root.querySelector('sup.footnote-ref, a.footnote-ref, sup[fn-count-id]');
      if (!ref) return false;
      ref.click();
      return true;
    });
    if (!ok) break;

    try {
      await page.waitForFunction((before) => {
        const now = document.querySelectorAll('.hyperlit-container-stacked').length
          + (document.querySelector('#hyperlit-container.open') ? 1 : 0);
        return now > before;
      }, beforeDepth, { timeout: 5000 });
      opened.push(i);
      await page.waitForTimeout(200);
    } catch {
      break;
    }
  }
  return { opened: opened.length };
}

/**
 * Close all open hyperlit containers by clicking the topmost overlay.
 * Used to clean up between stress phases without losing track of state.
 */
export async function closeAllContainers(page) {
  let safety = 10;
  while (safety-- > 0) {
    const anyOpen = await page.evaluate(() => {
      return !!document.querySelector('#hyperlit-container.open')
        || !!document.querySelector('.hyperlit-container-stacked.open');
    });
    if (!anyOpen) return;

    await page.evaluate(() => {
      // Click the topmost overlay (stacked overlay if any, else #ref-overlay)
      const stackedOverlay = [...document.querySelectorAll('.ref-overlay-stacked')].pop();
      const overlay = stackedOverlay || document.getElementById('ref-overlay');
      if (overlay) overlay.click();
    });
    await page.waitForTimeout(300);
  }
}
