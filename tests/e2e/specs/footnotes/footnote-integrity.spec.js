/**
 * Footnote integrity reproduction harness.
 *
 * Designed to make the iPhone-side DOM/IDB footnote divergence (DOM showed
 * "10", IDB stored "8" for the same sup) deterministically reproducible in
 * headless Playwright, so we can identify which of the three independent
 * representations (stored HTML, node.footnotes arrays, in-memory map) is
 * the canonical one — before writing any fix.
 *
 * Six scenarios (A–F). Each one:
 *   1. Snapshots footnote state (IDB + map + diag) at scenario start
 *   2. Performs the suspected-failure user action
 *   3. Snapshots state at scenario end
 *   4. Reports violations + integrity events as a JSON attachment
 *
 * The point is NOT for these to all pass on the first run — failures are the
 * data we need. Each test attaches its full snapshot to test results so we
 * can see *which representation diverged from which* and at what step.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import { importFootnoteHeavyBook } from '../../helpers/sourceFixtures.js';
import {
  enableFnDiagScript,
  snapshotFootnoteState,
  summariseSnapshot,
} from '../../helpers/idbInspect.js';

// Enable the in-app __fnDiag hook for every test in this file. Doesn't change
// behaviour — just exposes the in-memory map and tracks renderer mutations.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(enableFnDiagScript);
});

/**
 * Attach a snapshot to the test report. Use at every checkpoint so a failing
 * run gives us the full trail.
 */
async function checkpoint(page, bookId, label) {
  const snap = await snapshotFootnoteState(page, bookId);
  const summary = summariseSnapshot(snap);
  // eslint-disable-next-line no-console
  console.log(`[checkpoint] ${label}`, summary);
  await test.info().attach(`snapshot-${label.replace(/\W+/g, '_')}.json`, {
    body: JSON.stringify({ label, summary, violations: snap.violations, diag: snap.diag }, null, 2),
    contentType: 'application/json',
  });
  return snap;
}

/**
 * Filter integrity events captured by integrityCaptureScript to actionable
 * mismatches (not just warns from app logging).
 */
function collectIntegrityIssues(events) {
  return events.filter(e =>
    (e.kind === 'integrityWarn' && /MISMATCH DETECTED/.test(e.msg || ''))
    || e.kind === 'integrityModalShown'
    || e.kind === 'integrityReportSent'
  );
}

test.describe('Footnote integrity — reproduction harness', () => {
  test.setTimeout(180_000);

  test('A. Import-only — invariants should hold immediately after import', async ({ page, spa }) => {
    await page.evaluate(() => window.__resetIntegrityEvents?.());

    const { bookId, footnoteCount } = await importFootnoteHeavyBook(page, spa, {
      title: 'Scenario A',
      chapters: 4,
      paragraphsPerChapter: 6,
      footnotesPerChapter: 4,        // 16 footnotes total
    });
    // eslint-disable-next-line no-console
    console.log(`Imported book ${bookId} with ${footnoteCount} footnotes`);

    // Give background download + initial renumber a chance to settle
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    const snap = await checkpoint(page, bookId, 'A_post_import');
    const integrity = collectIntegrityIssues(await spa.snapshotIntegrity(page));

    // We attach data unconditionally so even on pass we can inspect.
    await test.info().attach('A_integrity_events.json', {
      body: JSON.stringify(integrity, null, 2),
      contentType: 'application/json',
    });

    // Soft expectations — fail loudly with the full violation list inline
    expect(snap.violations, `Post-import violations:\n${JSON.stringify(snap.violations.slice(0, 30), null, 2)}`).toEqual([]);
    expect(integrity, `Post-import integrity events: ${JSON.stringify(integrity)}`).toEqual([]);
  });

  test('B. TOC nav (the iPhone bug user-action) — book fully loaded, no edits', async ({ page, spa }) => {
    await page.evaluate(() => window.__resetIntegrityEvents?.());

    const { bookId } = await importFootnoteHeavyBook(page, spa, {
      title: 'Scenario B',
      chapters: 6,
      paragraphsPerChapter: 8,
      footnotesPerChapter: 5,   // 30 footnotes spread across 48 paragraphs
    });
    await page.waitForTimeout(2000);

    await checkpoint(page, bookId, 'B_post_import');

    // Wait for background download so the book is fully in IDB (mirrors the
    // user's situation: 272 IDB nodes = 272 PG nodes, no fetch race).
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);

    await checkpoint(page, bookId, 'B_fully_loaded');

    // Navigate via TOC to a far chunk
    await spa.openToc(page);
    const entries = await spa.getTocEntries(page);
    expect(entries.length, 'TOC should have entries').toBeGreaterThan(1);
    // Click the last entry (deepest into the book — most likely off-screen)
    await spa.clickTocEntry(page, entries.length - 1);
    await page.waitForTimeout(500);

    await checkpoint(page, bookId, 'B_post_toc_nav');

    // Enter edit mode (idempotent — the new-book/import flow may already be
    // in edit mode, in which case the first click would toggle off).
    const wasEditing = await page.evaluate(() => !!window.isEditing);
    if (!wasEditing) {
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5000 });
    }
    await page.waitForTimeout(500);
    await checkpoint(page, bookId, 'B_edit_mode_entered');

    // Exit edit mode — this is the trigger that fires the integrity verifier
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    const final = await checkpoint(page, bookId, 'B_edit_mode_exited');

    const integrity = collectIntegrityIssues(await spa.snapshotIntegrity(page));
    await test.info().attach('B_integrity_events.json', {
      body: JSON.stringify(integrity, null, 2),
      contentType: 'application/json',
    });

    expect(final.violations, `Post-TOC-nav-and-edit-exit violations:\n${JSON.stringify(final.violations.slice(0, 30), null, 2)}`).toEqual([]);
    expect(integrity, `Integrity events on edit-mode-exit: ${JSON.stringify(integrity)}`).toEqual([]);
  });

  test('C. Add footnote near top, then TOC-nav to bottom (rendered/unrendered split)', async ({ page, spa }) => {
    await page.evaluate(() => window.__resetIntegrityEvents?.());

    // Book sized so the initial chunk renders ~30-50 sups and ~100+ remain
    // unrendered. Without this split, renumber's "rendered-only persistence"
    // can't be distinguished from a fully-consistent persistence.
    const { bookId } = await importFootnoteHeavyBook(page, spa, {
      title: 'Scenario C',
      chapters: 20,
      paragraphsPerChapter: 15,
      footnotesPerChapter: 8,        // 160 footnotes across 300 paragraphs
    });
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    await checkpoint(page, bookId, 'C_baseline');

    // Enter edit mode at the top of the book (idempotent)
    if (!(await page.evaluate(() => !!window.isEditing))) {
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5000 });
    }

    // Click somewhere early in chapter 1 (paragraph ANCHORc1p1) to set caret
    await page.evaluate(() => {
      const p = [...document.querySelectorAll('.main-content p')]
        .find(el => /ANCHORc1p1/.test(el.textContent || ''));
      if (!p) throw new Error('Could not find ANCHORc1p1 paragraph');
      const range = document.createRange();
      range.selectNodeContents(p);
      range.collapse(false); // end of paragraph
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.waitForTimeout(200);

    // Insert a new footnote at top
    await spa.insertFootnoteAtCaret(page);
    await page.waitForTimeout(500);
    // Close the new sub-book — we don't need to type in it for the
    // rendered/unrendered split test
    await spa.closeTopContainer(page);
    await page.waitForTimeout(500);
    await checkpoint(page, bookId, 'C_after_footnote_insert_top');

    // TOC nav to the last chapter — this re-renders a chunk that wasn't in
    // view when the renumber fired
    await spa.openToc(page);
    const entries = await spa.getTocEntries(page);
    await spa.clickTocEntry(page, entries.length - 1);
    await page.waitForTimeout(500);
    await checkpoint(page, bookId, 'C_after_toc_nav_to_bottom');

    // Exit edit mode — triggers integrity check
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    const final = await checkpoint(page, bookId, 'C_edit_exit');

    const integrity = collectIntegrityIssues(await spa.snapshotIntegrity(page));
    await test.info().attach('C_integrity_events.json', {
      body: JSON.stringify(integrity, null, 2),
      contentType: 'application/json',
    });

    // This is the suspected failure mode — comment in plan Phase 1:
    // "rendered-vs-unrendered split that the renumber-only-persists-rendered-
    // nodes path should expose". Expect this one to fail; the failure tells
    // us which representation is wrong (look at violations.kind).
    expect(final.violations, `Violations after add-top + nav-bottom:\n${JSON.stringify(final.violations.slice(0, 30), null, 2)}`).toEqual([]);
    expect(integrity, `Integrity events: ${JSON.stringify(integrity)}`).toEqual([]);
  });

  test('D. Delete a footnote in the middle, then nav around (shrinking renumber)', async ({ page, spa }) => {
    await page.evaluate(() => window.__resetIntegrityEvents?.());

    const { bookId } = await importFootnoteHeavyBook(page, spa, {
      title: 'Scenario D',
      chapters: 4,
      paragraphsPerChapter: 6,
      footnotesPerChapter: 4,
    });
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    await checkpoint(page, bookId, 'D_baseline');

    if (!(await page.evaluate(() => !!window.isEditing))) {
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5000 });
    }

    // Find a sup roughly in the middle of the document and delete it.
    // Strategy: select the sup element + its preceding character, then Backspace.
    const deletedFootnoteId = await page.evaluate(() => {
      const sups = [...document.querySelectorAll('.main-content sup[fn-count-id]')];
      if (sups.length === 0) return null;
      const target = sups[Math.floor(sups.length / 2)];
      const fid = target.id || target.querySelector('a[href^="#"]')?.getAttribute('href')?.slice(1) || null;
      const range = document.createRange();
      range.selectNode(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return fid;
    });
    if (!deletedFootnoteId) {
      throw new Error('D: no rendered footnote sup to delete');
    }
    await page.keyboard.press('Delete');
    await page.waitForTimeout(800);
    await checkpoint(page, bookId, 'D_after_delete_mid');

    // Nav to bottom of book
    await spa.openToc(page);
    const entries = await spa.getTocEntries(page);
    await spa.clickTocEntry(page, entries.length - 1);
    await page.waitForTimeout(500);
    await checkpoint(page, bookId, 'D_after_toc_nav');

    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    const final = await checkpoint(page, bookId, 'D_edit_exit');

    const integrity = collectIntegrityIssues(await spa.snapshotIntegrity(page));
    await test.info().attach('D_integrity_events.json', {
      body: JSON.stringify(integrity, null, 2),
      contentType: 'application/json',
    });

    expect(final.violations, `Violations after delete-mid + nav-bottom:\n${JSON.stringify(final.violations.slice(0, 30), null, 2)}`).toEqual([]);
    expect(integrity, `Integrity events: ${JSON.stringify(integrity)}`).toEqual([]);
  });

  test('E. Copy-paste paragraph containing a footnote ref (paste-time linker)', async ({ page, spa }) => {
    await page.evaluate(() => window.__resetIntegrityEvents?.());

    const { bookId } = await importFootnoteHeavyBook(page, spa, {
      title: 'Scenario E',
      chapters: 3,
      paragraphsPerChapter: 4,
      footnotesPerChapter: 3,
    });
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    await checkpoint(page, bookId, 'E_baseline');

    if (!(await page.evaluate(() => !!window.isEditing))) {
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5000 });
    }

    // Find a paragraph that contains at least one sup, capture its HTML, then
    // paste a clone immediately after.
    const pasted = await page.evaluate(async () => {
      const para = [...document.querySelectorAll('.main-content p')]
        .find(p => p.querySelector('sup[fn-count-id]'));
      if (!para) return { ok: false, reason: 'no paragraph with sup found' };

      const html = para.outerHTML;
      const after = para.nextSibling;
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const clone = tmp.firstElementChild;
      // Strip id so we don't collide with the original
      clone.removeAttribute('id');
      clone.removeAttribute('data-node-id');
      para.parentNode.insertBefore(clone, after);
      // Fire an input event so the mutation observer picks it up
      const ev = new InputEvent('input', { bubbles: true });
      clone.dispatchEvent(ev);
      return { ok: true, originalSupCount: para.querySelectorAll('sup[fn-count-id]').length };
    });
    if (!pasted.ok) {
      throw new Error(`E: setup failed: ${pasted.reason}`);
    }
    await page.waitForTimeout(800);
    await checkpoint(page, bookId, 'E_after_clone_insert');

    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    const final = await checkpoint(page, bookId, 'E_edit_exit');

    const integrity = collectIntegrityIssues(await spa.snapshotIntegrity(page));
    await test.info().attach('E_integrity_events.json', {
      body: JSON.stringify(integrity, null, 2),
      contentType: 'application/json',
    });

    expect(final.violations, `Violations after clone-with-sup insert:\n${JSON.stringify(final.violations.slice(0, 30), null, 2)}`).toEqual([]);
    expect(integrity, `Integrity events: ${JSON.stringify(integrity)}`).toEqual([]);
  });

  test('F. Sub-book footnote cycle — open, edit inside, close, reopen', async ({ page, spa }) => {
    await page.evaluate(() => window.__resetIntegrityEvents?.());

    const { bookId } = await importFootnoteHeavyBook(page, spa, {
      title: 'Scenario F',
      chapters: 3,
      paragraphsPerChapter: 4,
      footnotesPerChapter: 3,
    });
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    await checkpoint(page, bookId, 'F_baseline');

    if (!(await page.evaluate(() => !!window.isEditing))) {
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5000 });
    }

    // Open the first rendered footnote sub-book
    const opened = await page.evaluate(() => {
      const sup = document.querySelector('.main-content sup[fn-count-id]');
      if (!sup) return false;
      sup.click();
      return true;
    });
    if (!opened) throw new Error('F: no rendered footnote sup to open');

    await page.waitForFunction(() => !!document.querySelector('#hyperlit-container.open'), null, { timeout: 8000 });
    await page.waitForTimeout(500);
    await checkpoint(page, bookId, 'F_sub_book_opened');

    // Type a tiny edit inside the sub-book
    await spa.typeAtEndOfActiveEditor(page, ' edited-inside-fn');
    await page.waitForTimeout(500);

    await spa.closeTopContainer(page);
    await page.waitForTimeout(500);
    await checkpoint(page, bookId, 'F_sub_book_closed');

    // Reopen the same sup
    await page.evaluate(() => {
      const sup = document.querySelector('.main-content sup[fn-count-id]');
      if (sup) sup.click();
    });
    await page.waitForFunction(() => !!document.querySelector('#hyperlit-container.open'), null, { timeout: 8000 });
    await page.waitForTimeout(500);
    await checkpoint(page, bookId, 'F_sub_book_reopened');

    await spa.closeTopContainer(page);
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    const final = await checkpoint(page, bookId, 'F_edit_exit');

    const integrity = collectIntegrityIssues(await spa.snapshotIntegrity(page));
    await test.info().attach('F_integrity_events.json', {
      body: JSON.stringify(integrity, null, 2),
      contentType: 'application/json',
    });

    expect(final.violations, `Violations after sub-book cycle:\n${JSON.stringify(final.violations.slice(0, 30), null, 2)}`).toEqual([]);
    expect(integrity, `Integrity events: ${JSON.stringify(integrity)}`).toEqual([]);
  });

  test('G. Hydration drift — re-running rebuildNodeArrays must not change node.footnotes', async ({ page, spa }) => {
    // The hydration path (`indexedDB/hydration/rebuild.js`) re-derives
    // `node.footnotes` from stored HTML using a *different* extractor than
    // `batch.js` (`processNodeContentHighlightsAndCites`). If they disagree on
    // any node, every subsequent renumber will build the map from a wrong
    // input, and `reconcileStoredFootnoteContent` will write that wrong value
    // into stored content AND push it to the server. So before trusting the
    // reconcile path in production, we need to prove hydration is round-trip
    // stable for the formats our system actually produces.
    //
    // Method: import a book, capture every node's `footnotes` array, then
    // explicitly re-invoke `rebuildNodeArrays` on every node and assert the
    // arrays are byte-for-byte preserved.

    await page.evaluate(() => window.__resetIntegrityEvents?.());

    const { bookId } = await importFootnoteHeavyBook(page, spa, {
      title: 'Scenario G',
      chapters: 5,
      paragraphsPerChapter: 6,
      footnotesPerChapter: 4,
    });
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
      const cs = document.querySelector('#cloudRef-svg .cls-1');
      return cs && cs.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    await checkpoint(page, bookId, 'G_baseline');

    // Snapshot node.footnotes BEFORE re-hydration. Normalise to a comparable
    // shape — JSON-stringify each entry, sorted by startLine.
    const before = await page.evaluate(async (bookId) => {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('MarkdownDB');
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('nodes', 'readonly');
          const store = tx.objectStore('nodes');
          const out = [];
          const cursorReq = store.index('book').openCursor(IDBKeyRange.only(bookId));
          cursorReq.onsuccess = (evt) => {
            const c = evt.target.result;
            if (!c) {
              out.sort((a, b) => Number(a.startLine) - Number(b.startLine));
              db.close();
              return resolve(out);
            }
            out.push({
              startLine: c.value.startLine,
              node_id: c.value.node_id,
              footnotes: JSON.stringify(c.value.footnotes || []),
            });
            c.continue();
          };
          cursorReq.onerror = () => reject(new Error('cursor failed'));
        };
        req.onerror = () => reject(new Error('open failed'));
      });
    }, bookId);

    // Reload the page — this re-initialises the SPA and forces hydration to
    // run from scratch on every chunk in IDB. Tests the REAL hydration path
    // that fires on page load, not an isolated function call.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.body.getAttribute('data-page') === 'reader', null, { timeout: 15000 });
    // Background hydration of remaining chunks completes asynchronously;
    // give it time to settle before snapshotting.
    await page.waitForTimeout(3000);
    await page.waitForFunction(() => {
      const cs = document.querySelector('#cloudRef-svg .cls-1');
      return cs && cs.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    await checkpoint(page, bookId, 'G_after_reload_hydration');

    // Snapshot AFTER re-hydration.
    const after = await page.evaluate(async (bookId) => {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('MarkdownDB');
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('nodes', 'readonly');
          const store = tx.objectStore('nodes');
          const out = [];
          const cursorReq = store.index('book').openCursor(IDBKeyRange.only(bookId));
          cursorReq.onsuccess = (evt) => {
            const c = evt.target.result;
            if (!c) {
              out.sort((a, b) => Number(a.startLine) - Number(b.startLine));
              db.close();
              return resolve(out);
            }
            out.push({
              startLine: c.value.startLine,
              node_id: c.value.node_id,
              footnotes: JSON.stringify(c.value.footnotes || []),
            });
            c.continue();
          };
          cursorReq.onerror = () => reject(new Error('cursor failed'));
        };
        req.onerror = () => reject(new Error('open failed'));
      });
    }, bookId);

    // Compare entry by entry. Any drift here means hydration's footnote
    // extractor disagrees with whatever populated `node.footnotes` in the
    // first place (batch.js, or the server's import endpoint).
    const drifts = [];
    const byStart = new Map(before.map(b => [String(b.startLine), b]));
    for (const a of after) {
      const b = byStart.get(String(a.startLine));
      if (!b) {
        drifts.push({ startLine: a.startLine, kind: 'appeared_after_hydration', after: a.footnotes });
        continue;
      }
      if (b.footnotes !== a.footnotes) {
        drifts.push({
          startLine: a.startLine,
          kind: 'changed',
          before: b.footnotes,
          after: a.footnotes,
        });
      }
    }
    for (const b of before) {
      if (!after.find(a => String(a.startLine) === String(b.startLine))) {
        drifts.push({ startLine: b.startLine, kind: 'disappeared_after_hydration', before: b.footnotes });
      }
    }

    await test.info().attach('G_hydration_drift.json', {
      body: JSON.stringify({
        beforeCount: before.length,
        afterCount: after.length,
        driftCount: drifts.length,
        firstDrifts: drifts.slice(0, 20),
      }, null, 2),
      contentType: 'application/json',
    });

    // eslint-disable-next-line no-console
    console.log(`[G] hydration drift: ${drifts.length} drifted nodes (of ${before.length}). First few:`,
      JSON.stringify(drifts.slice(0, 5), null, 2));

    expect(drifts, `Hydration drift in ${drifts.length}/${before.length} nodes:\n${JSON.stringify(drifts.slice(0, 10), null, 2)}`).toEqual([]);
  });

  test('H. Render-time self-heal — stale IDB gets corrected when chunk renders, no renumber needed', async ({ page, spa }) => {
    // Mimics the iPhone bug shape directly: IDB has a sup with an OLD fn-count-id
    // value that disagrees with the dynamic map (built from up-to-date
    // node.footnotes arrays), and NO renumber will fire this session because
    // the user didn't add/delete a footnote.
    //
    // We need the corrupted node to be in a chunk that goes through
    // createChunkElement (client-side build) rather than initial server-render,
    // because applyDynamicFootnoteNumbers fires only in createChunkElement.
    // → Big book + corrupt a node deep in it + TOC nav to that region.

    await page.evaluate(() => window.__resetIntegrityEvents?.());

    const { bookId } = await importFootnoteHeavyBook(page, spa, {
      title: 'Scenario H',
      chapters: 15,
      paragraphsPerChapter: 12,
      footnotesPerChapter: 5,        // 75 footnotes across 180 paragraphs
    });
    await page.waitForTimeout(2500);
    await page.waitForFunction(() => {
      const cs = document.querySelector('#cloudRef-svg .cls-1');
      return cs && cs.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    await checkpoint(page, bookId, 'H_baseline');

    // STEP 1: Pick a node DEEP in the book (not in the initial render chunk)
    // and corrupt its stored fn-count-id directly in IDB. We target the LAST
    // node with a footnote so we're guaranteed to be past the initial render.
    const corrupted = await page.evaluate(async (bookId) => {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('MarkdownDB');
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('nodes', 'readwrite');
          const store = tx.objectStore('nodes');
          // First pass: read all nodes ordered by startLine to find candidates
          const candidates = [];
          const cursorReq = store.index('book').openCursor(IDBKeyRange.only(bookId));
          cursorReq.onsuccess = (evt) => {
            const c = evt.target.result;
            if (!c) {
              // Sort by startLine descending, pick the FIRST one with a numeric sup
              candidates.sort((a, b) => Number(b.startLine) - Number(a.startLine));
              const target = candidates.find(c => /<sup\b[^>]*\bfn-count-id="(\d+)"[^>]*>(\d+)<\/sup>/.test(c.content));
              if (!target) { db.close(); return resolve(null); }
              const m = target.content.match(/<sup\b[^>]*\bfn-count-id="(\d+)"[^>]*>(\d+)<\/sup>/);
              const originalNumber = m[1];
              const newContent = target.content.replace(
                /<sup\b([^>]*)\bfn-count-id="(\d+)"([^>]*)>(\d+)<\/sup>/,
                '<sup$1fn-count-id="999"$3>999</sup>',
              );
              // Write the corrupted node back in a new transaction
              const writeTx = db.transaction('nodes', 'readwrite');
              const writeStore = writeTx.objectStore('nodes');
              const writeReq = writeStore.get([bookId, target.startLine]);
              writeReq.onsuccess = () => {
                const fresh = writeReq.result;
                fresh.content = newContent;
                writeStore.put(fresh);
              };
              writeTx.oncomplete = () => {
                db.close();
                resolve({ startLine: target.startLine, originalNumber, storedNow: '999' });
              };
              writeTx.onerror = () => { db.close(); reject(new Error('write tx failed')); };
              return;
            }
            const node = c.value;
            if (node.content) candidates.push({ startLine: node.startLine, content: node.content });
            c.continue();
          };
          cursorReq.onerror = () => reject(new Error('cursor failed'));
        };
        req.onerror = () => reject(new Error('open failed'));
      });
    }, bookId);

    expect(corrupted, 'H: failed to find a node with a footnote sup to corrupt').toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`[H] Corrupted node ${corrupted.startLine}: stored fn-count-id "${corrupted.originalNumber}" → "999". Map should still say "${corrupted.originalNumber}".`);

    await checkpoint(page, bookId, 'H_after_idb_corruption');

    // STEP 2: Reload so window.nodes (the lazy loader's in-memory cache) gets
    // re-populated from the now-corrupted IDB. Without reload, window.nodes
    // still has the original pre-corruption content, and createChunkElement
    // would render the correct number — never exercising the render-heal.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.body.getAttribute('data-page') === 'reader', null, { timeout: 15000 });
    await page.waitForTimeout(3000);

    // STEP 3: TOC-nav deep into the book so the corrupted chunk loads via
    // lazyLoader → createChunkElement → applyDynamicFootnoteNumbers, which
    // should detect "stored 999 vs map says <originalNumber>" and queue
    // the render-heal.
    await spa.openToc(page);
    const entries = await spa.getTocEntries(page);
    expect(entries.length, 'H: TOC should have entries').toBeGreaterThan(1);
    await spa.clickTocEntry(page, entries.length - 1);
    // Give render-heal time to flush (setTimeout 0 + inner async batch write)
    await page.waitForTimeout(3000);

    await checkpoint(page, bookId, 'H_after_toc_nav_render_heal');

    // Diagnostic: did the corrupted node actually render? What does the DOM
    // say vs IDB? This tells us whether applyDynamicFootnoteNumbers had a
    // chance to run on it.
    const domState = await page.evaluate((startLine) => {
      const block = document.querySelector(`[id="${startLine}"]`);
      if (!block) return { rendered: false };
      const sup = block.querySelector('sup[fn-count-id]');
      return {
        rendered: true,
        blockOuterHTML: block.outerHTML.slice(0, 300),
        supFnCountId: sup ? sup.getAttribute('fn-count-id') : null,
        supText: sup ? sup.textContent : null,
        supId: sup ? sup.id : null,
      };
    }, corrupted.startLine);
    // eslint-disable-next-line no-console
    console.log(`[H] DOM state for node ${corrupted.startLine}:`, JSON.stringify(domState, null, 2));

    // STEP 3: Read IDB and confirm the sup is no longer "999". The render-heal
    // should have rewritten it to the correct sequential number from the map.
    const after = await page.evaluate(async ({ bookId, startLine }) => {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('MarkdownDB');
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('nodes', 'readonly');
          const store = tx.objectStore('nodes');
          const getReq = store.get([bookId, startLine]);
          getReq.onsuccess = () => {
            const node = getReq.result;
            db.close();
            if (!node) return resolve(null);
            const m = node.content.match(/<sup\b[^>]*\bfn-count-id="(\d+)"[^>]*>(\d+)<\/sup>/);
            resolve({
              content: node.content,
              firstSupCountId: m ? m[1] : null,
              firstSupText: m ? m[2] : null,
            });
          };
          getReq.onerror = () => reject(new Error('get failed'));
        };
        req.onerror = () => reject(new Error('open failed'));
      });
    }, { bookId, startLine: corrupted.startLine });

    await test.info().attach('H_after_state.json', {
      body: JSON.stringify({ corrupted, after }, null, 2),
      contentType: 'application/json',
    });

    // eslint-disable-next-line no-console
    console.log(`[H] After reload + render-heal: node ${corrupted.startLine} now has fn-count-id="${after?.firstSupCountId}" text="${after?.firstSupText}" (was 999, should be back to ${corrupted.originalNumber})`);

    expect(after, 'H: node disappeared from IDB after reload').toBeTruthy();
    // The most important assertion: the "999" we wrote into IDB should be
    // gone, replaced by whatever number the map computes (typically the
    // original).
    expect(after.firstSupCountId, `Render-time self-heal failed to fix stale fn-count-id. Stored content: ${after.content?.slice(0, 200)}`).not.toBe('999');
    expect(after.firstSupText, `Render-time self-heal failed to fix stale sup text`).not.toBe('999');

    // Final: full invariant check should pass too
    const finalSnap = await checkpoint(page, bookId, 'H_final_invariants');
    expect(finalSnap.violations, `Post-heal violations:\n${JSON.stringify(finalSnap.violations.slice(0, 10), null, 2)}`).toEqual([]);
  });
});
