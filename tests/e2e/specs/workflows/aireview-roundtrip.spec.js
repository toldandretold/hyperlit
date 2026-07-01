import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * AI-review round-trip freeze reproducer.
 *
 * User-reported bug: on a book that has a citation-review AI report, open a
 * citation-review hyperlight (opens the hyperlit-container), click the
 * in-container "See within full report" link (→ the two-segment sub-book
 * `/<book>/AIreview#ref_HL_…`), then press browser BACK.
 *
 * Expected: Back returns to the PARENT book. Observed: Back loops back INTO the
 * /AIreview report (never reaches the parent) and/or the address bar desyncs to
 * `/<book>#HL_…` while the report is still rendered — so Back "freezes". It works
 * for a cycle or two, then corrupts ("until it didn't"), so we loop.
 *
 * The load-bearing invariant asserted after every navigation: the URL's book
 * segment and the rendered `.main-content` id must be the SAME book, and Back
 * from the report must land on the PARENT (not the report again).
 *
 * Requires a book with citation-review hyperlights + an /AIreview sub-book.
 * Parameterized by E2E_AIREVIEW_BOOK (default book_1782863856780). Skips (does
 * not fail) if the preconditions aren't present in this environment.
 */

const BOOK = process.env.E2E_AIREVIEW_BOOK || 'book_1782863856780';
const LOOPS = 3;

/** Book segment of a reader pathname: `/book_x/AIreview` → `book_x/AIreview`, `/book_x` → `book_x`. */
function urlBook(pathname) {
  const m = pathname.match(/^\/(book_[^/]+(?:\/AIreview)?)/);
  return m ? m[1] : null;
}

async function readState(page) {
  return page.evaluate(() => ({
    href: location.href,
    pathname: location.pathname,
    hash: location.hash,
    renderedBook: document.querySelector('.main-content')?.id || null,
    containerOpen: !!document.querySelector('#hyperlit-container.open'),
    stacked: document.querySelectorAll('.hyperlit-container-stacked').length,
    refOverlayActive: !!document.querySelector('#ref-overlay.active'),
  }));
}

/**
 * Find and click a citation-review hyperlight so the container opens showing a
 * "See within full report" link. Scrolls to load chunks until a real HL mark
 * appears. Returns the report-link href, or null if none could be opened.
 */
async function openReportLinkContainer(page) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const clicked = await page.evaluate(() => {
      const marks = [...document.querySelectorAll('.main-content mark')].filter((m) =>
        [...m.classList].some((c) => c.startsWith('HL_') && c !== 'HL_overlap')
      );
      if (!marks.length) return false;
      const mark = marks[0];
      mark.scrollIntoView({ block: 'center' });
      mark.click();
      return true;
    });

    if (clicked) {
      // Wait for the container to open and expose the report link.
      try {
        await page.waitForSelector('#hyperlit-container.open', { timeout: 8000 });
      } catch { /* fall through to retry */ }
      const href = await page.evaluate(() => {
        const a = document.querySelector('#hyperlit-container a[href*="/AIreview#ref_"]');
        return a ? a.getAttribute('href') : null;
      });
      if (href) return href;
      // Container opened without a report link (or didn't open) — close and scroll on.
      await page.evaluate(() => {
        document.getElementById('ref-overlay')?.click();
      });
      await page.waitForTimeout(300);
    }

    // Scroll down to load more chunks, then retry.
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await page.waitForTimeout(600);
  }
  return null;
}

test.describe('AI-review round-trip', () => {
  test('open citation-review highlight → See within full report → Back returns to parent (looped)', async ({ page, spa }) => {
    test.setTimeout(300_000);

    const timeline = [];
    const snap = async (label) => {
      const s = await spa.snapshotPageState(page, label);
      timeline.push(s);
      // eslint-disable-next-line no-console
      console.log(spa.summariseSnapshot(s));
      return s;
    };

    // ── Precondition: the parent book loads and has a citation-review report link ──
    await page.goto(`/${BOOK}`, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(`.main-content[id="${BOOK}"]`, { timeout: 20000 });
      await page.waitForSelector('.main-content mark', { timeout: 20000 });
    } catch {
      test.skip(true, `Book ${BOOK} did not render with highlights — set E2E_AIREVIEW_BOOK to a book with a citation review.`);
    }
    await page.waitForTimeout(1000);
    await snap('parent loaded');

    const firstLink = await openReportLinkContainer(page);
    test.skip(!firstLink, `No "See within full report" link found in ${BOOK} — needs an /AIreview sub-book with citation-review hyperlights.`);
    // eslint-disable-next-line no-console
    console.log('report link:', firstLink);
    // Close the container we opened during precondition discovery.
    await spa.closeAllContainers(page).catch(() => {});
    await page.waitForTimeout(400);

    for (let loop = 1; loop <= LOOPS; loop++) {
      await page.evaluate(() => window.__resetRestorationLog?.());

      // (1) Open a citation-review highlight → container with the report link.
      const reportHref = await openReportLinkContainer(page);
      expect(reportHref, `L${loop}: could not open a citation-review highlight container`).toBeTruthy();
      await snap(`L${loop} container open (parent)`);

      // (2) Click "See within full report" → the /AIreview report.
      await page.locator('#hyperlit-container a[href*="/AIreview#ref_"]').first().click();
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(800);
      const onReport = await readState(page);
      await snap(`L${loop} on report`);

      expect(urlBook(onReport.pathname), `L${loop}: URL should be the /AIreview report`).toBe(`${BOOK}/AIreview`);
      expect(onReport.renderedBook, `L${loop}: rendered content should be the report`).toBe(`${BOOK}/AIreview`);

      // (3) BACK — the core assertion. Must return to the PARENT, in sync.
      await page.goBack();
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(1000);
      const afterBack = await readState(page);
      await snap(`L${loop} after Back`);

      expect(
        urlBook(afterBack.pathname),
        `L${loop}: Back should return to PARENT, not loop into the report. url=${afterBack.href} rendered=${afterBack.renderedBook}`,
      ).toBe(BOOK);
      expect(
        afterBack.renderedBook,
        `L${loop}: rendered content should be the PARENT after Back. url=${afterBack.href}`,
      ).toBe(BOOK);
      // URL↔content must be the same book (the desync that kills Back).
      expect(
        urlBook(afterBack.pathname),
        `L${loop}: URL book must match rendered book (desync). url=${afterBack.href} rendered=${afterBack.renderedBook}`,
      ).toBe(afterBack.renderedBook);

      // No container flood / orphan overlay accumulating across loops.
      expect(afterBack.stacked, `L${loop}: stacked containers flooded`).toBeLessThanOrEqual(1);
      expect(
        afterBack.refOverlayActive && !afterBack.containerOpen,
        `L${loop}: orphan #ref-overlay.active with no open container`,
      ).toBeFalsy();

      await spa.closeAllContainers(page).catch(() => {});
      await page.waitForTimeout(400);
    }

    // Forensic attachments (mirrors cross-book-hypercite-tour.spec.js).
    await test.info().attach('state-timeline.json', {
      body: JSON.stringify(timeline, null, 2),
      contentType: 'application/json',
    });
    await test.info().attach('summary.txt', {
      body: timeline.map(spa.summariseSnapshot).join('\n'),
      contentType: 'text/plain',
    });

    const errors = spa.filterConsoleErrors(page.consoleErrors)
      .filter((e) => !/429.*Too Many Requests/i.test(e))
      .filter((e) => !/cloudflareinsights|cdn-cgi\/rum|Access-Control-Allow-Origin/i.test(e));
    await test.info().attach('forensics.json', {
      body: JSON.stringify({ consoleErrors: errors, pageErrors: page.pageErrors || [] }, null, 2),
      contentType: 'application/json',
    });

    expect(page.pageErrors || [], `Uncaught page errors: ${JSON.stringify(page.pageErrors)}`).toEqual([]);
  });
});
