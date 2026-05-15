import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from '../../fixtures/navigation.fixture.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EPUB_PATH = path.join(REPO_ROOT, 'tests/conversion/import-samples/dropbox/rockhill.epub');

/**
 * Cross-book hypercite stress tour.
 *
 * Reproduces the "nightmare scenario":
 *   1. Long Book A is imported. A hypercite is created on a deep paragraph
 *      (mid-book, post-lazy-load), capturing the underline `<u>` target.
 *   2. Long Book B is imported. The hypercite is pasted on a deep paragraph
 *      reached via the TOC (table-of-contents) — TOC is otherwise uncovered.
 *   3. The tour then runs N loops of: TOC nav → footnote-stress (prime the
 *      hyperlit-container lifecycle) → click pasted hypercite → SPA nav to
 *      Book A → assert the scroll-to-target landed in viewport and the
 *      container stack didn't flood → goBack → goForward → rapid b/f bursts.
 *
 * Bugs we are hunting:
 *   - Scroll-to-target silently fails (user-reported)
 *   - Hyperlit containers cascade open when restoration collides with
 *     click-open (user-reported "hella containers open and it glitches wild")
 *
 * Forensic capture: every interaction boundary pushes a snapshot to
 * `timeline`. The restoration spy in `restorationSpy.js` records every
 * hyperlit-container lifecycle event into `window.__restorationLog`, which
 * is tailed into each snapshot. On test end, three artifacts are attached:
 *   - state-timeline.json: full ordered snapshots
 *   - summary.txt: one-line-per-snapshot human-readable trace
 *   - anomalies.json: detected container-floods + restoration races
 *
 * Assertions are deliberately strict — initial runs are expected to fail
 * if the user's bug reproduces. Forensic artifacts pinpoint the phase.
 */

test.describe('Cross-book hypercite stress tour', () => {
  test('imports → TOC → footnotes → cross-book hypercite → back/forward (looped)', async ({ page, spa }) => {
    test.setTimeout(900_000);

    const timeline = [];
    const snap = async (label) => {
      const s = await spa.snapshotPageState(page, label);
      timeline.push(s);
      // eslint-disable-next-line no-console
      console.log(spa.summariseSnapshot(s));
      return s;
    };

    // ───────────────────────────────────────────────────────────────
    // PHASE A: Import Book A and create a deep hypercite
    // ───────────────────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await snap('start home');

    const { bookId: bookAId } = await spa.importMarkdownBook(page, spa, {
      filePath: EPUB_PATH,
    });
    expect(bookAId).toBeTruthy();
    await snap(`bookA imported ${bookAId}`);

    // Enter edit mode
    if (!(await page.evaluate(() => !!window.isEditing))) {
      await page.click('#editButton');
      await spa.waitForEditMode(page);
    }

    // Navigate via TOC to a deep chapter and create a hypercite on that paragraph
    await spa.openToc(page);
    const tocEntriesA = await spa.getTocEntries(page);
    expect(tocEntriesA.length).toBeGreaterThan(2);
    const deepEntryA = tocEntriesA[Math.min(tocEntriesA.length - 1, Math.floor(tocEntriesA.length * 0.7))];
    await spa.clickTocEntry(page, deepEntryA.index);
    await snap(`bookA toc-nav ${deepEntryA.text}`);

    // Find the first paragraph (with reasonable text length) after the landed
    // heading and select a stable substring for the hypercite. Works for any
    // book — no ANCHOR marker needed.
    const deepParaInfoA = await page.evaluate((hash) => {
      const targetId = (hash || '').replace(/^#/, '');
      const heading = document.querySelector(`[id="${targetId}"]`);
      if (!heading) return null;
      let p = heading.nextElementSibling;
      while (p && (p.tagName !== 'P' || (p.textContent || '').trim().length < 40)) p = p.nextElementSibling;
      if (!p) return null;
      const tag = p.tagName.toLowerCase();
      if (p.id) return { selector: `${tag}[id="${p.id}"]` };
      const parent = p.parentElement;
      const siblings = parent.querySelectorAll(`:scope > ${tag}`);
      const idx = [...siblings].indexOf(p);
      return { selector: `.main-content ${tag}:nth-of-type(${idx + 1})` };
    }, deepEntryA.href);
    expect(deepParaInfoA, `no paragraph found after heading ${deepEntryA.href}`).not.toBeNull();

    const deepTextA = (await page.locator(deepParaInfoA.selector).textContent()).trim();
    const hcLen = Math.min(30, Math.max(15, deepTextA.length - 10));
    const hcStart = 0;
    const hcEnd = hcStart + hcLen;
    await spa.selectTextInElement(page, deepParaInfoA.selector, hcStart, hcEnd);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hypercite');
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 5000 });
    await snap('bookA hypercite created');

    const clipboard = await page.evaluate(() => {
      const uEl = document.querySelector('u[id^="hypercite_"].single');
      const hcId = uEl.id;
      // window.book is unset after the import pathway — derive from URL or .main-content
      const bookIdMatch = location.pathname.match(/\/(book_\d+[\w-]*)/);
      const bookId = window.book
        || (bookIdMatch ? bookIdMatch[1] : null)
        || document.querySelector('.main-content')?.id;
      const selectedText = uEl.textContent;
      const origin = window.location.origin;
      const href = `${origin}/${bookId}#${hcId}`;
      const html = `'${selectedText}'⁠<a href="${href}" id="${hcId}" class="open-icon">↗</a>`;
      const text = `'${selectedText}' [↗](${href})`;
      return { hyperciteId: hcId, html, text, bookIdUsed: bookId };
    });
    expect(clipboard.hyperciteId).toMatch(/^hypercite_/);
    expect(clipboard.bookIdUsed, 'bookId for clipboard href must be valid').toMatch(/^book_\d+/);

    // Wait for cloud sync to go green so Book A's IndexedDB write is durable
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 15000 }).catch(() => { /* fallback to time wait */ });
    await page.waitForTimeout(500);

    // Exit edit mode
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    await snap('bookA exit edit');

    // ───────────────────────────────────────────────────────────────
    // PHASE B: Import Book B, navigate deep via TOC, paste hypercite
    // ───────────────────────────────────────────────────────────────
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);
    await snap('home before bookB');

    const { bookId: bookBId } = await spa.importMarkdownBook(page, spa, {
      filePath: EPUB_PATH,
    });
    expect(bookBId).toBeTruthy();
    expect(bookBId).not.toBe(bookAId);
    await snap(`bookB imported ${bookBId}`);

    if (!(await page.evaluate(() => !!window.isEditing))) {
      await page.click('#editButton');
      await spa.waitForEditMode(page);
    }

    await spa.openToc(page);
    const tocEntriesB = await spa.getTocEntries(page);
    expect(tocEntriesB.length).toBeGreaterThan(2);
    const deepEntryB = tocEntriesB[Math.min(tocEntriesB.length - 1, Math.floor(tocEntriesB.length * 0.7))];
    await spa.clickTocEntry(page, deepEntryB.index);
    await snap(`bookB toc-nav ${deepEntryB.text}`);

    // Position cursor at end of the first reasonably-sized paragraph after
    // the landed heading.
    const pastePositioned = await page.evaluate((hash) => {
      const targetId = (hash || '').replace(/^#/, '');
      const heading = document.querySelector(`[id="${targetId}"]`);
      if (!heading) return false;
      let p = heading.nextElementSibling;
      while (p && (p.tagName !== 'P' || (p.textContent || '').trim().length < 40)) p = p.nextElementSibling;
      if (!p) return false;
      const range = document.createRange();
      range.selectNodeContents(p);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.focus();
      return true;
    }, deepEntryB.href);
    expect(pastePositioned).toBe(true);
    await page.waitForTimeout(300);

    await spa.pasteHyperciteContent(page, clipboard.html, clipboard.text);
    await page.waitForSelector('.main-content a.open-icon[id^="hypercite_"]', { timeout: 10000 });
    await snap('bookB hypercite pasted');

    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 15000 }).catch(() => {});
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    await snap('bookB exit edit');

    // ───────────────────────────────────────────────────────────────
    // PHASE C: The tour. Loop N times to detect state accumulation.
    // ───────────────────────────────────────────────────────────────
    const TOUR_LOOPS = 2;
    for (let loop = 1; loop <= TOUR_LOOPS; loop++) {
      await page.evaluate(() => window.__resetRestorationLog?.());

      // (1) TOC stress nav — somewhere other than where the hypercite was pasted
      await spa.openToc(page);
      const tocB = await spa.getTocEntries(page);
      const stressIdx = Math.floor(tocB.length * 0.3);
      const stressEntry = tocB[stressIdx];
      await spa.clickTocEntry(page, stressEntry.index);
      await snap(`L${loop} bookB stress-toc ${stressEntry.text}`);

      // (2) Footnote stress: open & close a few footnotes
      const fn = await spa.openAndCloseFootnotes(page, 3);
      await snap(`L${loop} fn-stress ${fn.opened}/${fn.available}`);
      await spa.closeAllContainers(page);
      await snap(`L${loop} after closeAll-1`);

      // (3) Stack a couple of footnotes WITHOUT closing — primes containerStack
      const stack = await spa.openFootnoteStack(page, 2);
      await snap(`L${loop} stacked ${stack.opened}`);

      // Then close back to base before clicking hypercite (so we have a clean
      // history.state.containerStack going into the cross-book nav). Note:
      // tapping a footnote toggles `.perimeter-hidden` on the perimeter
      // containers (a deliberate "tap empty space to hide nav" feature in
      // togglePerimeterButtons.js); that's expected, not a bug. The next
      // `openToc` call inside this loop dispatches a tap on .main-content
      // to bring the perimeter back, mirroring real-user behaviour.
      await spa.closeAllContainers(page);
      await snap(`L${loop} after closeAll-2`);

      // (4) Navigate back to the chapter where the hypercite was pasted, so
      // its chunk re-loads and the link is in DOM again.
      await spa.openToc(page);
      const tocBack = await spa.getTocEntries(page);
      const backEntry = tocBack.find(e => e.text === deepEntryB.text) || tocBack[Math.floor(tocBack.length * 0.7)];
      await spa.clickTocEntry(page, backEntry.index);
      await snap(`L${loop} bookB toc-back ${backEntry.text}`);

      // Wait for the paste link to be back in the DOM (the chunk that contains it must load)
      try {
        await page.waitForSelector('.main-content a.open-icon[id^="hypercite_"]', { timeout: 15000 });
      } catch (err) {
        // Capture state for forensics before failing
        const diag = await page.evaluate(() => ({
          mainContentLength: document.querySelector('.main-content')?.textContent?.length || 0,
          allOpenIcons: document.querySelectorAll('a.open-icon').length,
          hyperciteAnchorsAnywhere: document.querySelectorAll('a[id^="hypercite_"]').length,
        }));
        await snap(`L${loop} paste-link-MISSING ${JSON.stringify(diag)}`);
        throw new Error(`L${loop}: pasted hypercite link not in DOM after toc-back to "${backEntry.text}". Diag: ${JSON.stringify(diag)}`);
      }

      // (5) Click pasted hypercite link → navigate to Book A
      await page.evaluate(() => window.__resetRestorationLog?.());
      await snap(`L${loop} pre-hypercite-click`);

      const pasted = page.locator('.main-content a.open-icon[id^="hypercite_"]').first();
      await pasted.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await pasted.click();

      await page.waitForFunction(() => {
        const c = document.getElementById('hyperlit-container');
        return c && c.classList.contains('open');
      }, null, { timeout: 10000 });
      await snap(`L${loop} ref-container open over bookB`);

      // "See in source text"
      const seeBtn = page.locator('#hyperlit-container a.see-in-source-btn').first();
      if (await seeBtn.count() > 0) {
        await seeBtn.click();
      } else {
        await page.getByText('See in source text').first().click();
      }
      await spa.waitForTransition(page);
      await page.waitForTimeout(800); // allow restoration + scroll to settle
      const landedSnap = await snap(`L${loop} landed-on-bookA`);

      // ── Critical assertions ──
      expect(landedSnap.bookId, `L${loop} expected bookA after hypercite`).toBe(bookAId);
      expect(landedSnap.url).toContain(bookAId);

      // (a) The `<u>` target is in viewport — scroll-to-target worked
      const scrollInfo = await page.evaluate((hcId) => {
        const u = document.querySelector(`u[id="${hcId}"]`);
        if (!u) return { found: false };
        const rect = u.getBoundingClientRect();
        return {
          found: true,
          top: rect.top,
          windowH: window.innerHeight,
          inViewport: rect.top >= -50 && rect.top < window.innerHeight - 50,
        };
      }, clipboard.hyperciteId);
      // eslint-disable-next-line no-console
      console.log(`L${loop} scrollInfo:`, JSON.stringify(scrollInfo));
      expect(scrollInfo.found, `L${loop} <u> not found in bookA`).toBe(true);
      expect(scrollInfo.inViewport, `L${loop} <u> not in viewport (top=${scrollInfo.top}, windowH=${scrollInfo.windowH})`).toBe(true);

      // (b) Container stack must not flood
      expect(landedSnap.stackedContainersTotal, `L${loop} container flood on landing`).toBeLessThanOrEqual(1);

      // ── Back / Forward ──
      await page.goBack();
      await page.waitForTimeout(500);
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(300);
      const backSnap = await snap(`L${loop} after-back`);

      await page.goForward();
      await page.waitForTimeout(500);
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(300);
      await snap(`L${loop} after-forward`);

      // (c) Rapid back/forward — the "wack" reproducer
      for (let r = 0; r < 3; r++) {
        await page.goBack();
        await page.waitForTimeout(250);
        await page.goForward();
        await page.waitForTimeout(250);
      }
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(800);
      const rapidSnap = await snap(`L${loop} after-rapid-bf`);

      // Loose assertions on rapid b/f — no exponential growth, no orphan containers
      expect(rapidSnap.stackedContainersTotal, `L${loop} stacked containers grew during rapid b/f`).toBeLessThanOrEqual(2);

      // Record orphan-overlay state — rapid b/f can leave #ref-overlay.active
      // even though no container is "open", blocking later clicks. This is a
      // strong signal of the user-reported glitch.
      const overlayState = await page.evaluate(() => ({
        refOverlayActive: !!document.querySelector('#ref-overlay.active'),
        tocOverlayActive: !!document.querySelector('#toc-overlay.active'),
        bodyOpenClass: document.body.classList.contains('hyperlit-container-open'),
        anyOpenContainer: !!document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open'),
      }));
      if (overlayState.refOverlayActive && !overlayState.anyOpenContainer) {
        // eslint-disable-next-line no-console
        console.log(`L${loop} ORPHAN OVERLAY after rapid b/f:`, JSON.stringify(overlayState));
        // Force-close so the rest of the test can continue
        await page.evaluate(() => {
          document.getElementById('ref-overlay')?.classList.remove('active');
          document.getElementById('toc-overlay')?.classList.remove('active');
          document.body.classList.remove('hyperlit-container-open');
        });
        // Record as an anomaly in the timeline
        timeline.push({
          ...rapidSnap,
          label: `L${loop} ORPHAN-OVERLAY`,
          orphanOverlay: overlayState,
        });
      }
      await spa.closeAllContainers(page);

      // Navigate home and back into Book B for next loop
      await spa.navigateToHome(page);
      await spa.waitForTransition(page);
      await snap(`L${loop} home`);

      const wentBack = await page.evaluate((bId) => {
        const cards = [...document.querySelectorAll('.libraryCard a')];
        const target = cards.find(a => (a.getAttribute('href') || '').includes(bId));
        if (target) { target.click(); return true; }
        return false;
      }, bookBId);
      if (wentBack) {
        await spa.waitForTransition(page);
      } else {
        await page.goto(`/${bookBId}`);
        await page.waitForLoadState('networkidle');
      }
      await snap(`L${loop} re-entered-bookB`);
    }

    // ───────────────────────────────────────────────────────────────
    // PHASE D: Final forensic dump + invariants
    // ───────────────────────────────────────────────────────────────
    const anomalies = spa.detectAnomalies(timeline, { stackJumpThreshold: 1 });
    const races = spa.detectRestorationRace(timeline, { windowMs: 1500 });
    // Filter 429s on /reading-position — the dev rate limiter trips under the
    // rapid-fire navigation pattern this tour uses. Test-environment noise,
    // not the bug we're hunting.
    const errors = spa.filterConsoleErrors(page.consoleErrors)
      .filter(e => !/429.*Too Many Requests/i.test(e));
    const pageErrors = page.pageErrors || [];

    await test.info().attach('state-timeline.json', {
      body: JSON.stringify(timeline, null, 2),
      contentType: 'application/json',
    });
    await test.info().attach('summary.txt', {
      body: timeline.map(spa.summariseSnapshot).join('\n'),
      contentType: 'text/plain',
    });
    await test.info().attach('forensics.json', {
      body: JSON.stringify({ anomalies, races, consoleErrors: errors, pageErrors }, null, 2),
      contentType: 'application/json',
    });

    if (errors.length || anomalies.length || races.length || pageErrors.length) {
      // eslint-disable-next-line no-console
      console.log('\n=== FORENSIC REPORT ===');
      // eslint-disable-next-line no-console
      console.log(`Console errors: ${errors.length}`);
      errors.forEach(e => console.log('  err:', String(e).slice(0, 240)));
      // eslint-disable-next-line no-console
      console.log(`Page errors: ${pageErrors.length}`);
      pageErrors.forEach(e => console.log('  pageerr:', String(e).slice(0, 240)));
      // eslint-disable-next-line no-console
      console.log(`Anomalies: ${anomalies.length}`);
      anomalies.forEach(a => console.log('  anomaly:', JSON.stringify(a)));
      // eslint-disable-next-line no-console
      console.log(`Restoration races: ${races.length}`);
      races.forEach(r => console.log('  race:', JSON.stringify(r)));
      // eslint-disable-next-line no-console
      console.log('========================\n');
    }

    expect(anomalies, `Detected anomalies: ${JSON.stringify(anomalies)}`).toEqual([]);
    expect(races, `Detected restoration races: ${JSON.stringify(races)}`).toEqual([]);
    expect(errors, `Unfiltered console errors: ${JSON.stringify(errors)}`).toEqual([]);
    expect(pageErrors, `Page errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
  });
});
