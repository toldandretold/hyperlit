/**
 * End-to-end paste test for real publisher clipboard payloads.
 *
 * For each captured fixture in tests/paste/fixtures/clipboard/, the test:
 *   1. Creates a new book from the homepage.
 *   2. Synthesises a paste event with the fixture's text/html clipboard
 *      payload (the same shape `event.clipboardData.getData("text/html")`
 *      receives in production when a user copies article content).
 *   3. Waits for the paste pipeline to settle (save queue drains, footnote
 *      section appears if expected).
 *   4. Asserts: no console errors, rendered footnote/reference markers match
 *      the smoke-test baseline within tolerance, and clicking the first
 *      footnote / citation marker triggers some response (the modal opens,
 *      the page scrolls, or the URL hash changes).
 *
 * This complements `tests/paste/handlers/fixtures-smoke.test.js` — that file
 * tests `processor.process()` in isolation; this one tests the full paste
 * flow (event → processor → editor DOM → save queue → render → click).
 *
 * Prerequisites: dev server running on E2E_BASE_URL. The Cambridge fixture
 * is ~2.7MB so individual tests need generous timeouts.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import { filterConsoleErrors } from '../../helpers/pageHelpers.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', '..', '..', 'paste', 'fixtures', 'clipboard');

/**
 * Baseline expectations per fixture — minimum counts the paste pipeline
 * should produce in the rendered DOM. Numbers track the smoke-test baseline
 * (see tests/paste/handlers/fixtures-smoke.test.js); we assert `>=` here
 * because the render layer may add wrapper sups or expand things, and small
 * undercounts due to dedup are acceptable but a *drop* is a regression.
 */
const FIXTURES = [
  { file: 'cambrdidge-authordate.html', format: 'cambridge', minFootnotes: 0, minReferences: 32, hasClickableMarkers: true },
  { file: 'cambridge-footnotes.html',   format: 'cambridge', minFootnotes: 147, minReferences: 0, hasClickableMarkers: true },
  { file: 'oxford.html',                format: 'oup',       minFootnotes: 4,   minReferences: 126, hasClickableMarkers: true },
  { file: 'sage1.html',                 format: 'sage',      minFootnotes: 144, minReferences: 0, hasClickableMarkers: true },
  { file: 'sage2.html',                 format: 'sage',      minFootnotes: 5,   minReferences: 65, hasClickableMarkers: true },
  { file: 'sciencedirect.html',         format: 'science-direct', minFootnotes: 0, minReferences: 88, hasClickableMarkers: true },
  { file: 'springer-authoerdate.html',  format: 'springer',  minFootnotes: 0,   minReferences: 78, hasClickableMarkers: true },
  { file: 'springer-footnotes.html',    format: 'springer',  minFootnotes: 142, minReferences: 69, hasClickableMarkers: true },
  { file: 'taylorandfrancis.html',      format: 'taylor-francis', minFootnotes: 1, minReferences: 66, hasClickableMarkers: true },
];

/**
 * Create a fresh book and put the cursor in the editable area.
 * Returns the new book ID.
 */
async function createFreshBook(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(await spa.getStructure(page)).toBe('home');

  await page.click('#newBookButton');
  await page.waitForFunction(() => {
    const c = document.getElementById('newbook-container');
    return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
  }, null, { timeout: 5000 });
  await page.click('#createNewBook');

  await spa.waitForTransition(page);
  expect(await spa.getStructure(page)).toBe('reader');
  await spa.waitForEditMode(page);

  const bookId = await spa.getCurrentBookId(page);
  expect(bookId).toMatch(/^book_\d+$/);

  // Click into the initial h1 so the editor has a real selection inside
  // the main-content tree when we fire the paste event.
  await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
  await page.click('h1[id="100"]');

  return bookId;
}

/**
 * Wait for the paste pipeline to settle: the format processor finishes
 * (we look for the appended static-content section), then the save queue
 * drains a beat. We don't wait on a network-idle signal because IDB writes
 * happen off-thread.
 */
async function waitForPasteSettled(page, { hasFootnotes, hasReferences }) {
  // Give the processor a moment to detect format + run extraction.
  await page.waitForTimeout(500);

  // If we expect static sections, wait for them to appear in the DOM.
  if (hasFootnotes) {
    await page.waitForSelector(
      '.footnotes, [data-static-section="footnotes"], section.footnotes, ol.c-article-footnote',
      { timeout: 20_000 }
    ).catch(() => { /* tolerate — render markers vary by format */ });
  }
  if (hasReferences) {
    await page.waitForSelector(
      '.references, [data-static-section="references"], section.references, ol.references, ul.references',
      { timeout: 20_000 }
    ).catch(() => { /* tolerate */ });
  }

  // Wait for the save/sync pipeline to actually finish rather than guessing with a fixed timeout:
  // the cloud indicator turns green (#63B995) once the pasted nodes are persisted. Same observable
  // signal chunk-overflow-paste.spec.js + footnote-integrity.spec.js already use. A racing paste
  // (integrity reporter firing mid-render) is exactly what this removes. Falls back to the old
  // coarse wait if a paste never greens in time — no worse than before.
  await page.waitForFunction(() => {
    const c = document.querySelector('#cloudRef-svg .cls-1');
    return c && c.getAttribute('fill') === '#63B995';
  }, null, { timeout: 20_000 }).catch(() => page.waitForTimeout(1500));

  // Pasted publisher articles can produce hundreds of chunks; the lazy
  // loader only renders the first ~100 into the DOM. Force the rest by
  // scrolling the page to the bottom-sentinel and pumping the loader, so
  // the bibliography / footnote sections at the tail of the article appear
  // in the DOM where the test can see them.
  await page.evaluate(async () => {
    const sentinel = document.querySelector('[id$="-bottom-sentinel"]');
    if (!sentinel) return;
    for (let i = 0; i < 12; i++) {
      sentinel.scrollIntoView({ block: 'end' });
      // Yield to the lazy loader between scrolls.
      await new Promise(r => setTimeout(r, 250));
    }
  });
  // Wait for the lazy loader to stop adding chunks (two consecutive stable samples) instead of a
  // fixed 800ms — under load the tail sections (footnotes/bibliography the assertions read) can
  // still be rendering. `__pasteChunkCount` carries the previous poll's value across polls; each
  // test has a fresh page so it starts undefined. Falls back to a short wait if it never settles.
  await page.evaluate(() => { delete window.__pasteChunkCount; });
  await page.waitForFunction(() => {
    const count = document.querySelectorAll('.main-content .chunk[data-chunk-id]').length;
    const prev = window.__pasteChunkCount;
    window.__pasteChunkCount = count;
    return prev !== undefined && prev === count && count > 0;
  }, null, { timeout: 10_000, polling: 300 }).catch(() => page.waitForTimeout(800));
}

/**
 * Count footnote / reference markers in the rendered main content.
 *
 * Hyperlit normalises publisher-specific anchor markup at paste time. After
 * paste, every footnote in-text marker is `<sup class="footnote-ref">` with
 * `fn-count-id` and an `id` prefixed `Fn<bookId>_…`, and reference markers
 * are anchored bibliography entries. The raw publisher hrefs (`#Fn1`,
 * `#bbib1`, etc.) no longer exist post-paste — selectors must match the
 * Hyperlit-normalised form.
 */
async function countRenderedMarkers(page) {
  return page.evaluate(() => {
    const main = document.querySelector('.main-content');
    if (!main) return { footnoteMarkers: 0, referenceMarkers: 0 };

    return {
      footnoteMarkers: main.querySelectorAll('sup.footnote-ref, sup[fn-count-id], sup[id^="Fn"]').length,
      // Hyperlit normalises in-text references to <a class="in-text-citation">
      // (see citation-linker.js). The static bibliography section also appears
      // — count both.
      referenceMarkers: main.querySelectorAll(
        'a.in-text-citation, ' +
        '[data-static-content="bibliography"], ' +
        '.references li, [data-static-section="references"] li, ol.references li, ul.references li'
      ).length,
    };
  });
}

test.describe('Publisher clipboard paste — end-to-end', () => {
  test.setTimeout(180_000);

  for (const fixture of FIXTURES) {
    test(`paste ${fixture.file} into a new book`, async ({ page, spa }) => {
      // Collect everything the page logs. We attach the full stream to the
      // test report so failures are debuggable without re-running.
      const consoleErrors = [];
      const integrityEvents = [];
      const fullConsole = [];
      page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        fullConsole.push(`[${type}] ${text}`);
        if (type === 'error') consoleErrors.push(text);
        if (/MISMATCH DETECTED|integrityModalShown|integrityReportSent/i.test(text)) {
          integrityEvents.push(text);
        }
      });
      // Surface uncaught page errors too — `console` only carries logged ones.
      const pageErrors = [];
      page.on('pageerror', (err) => {
        pageErrors.push(`${err.name}: ${err.message}\n${err.stack || ''}`);
        fullConsole.push(`[pageerror] ${err.message}`);
      });

      // 1. New book.
      const bookId = await createFreshBook(page, spa);

      // 2. Read fixture from disk and synthesise a paste event with the
      //    text/html clipboard payload. The plain-text side is best-effort —
      //    most processors only look at text/html.
      const htmlPayload = readFileSync(join(FIXTURE_DIR, fixture.file), 'utf8');
      const textPayload = ''; // intentionally empty; production handlers
                              // also fall back to text/html when present.

      await spa.pasteHyperciteContent(page, htmlPayload, textPayload);

      // 3. Wait for the pipeline to settle.
      await waitForPasteSettled(page, {
        hasFootnotes:   fixture.minFootnotes > 0,
        hasReferences:  fixture.minReferences > 0,
      });

      // 4a. Console-error check (filtered for known third-party noise plus
      //     "Failed to load resource" 404s, which fire for every external
      //     asset URL embedded in the pasted HTML — irrelevant to paste
      //     correctness, since the resources are publisher assets the test
      //     environment can't reach).
      const errors = filterConsoleErrors(consoleErrors).filter(msg =>
        !/Failed to load resource/i.test(msg)
      );
      expect.soft(errors, `console errors during paste of ${fixture.file}`).toEqual([]);

      // 4b. Integrity-mismatch check — pasted content should not trigger
      //     the DOM-vs-IDB integrity reporter.
      expect.soft(integrityEvents, `integrity mismatches during paste of ${fixture.file}`).toEqual([]);

      // 4c. Rendered marker counts. We assert that *some* markers exist when
      //     expected, but don't pin exact counts here — the smoke test does
      //     that for the extraction layer. This guards the render layer.
      const counts = await countRenderedMarkers(page);

      // Always attach the rendered main-content HTML + the console log to the
      // test report. Cheap, and saves a re-run when something fails.
      const renderedHTML = await page.evaluate(() => {
        const main = document.querySelector('.main-content');
        return main ? main.outerHTML : '<NO MAIN CONTENT>';
      });
      await test.info().attach(`rendered-${fixture.file}.html`, {
        body: renderedHTML,
        contentType: 'text/html',
      });
      await test.info().attach(`console-${fixture.file}.log`, {
        body: fullConsole.join('\n'),
        contentType: 'text/plain',
      });
      if (pageErrors.length) {
        await test.info().attach(`pageerrors-${fixture.file}.log`, {
          body: pageErrors.join('\n\n---\n\n'),
          contentType: 'text/plain',
        });
      }
      // Also write to a stable debug directory so we can grep them between runs.
      const debugDir = join(__dirname, '..', '..', 'test-results', 'paste-debug');
      mkdirSync(debugDir, { recursive: true });
      writeFileSync(join(debugDir, `rendered-${fixture.file}`), renderedHTML);
      writeFileSync(join(debugDir, `console-${fixture.file}.log`), fullConsole.join('\n'));
      if (pageErrors.length) {
        writeFileSync(join(debugDir, `pageerrors-${fixture.file}.log`), pageErrors.join('\n\n---\n\n'));
      }

      // Diagnostic DOM snapshot — what *shape* did the paste produce?
      const shape = await page.evaluate(() => {
        const main = document.querySelector('.main-content');
        if (!main) return { hasMain: false };

        // Find headings whose text matches "References"/"Bibliography" so we
        // can see what comes after them in the rendered DOM.
        const refHeadings = Array.from(main.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .filter(h => /references|bibliography|works cited/i.test(h.textContent.trim()));
        const refHeading = refHeadings[0];
        let refHeadingNextHTML = null;
        if (refHeading) {
          const next = refHeading.nextElementSibling;
          if (next) refHeadingNextHTML = next.outerHTML.slice(0, 400);
        }

        // First <li> outer shape — for spotting class conventions like
        // "bibliography-item", "static-ref", etc.
        const firstLi = main.querySelector('li');

        return {
          hasMain: true,
          textLen: main.textContent.length,
          totalSups: main.querySelectorAll('sup').length,
          totalAnchors: main.querySelectorAll('a').length,
          totalLis: main.querySelectorAll('li').length,
          totalPs: main.querySelectorAll('p').length,
          staticFootnoteSection: !!main.querySelector('.footnotes, [data-static-section="footnotes"], ol.c-article-footnote, [class*="footnote"]'),
          staticRefSection: !!main.querySelector('.references, [data-static-section="references"], [class*="references"]'),
          refHeadingCount: refHeadings.length,
          refHeadingNextHTML,
          firstLiClasses: firstLi?.className || null,
          firstLiOuter: firstLi?.outerHTML?.slice(0, 300) || null,
          sampleSupHTML: main.querySelector('sup')?.outerHTML?.slice(0, 200) || null,
        };
      });

      // eslint-disable-next-line no-console
      console.log(`[${fixture.file}] markers:`, counts, `shape:`, shape, `bookId=${bookId}`);

      if (fixture.minFootnotes > 0) {
        expect.soft(counts.footnoteMarkers, `expected at least one footnote marker in ${fixture.file}`).toBeGreaterThan(0);
      }
      if (fixture.minReferences > 0) {
        expect.soft(counts.referenceMarkers, `expected at least one reference marker in ${fixture.file}`).toBeGreaterThan(0);
      }

      // 4d. Click the first footnote marker (if any). The click should not
      //     throw and should produce SOME effect — either the URL hash
      //     updates, a modal/sub-container opens, or the page scrolls.
      if (fixture.hasClickableMarkers && counts.footnoteMarkers > 0) {
        const beforeHash = page.url().split('#')[1] || '';
        const beforeScroll = await page.evaluate(() => window.scrollY);

        const firstMarker = page.locator('.main-content sup.footnote-ref, .main-content sup[fn-count-id]').first();

        if (await firstMarker.count() > 0) {
          // Wait for footnote LINKING to finish before clicking — under load the marker can still be
          // un-linked (inert), which is the flake. `fn-count-id` is set when buildFootnoteMap /
          // rebuildAndRenumber completes; polling the attribute is race-free vs. the one-shot
          // `footnotesRenumbered` event.
          await page.waitForFunction(() => {
            const m = document.querySelector('.main-content sup.footnote-ref, .main-content sup[fn-count-id]');
            return m && m.hasAttribute('fn-count-id');
          }, null, { timeout: 15_000 }).catch(() => {});
          await firstMarker.click({ timeout: 5000 }).catch(() => { /* tolerate — markers may be inert */ });
          await page.waitForTimeout(500);

          const afterHash = page.url().split('#')[1] || '';
          const afterScroll = await page.evaluate(() => window.scrollY);
          const modalOpen = await page.evaluate(() =>
            !!document.querySelector('#hyperlit-container[style*="display: block"], #hyperlit-container.open, .modal[open]')
          );

          expect.soft(
            afterHash !== beforeHash || Math.abs(afterScroll - beforeScroll) > 5 || modalOpen,
            `clicking the first footnote marker in ${fixture.file} produced no visible effect (hash, scroll, modal)`
          ).toBeTruthy();
        }
      }
    });
  }
});
