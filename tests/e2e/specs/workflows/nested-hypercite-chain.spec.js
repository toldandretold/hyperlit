import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Nested hypercite chain.
 *
 * Two tests in this file. The first is a three-phase intra-book journey;
 * the second is a cross-book back-restore regression guard.
 *
 * ── Test 1: build → chain → verify (Phases 1-3) ────────────────────────
 *
 *   Phase 1 (build the nest): create book, type at L0, insert footnote →
 *     type L1, hyperlight that text → type L2, insert footnote → type L3.
 *     Close all the way back to L0 and commit. After Phase 1, the book
 *     has placeholder text at four levels and the rendered surface at
 *     each level has a footnote ref or hyperlight mark to enter the
 *     next level.
 *
 *   Phase 2 (chain hypercites): walk back down the EXISTING nest via
 *     clicks. At each level: enter edit mode (click .hyperlit-edit-btn),
 *     paste the hypercite copied from the level above, then copy-hypercite
 *     this level's own text. Net effect: every level holds a hypercite
 *     link to the level above it AND becomes a new hypercite source for
 *     the level below.
 *
 *   Phase 3 (verify): back-navigate to unwind the stack, then click each
 *     hypercite open-icon in turn, asserting URL/container depth at every
 *     step. Then walk back-then-forward through the history to confirm
 *     popstate restores the container stack on every transition.
 *
 * ── Test 2: cross-book back-restore preserves the deep stack ───────────
 *
 *   Reproduces the user-reported bug: a book with deep nested containers
 *   open had its container stack truncated to depth 1 when navigated
 *   back to from another book. The fix (in
 *   `BookToBookTransition.updateUrlWithStatePreservation` and supporting
 *   restoration paths) preserves the saved `containerStack` on popstate.
 *
 *   Scenario:
 *     1. Build a 3-level nest in book A (footnote → hyperlight → footnote)
 *        and end with all 3 layers OPEN.
 *     2. Copy a hypercite from the deepest level (L3 footnote).
 *     3. Navigate home (with a state-cleanup workaround for a separate
 *        leak where homeButtonNav SPA transition propagates
 *        `containerStack` into the new home entry).
 *     4. Create book B, paste the hypercite.
 *     5. Click the pasted hypercite → SPA back to book A.
 *     6. Walk back through history via successive `page.goBack()` calls,
 *        snapshotting at every step.
 *
 *   Two strict assertions guard the fix:
 *     (a) CROSS-BOOK POPSTATE: at the step where bookId transitions from
 *         non-A (home/B) back to A, the visible stack must equal the
 *         saved `historyStackDepth` (state was honored, not nulled) AND
 *         the saved depth must be > 0. A regression to
 *         `updateUrlWithStatePreservation` nulling state on popstate
 *         fails either condition.
 *     (b) DEEP-STACK ENTRY: at book A's original cs=3 entry (matched by
 *         both URL `?cs=3` and `historyStackDepth === 3`), all 3 layers
 *         must be visible AND all 4 typed phrases (L0..L3) must be
 *         present in the DOM. The phrase check catches the
 *         closeContainer-mid-restoration regression where the base
 *         container visually closed while stacked layers floated over
 *         an empty body.
 *
 *   A forward-then-back cycle within book A verifies popstate restoration
 *   is idempotent across multiple traversals.
 *
 *   FINALLY — cross-book forward-leak detection: walks FORWARD through
 *   history until the SPA crosses out of book A into another book. At
 *   that point, asserts (a) no containers are visible in the destination
 *   book, and (b) no `.hyperlit-container-stacked` DOM node remains bound
 *   to book A (the "zombie containers stuck on top of book B" bug
 *   reported 2026-05-16). Container attribution is captured at every
 *   step (which sub-book each open container's content belongs to) so
 *   any failure pinpoints exactly which layers leaked.
 */

const PHRASES = {
  L0: 'alphaSourceTextXX',
  L1: 'betaSubBookTextXX',
  L2: 'gammaHyperlightTextXX',
  L3: 'deltaInnerFootnoteXX',
};

test.describe('Nested hypercite chain', () => {
  test('Phase 1 builds the nest, Phase 2 chains hypercites via clicks, Phase 3 verifies the chain', async ({ page, spa }) => {
    test.setTimeout(240_000);

    const timeline = [];
    const snap = async (label) => {
      const s = await spa.snapshotPageState(page, label);
      timeline.push(s);
      // eslint-disable-next-line no-console
      console.log(spa.summariseSnapshot(s));
      return s;
    };

    // ════════════════════════════════════════════════════════════════
    // PHASE 1: BUILD THE NEST (text only, no hypercites yet)
    // ════════════════════════════════════════════════════════════════
    const { bookId } = await spa.createNewBook(page, spa);
    await snap(`P1 book created ${bookId}`);

    // L0 base paragraph
    await page.click('h1[id="100"]');
    await page.keyboard.type('Hypercite Chain Test');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type(PHRASES.L0);
    await page.waitForTimeout(400);
    await snap('P1 L0 typed');

    // L1: footnote on L0
    await spa.insertFootnoteAtCaret(page);
    expect(await spa.getStackDepth(page)).toBe(1);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.L1);
    await page.waitForTimeout(300);
    await snap('P1 L1 typed');

    // L2: hyperlight on L1's text
    await spa.selectInActiveEditor(page, PHRASES.L1);
    await spa.hyperlightSelection(page);
    expect(await spa.getStackDepth(page)).toBe(2);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.L2);
    await page.waitForTimeout(300);
    await snap('P1 L2 typed');

    // L3: footnote on L2
    await spa.insertFootnoteAtCaret(page);
    expect(await spa.getStackDepth(page)).toBe(3);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.L3);
    await page.waitForTimeout(400);
    await snap('P1 L3 typed');

    // Close everything back to base
    await spa.closeTopContainer(page);
    await page.waitForTimeout(200);
    await spa.closeTopContainer(page);
    await page.waitForTimeout(200);
    await spa.closeTopContainer(page);
    await page.waitForTimeout(200);
    expect(await spa.getStackDepth(page)).toBe(0);
    await snap('P1 all containers closed');

    // Commit (exits edit mode → fires integrity verifier)
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
    // Wait for cloud sync to go green so the chain has durable IndexedDB state
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    await snap('P1 commit complete');

    // ════════════════════════════════════════════════════════════════
    // PHASE 2: CHAIN HYPERCITES BY WALKING THE EXISTING NEST
    // ════════════════════════════════════════════════════════════════

    // L0 → clipA: copy-hypercite the base paragraph text
    await spa.selectInActiveEditor(page, PHRASES.L0);
    const clipA = await spa.copyHyperciteFromActiveEditor(page);
    expect(clipA.hyperciteId).toMatch(/^hypercite_/);
    expect(clipA.sourceBookId).toBe(bookId);
    await snap(`P2 clipA copied ${clipA.hyperciteId}`);

    // Click the footnote ref in main to open the EXISTING L1 (read mode)
    await spa.clickIntoDeeperLevel(page, 'footnote');
    expect(await spa.getStackDepth(page)).toBe(1);
    await snap('P2 L1 opened via click');

    // Enter edit mode in L1, paste clipA at end
    await spa.toggleEditModeInActiveContainer(page);
    await spa.typeAtEndOfActiveEditor(page, ''); // position caret at end
    await page.waitForTimeout(200);
    const probeL1 = await spa.pasteEnvProbe(page);
    // eslint-disable-next-line no-console
    console.log('P2 L1 paste-env probe:', JSON.stringify(probeL1));

    // Install a paste spy so we know whether the synthetic event actually
    // reaches the sub-book's paste listener (and what clipboardData it sees).
    await page.evaluate(() => {
      const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
      const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
      const subBook = top?.querySelector('.sub-book-content');
      window.__pasteSpy = { fired: 0, lastEvent: null };
      if (subBook) {
        const spy = (e) => {
          window.__pasteSpy.fired++;
          window.__pasteSpy.lastEvent = {
            phase: e.eventPhase,
            target: e.target?.tagName || null,
            currentTarget: e.currentTarget?.className || null,
            defaultPrevented: e.defaultPrevented,
            clipboardDataPresent: !!e.clipboardData,
            htmlLen: e.clipboardData?.getData('text/html')?.length ?? -1,
            textLen: e.clipboardData?.getData('text/plain')?.length ?? -1,
            htmlSnippet: (e.clipboardData?.getData('text/html') || '').slice(0, 160),
          };
        };
        subBook.addEventListener('paste', spy, { capture: true });
        window.__pasteSpyTarget = subBook;
        window.__pasteSpyFn = spy;
      }
    });

    await spa.pasteHyperciteContent(page, clipA.html, clipA.text);
    const spyResult = await page.evaluate(() => window.__pasteSpy);
    // eslint-disable-next-line no-console
    console.log('P2 L1 paste-spy:', JSON.stringify(spyResult));

    try {
      await page.waitForFunction((id) => {
        const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
        const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
        return !!top?.querySelector(`a.open-icon[href*="${id}"]`);
      }, clipA.hyperciteId, { timeout: 5000 });
    } catch (err) {
      const postProbe = await spa.pasteEnvProbe(page);
      throw new Error(`paste clipA did not land. PRE-probe: ${JSON.stringify(probeL1)}. SPY: ${JSON.stringify(spyResult)}. POST-probe: ${JSON.stringify(postProbe)}`);
    }
    await snap('P2 L1 paste clipA');

    // Copy-hypercite L1's original text → clipB
    await spa.selectInActiveEditor(page, PHRASES.L1);
    const clipB = await spa.copyHyperciteFromActiveEditor(page);
    expect(clipB.hyperciteId).toMatch(/^hypercite_/);
    expect(clipB.hyperciteId).not.toBe(clipA.hyperciteId);
    await snap(`P2 clipB copied ${clipB.hyperciteId}`);

    // Click the hyperlight mark in L1 to open the EXISTING L2 (stacked, read mode)
    await spa.clickIntoDeeperLevel(page, 'hyperlight');
    expect(await spa.getStackDepth(page)).toBe(2);
    await snap('P2 L2 opened via click');

    // Edit mode in L2, paste clipB
    await spa.toggleEditModeInActiveContainer(page);
    await spa.typeAtEndOfActiveEditor(page, '');
    await page.waitForTimeout(200);
    await spa.pasteHyperciteContent(page, clipB.html, clipB.text);
    await page.waitForFunction((id) => {
      const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
      const top = stacked[stacked.length - 1];
      return !!top?.querySelector(`a.open-icon[href*="${id}"]`);
    }, clipB.hyperciteId, { timeout: 5000 });
    await snap('P2 L2 paste clipB');

    // Copy-hypercite L2's original text → clipC
    await spa.selectInActiveEditor(page, PHRASES.L2);
    const clipC = await spa.copyHyperciteFromActiveEditor(page);
    expect(clipC.hyperciteId).toMatch(/^hypercite_/);
    expect(clipC.hyperciteId).not.toBe(clipB.hyperciteId);
    await snap(`P2 clipC copied ${clipC.hyperciteId}`);

    // Click the footnote ref in L2 to open the EXISTING L3 (stacked, read mode)
    await spa.clickIntoDeeperLevel(page, 'footnote');
    expect(await spa.getStackDepth(page)).toBe(3);
    await snap('P2 L3 opened via click');

    // Edit mode in L3, paste clipC
    await spa.toggleEditModeInActiveContainer(page);
    await spa.typeAtEndOfActiveEditor(page, '');
    await page.waitForTimeout(200);
    await spa.pasteHyperciteContent(page, clipC.html, clipC.text);
    await page.waitForFunction((id) => {
      const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
      const top = stacked[stacked.length - 1];
      return !!top?.querySelector(`a.open-icon[href*="${id}"]`);
    }, clipC.hyperciteId, { timeout: 5000 });
    await snap('P2 L3 paste clipC');

    // Wait for sync so chain is durable
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);

    // ── Verify the full chain is in the DOM right now ────────────────
    const chainCheck = await page.evaluate((ids) => {
      const surfaces = [document.querySelector('.main-content'), ...document.querySelectorAll('.sub-book-content')];
      const has = {};
      for (const id of ids) {
        has[id] = surfaces.some(s => s && (
          s.querySelector(`u[id="${id}"]`) || s.querySelector(`a.open-icon[href*="${id}"]`)
        ));
      }
      return has;
    }, [clipA.hyperciteId, clipB.hyperciteId, clipC.hyperciteId]);
    expect(chainCheck[clipA.hyperciteId], 'clipA must exist somewhere in chain').toBe(true);
    expect(chainCheck[clipB.hyperciteId], 'clipB must exist somewhere in chain').toBe(true);
    expect(chainCheck[clipC.hyperciteId], 'clipC must exist somewhere in chain').toBe(true);

    // ════════════════════════════════════════════════════════════════
    // PHASE 3: VERIFY THE CHAIN
    // ════════════════════════════════════════════════════════════════
    //
    // Walk back UP the chain via the pasted open-icon links — at each
    // level, the pasted hypercite has an href pointing to the level
    // ABOVE (where it was copied from). Click → "See in source text"
    // → land at the source. Repeat until we hit base.

    /** Click topmost open-icon link, then click "See in source text" */
    const followOpenIconUp = async (label) => {
      // Topmost stacked, or base container, or main-content if no container open
      const before = await snap(`P3 pre-follow ${label}`);
      await page.evaluate(() => {
        const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
        const top = stacked[stacked.length - 1]
          || document.querySelector('#hyperlit-container.open')
          || document.querySelector('.main-content');
        const link = top?.querySelector('a.open-icon[href*="#hypercite_"]');
        if (link) link.click();
      });
      await page.waitForSelector('#hyperlit-container a.see-in-source-btn, .hyperlit-container-stacked.open a.see-in-source-btn', { timeout: 8000 });
      await page.waitForTimeout(300);
      const seeBtn = page.locator('a.see-in-source-btn').first();
      await seeBtn.click();
      await page.waitForTimeout(800); // allow nav + restoration to settle
      await snap(`P3 followed ${label}`);
      return before;
    };

    // 3a. Walk the chain backward via open-icons
    await followOpenIconUp('L3 → L2');
    await followOpenIconUp('L2 → L1');
    await followOpenIconUp('L1 → base');

    // After three follows we should be on base book with the original <u>
    const atBase = await snap('P3 after open-icon walk');
    expect(atBase.bookId).toBe(bookId);
    const baseHasOriginalU = await page.evaluate((id) => {
      return !!document.querySelector(`.main-content u[id="${id}"]`);
    }, clipA.hyperciteId);
    expect(baseHasOriginalU, `original <u id="${clipA.hyperciteId}"> must be present at base after open-icon walk`).toBe(true);

    // 3b. Press back button as far as it goes — snapshot each landing
    const backTrace = [];
    for (let i = 0; i < 6; i++) {
      const beforeUrl = page.url();
      await page.goBack();
      await page.waitForTimeout(700);
      const afterUrl = page.url();
      const s = await snap(`P3 back #${i + 1}`);
      backTrace.push({ step: i + 1, from: beforeUrl, to: afterUrl, bookId: s.bookId, depth: s.historyStackDepth });
      // If we've left the SPA (blank/about:blank) or the URL stopped changing, stop.
      if (afterUrl === beforeUrl || /^about:|^blank$/i.test(afterUrl)) break;
    }
    // eslint-disable-next-line no-console
    console.log('P3 back trace:', JSON.stringify(backTrace));

    // 3c. Press forward as far as it goes — snapshot each landing
    const forwardTrace = [];
    for (let i = 0; i < 6; i++) {
      const beforeUrl = page.url();
      await page.goForward();
      await page.waitForTimeout(700);
      const afterUrl = page.url();
      const s = await snap(`P3 forward #${i + 1}`);
      forwardTrace.push({ step: i + 1, from: beforeUrl, to: afterUrl, bookId: s.bookId, depth: s.historyStackDepth });
      if (afterUrl === beforeUrl || /^about:|^blank$/i.test(afterUrl)) break;
    }
    // eslint-disable-next-line no-console
    console.log('P3 forward trace:', JSON.stringify(forwardTrace));

    await test.info().attach('back-forward-trace.json', {
      body: JSON.stringify({ backTrace, forwardTrace }, null, 2),
      contentType: 'application/json',
    });

    // ── Final forensic dump + filtered console errors ────────────────
    await test.info().attach('state-timeline.json', {
      body: JSON.stringify(timeline, null, 2),
      contentType: 'application/json',
    });
    await test.info().attach('chain.json', {
      body: JSON.stringify({ clipA, clipB, clipC, chainCheck }, null, 2),
      contentType: 'application/json',
    });

    const isKnownIdOneCollision = (e) => /Duplicate IDs found:[^a-zA-Z]*1\(\d+\)/.test(e);
    const errors = spa.filterConsoleErrors(page.consoleErrors)
      .filter(e => !/429.*Too Many Requests/i.test(e))
      .filter(e => !/^🔴 ISSUES FOUND:$/.test(e))
      .filter(e => !isKnownIdOneCollision(e));
    expect(errors, `Console errors: ${JSON.stringify(errors)}`).toEqual([]);
  });

  // ════════════════════════════════════════════════════════════════════
  // Cross-book back-restore: deep stack survives a round-trip through
  // a second book.
  //
  // Scenario:
  //   1. Build a 3-level nest in book A (footnote → hyperlight → footnote)
  //      and end with all 3 containers OPEN.
  //   2. Copy a hypercite from the deepest level's text.
  //   3. Create book B, paste the hypercite there.
  //   4. Click the pasted hypercite link → SPA navigation back to book A.
  //      → ASSERT: all 3 containers in book A are restored (stackedOpen +
  //        bodyOpen === 3) and the typed phrases at each level are present.
  //   5. From the restored book A state, click forward to book B again.
  //   6. Press browser BACK to return to book A.
  //      → ASSERT: again, all 3 containers visible AND the typed phrases.
  //
  // Regressions this catches:
  //   - The destroy-on-reinit bug where mid-restoration
  //     initializeHyperlitManager() destroys the manager and slams the
  //     base container shut, leaving stacked layers floating over a
  //     visually-closed footnote.
  //   - The BookToBookTransition cascade-hint hang that fires
  //     waitForNavigationTarget for an HL_/Fn_ id that lives in a
  //     sub-book.
  //   - Loss of containerStack on the popstate-destination entry
  //     (BookToBookTransition.updateUrlWithStatePreservation nulling
  //     it out).
  // ════════════════════════════════════════════════════════════════════
  test('cross-book back-restore preserves the deep stack', async ({ page, spa }) => {
    test.setTimeout(240_000);

    const timeline = [];
    const snap = async (label) => {
      const s = await spa.snapshotPageState(page, label);
      timeline.push(s);
      // eslint-disable-next-line no-console
      console.log(spa.summariseSnapshot(s));
      return s;
    };

    // ── Build chain in book A: footnote → hyperlight → footnote ──────
    const { bookId: bookAId } = await spa.createNewBook(page, spa);
    await snap(`A book created ${bookAId}`);

    await page.click('h1[id="100"]');
    await page.keyboard.type('Cross-Book Back Restore Test');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type(PHRASES.L0);
    await page.waitForTimeout(400);
    await snap('A L0 typed');

    await spa.insertFootnoteAtCaret(page);
    expect(await spa.getStackDepth(page)).toBe(1);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.L1);
    await page.waitForTimeout(300);
    await snap('A L1 typed');

    await spa.selectInActiveEditor(page, PHRASES.L1);
    await spa.hyperlightSelection(page);
    expect(await spa.getStackDepth(page)).toBe(2);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.L2);
    await page.waitForTimeout(300);
    await snap('A L2 typed');

    await spa.insertFootnoteAtCaret(page);
    expect(await spa.getStackDepth(page)).toBe(3);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.L3);
    await page.waitForTimeout(400);
    await snap('A L3 typed (all 3 layers open)');

    // ── Copy hypercite from deepest level ───────────────────────────
    await spa.selectInActiveEditor(page, PHRASES.L3);
    const clipDeepest = await spa.copyHyperciteFromActiveEditor(page);
    expect(clipDeepest.hyperciteId).toMatch(/^hypercite_/);
    await snap(`A clipDeepest copied ${clipDeepest.hyperciteId}`);

    // Wait for sync so the new hypercite is durable, exit edit mode
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Sanity: we should still have all 3 containers open
    const depthAfterCopy = await spa.getStackDepth(page);
    expect(depthAfterCopy, 'all 3 layers should still be open in book A').toBe(3);

    // ── Create book B and paste the hypercite ───────────────────────
    // Closing book A's containers via go-home would tear down our stack.
    // We need book B to be reachable WITHOUT touching A's history entry
    // (which carries the deep stack we want to restore later).
    //
    // Trick: open #newBook directly without using navigation. That
    // pushes a new SPA entry on top of A's deep-stack entry.
    await page.evaluate(() => {
      // Hide the container UI without closing the stack — just navigate
      // home as a real user would (clicking the logo). The logo nav
      // pushes a new history entry.
      const logoNav = document.getElementById('homeButtonNav');
      if (logoNav) logoNav.click();
    });
    await spa.waitForTransition(page);

    // The homeButtonNav SPA transition leaks book A's containerStack into
    // the NEW (home) history entry's state. If we don't clean it, the
    // next book's creation flow inherits a non-null containerStack and
    // tries (and fails) to "restore" it — the symptom is an invisible
    // edit-toolbar in the newly-created book B. Clear it on the home
    // entry only; book A's prior entry keeps its stack untouched.
    await page.evaluate(() => {
      const cur = history.state || {};
      if (cur.containerStack) {
        history.replaceState(
          { ...cur, containerStack: null, containerStackBookId: null, hyperlitContainer: null },
          '',
          window.location.href
        );
      }
    });
    await snap('home (after leaving book A with stack open, state cleaned)');

    // Wait for any in-flight container teardown to settle before opening
    // the new-book overlay.
    await page.waitForFunction(() => {
      return document.querySelectorAll('.hyperlit-container-stacked').length === 0
        && !document.querySelector('#hyperlit-container.open');
    }, null, { timeout: 5000 }).catch(() => {});

    await page.click('#newBook');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');
    await spa.waitForTransition(page);

    // Defensive: if the new book lands with edit-toolbar hidden but
    // isEditing=true (state-leak side-effect we've seen), nudge it by
    // toggling edit mode off-and-on so the toolbar render runs clean.
    try {
      await spa.waitForEditMode(page);
    } catch (e) {
      const isEditing = await page.evaluate(() => window.isEditing === true);
      if (isEditing) {
        await page.click('#editButton');
        await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
        await page.click('#editButton');
      }
      await spa.waitForEditMode(page);
    }
    const bookBId = await spa.getCurrentBookId(page);
    expect(bookBId).toMatch(/^book_\d+/);
    expect(bookBId).not.toBe(bookAId);
    await snap(`B book created ${bookBId}`);

    // Type a paste anchor and paste the hypercite
    await page.click('h1[id="100"]');
    await page.keyboard.type('Paste Destination');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type('paste anchor here');
    await page.waitForTimeout(300);
    await spa.pasteHyperciteContent(page, clipDeepest.html, clipDeepest.text);
    await page.waitForSelector('.main-content a.open-icon[href*="' + clipDeepest.hyperciteId + '"]', { timeout: 10000 });
    await snap('B paste landed');

    // Exit edit mode + wait for sync
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    // ── Click the pasted hypercite link → SPA back to book A ────────
    // Use the existing helper which clicks the open-icon then
    // "See in source text" to perform the navigation.
    //
    // NOTE on assertion depth: the L3 hypercite href encodes the L3
    // sub-book as its target (sourceBookId = `book_X/Fn_L3_id`). When
    // the SPA navigates there, it opens the parent chain up to the
    // PARENT of the hypercite target (typically L2, the hyperlight
    // that contains the L3 footnote ref). The user then clicks the
    // L3 footnote ref to drill in. So we should only expect depth >= 1
    // here, not depth 3.
    await spa.navigateViaHypercite(page);
    await page.waitForTimeout(1000); // allow restoration to settle

    const restoredSnap = await snap('A restored via hypercite click from B');
    expect(restoredSnap.bookId, 'cross-book click should land in book A').toBe(bookAId);

    const visibleStack = restoredSnap.stackedContainersOpen
      + (restoredSnap.openMainContainer ? 1 : 0);
    expect(
      visibleStack,
      `cross-book click should open at least 1 container in book A. ` +
      `Got openMainContainer=${restoredSnap.openMainContainer}, ` +
      `stackedContainersOpen=${restoredSnap.stackedContainersOpen}.`
    ).toBeGreaterThanOrEqual(1);

    // ── Browser-back: walk back through entries, capturing two
    //    load-bearing transitions for strict assertions:
    //
    //    (1) CROSS-BOOK BACK: the first step where bookId transitions
    //        from non-A (book B or null/home) back to book A. THIS is
    //        the path the BookToBookTransition.updateUrlWithStatePreservation
    //        fix targets — if popstate nulls the destination entry's
    //        containerStack, the restored depth at this step will be 0
    //        instead of matching the entry's historyStackDepth.
    //
    //    (2) DEEP-STACK ENTRY (cs=3): book A's original cs=3 entry with
    //        saved containerStack=[L1,L2,L3]. Restoration here must
    //        rebuild all 3 layers (catches the closeContainer-mid-
    //        restoration regression).
    //
    // History at this point (approx):
    //   ..., A-cs=3(saved), A-cs=2, A-cs=1, A-cs=0, home, B-edit,
    //   A-via-click(cs=2) (current)
    //
    // We walk back snapshotting each step, cap at 10 as a safety net.
    let crossBookBackSnap = null;
    let deepStackRestoredSnap = null;
    let prevBookId = restoredSnap.bookId;
    for (let i = 0; i < 10; i++) {
      await page.goBack();
      await spa.waitForTransition(page);
      await page.waitForTimeout(700);
      const s = await snap(`browser-back step ${i + 1}`);

      // (1) Detect the cross-book-back transition: previous step was
      // NOT book A (B or home), this step IS book A.
      if (
        crossBookBackSnap === null
        && s.bookId === bookAId
        && prevBookId !== bookAId
      ) {
        crossBookBackSnap = s;
      }

      // (2) Match the deep-stack entry by both URL marker AND saved
      // containerStack depth — that way we know we're at the exact
      // entry where 3 layers were originally saved, not a coincidental
      // cs=3 entry.
      if (
        s.bookId === bookAId
        && /[?&]cs=3\b/.test(s.url)
        && s.historyStackDepth === 3
      ) {
        deepStackRestoredSnap = s;
        break;
      }
      prevBookId = s.bookId;
    }

    expect(
      crossBookBackSnap,
      'should observe a cross-book popstate transition back into book A during back-walk'
    ).not.toBeNull();
    expect(
      deepStackRestoredSnap,
      'should reach book A deep-stack entry (cs=3 + historyStackDepth=3) via successive browser-back presses'
    ).not.toBeNull();

    // ★ CROSS-BOOK POPSTATE ASSERTION ★
    // At the cross-book back step, the destination entry's saved
    // containerStack (historyStackDepth) must equal the visible stack —
    // i.e. popstate restored what was saved, not a nulled value.
    //
    // Without the BookToBookTransition.updateUrlWithStatePreservation
    // fix, the destination state's containerStack would be nulled
    // before restoration, so historyStackDepth would be 0 (or
    // visibleStack would be 0 if state was preserved but restoration
    // skipped). Either failure mode is caught.
    const crossBookVisible = crossBookBackSnap.stackedContainersOpen
      + (crossBookBackSnap.openMainContainer ? 1 : 0);
    expect(
      crossBookVisible,
      `cross-book popstate must restore saved containerStack. ` +
      `Got historyStackDepth=${crossBookBackSnap.historyStackDepth}, ` +
      `visibleStack=${crossBookVisible} ` +
      `(stackedContainersOpen=${crossBookBackSnap.stackedContainersOpen}, ` +
      `openMainContainer=${crossBookBackSnap.openMainContainer}). ` +
      `URL: ${crossBookBackSnap.url}`
    ).toBe(crossBookBackSnap.historyStackDepth);
    expect(
      crossBookBackSnap.historyStackDepth,
      `cross-book back destination entry should have saved containerStack ` +
      `(non-zero historyStackDepth). If this is 0, the fix preserving ` +
      `containerStack on popstate in BookToBookTransition has regressed.`
    ).toBeGreaterThan(0);

    // ★ THE LOAD-BEARING ASSERTION ★
    // At the deep-stack entry, containerStack=[L1,L2,L3] was saved and
    // popstate restoration must rebuild all 3 layers.
    const deepVisible = deepStackRestoredSnap.stackedContainersOpen
      + (deepStackRestoredSnap.openMainContainer ? 1 : 0);
    expect(
      deepVisible,
      `at book A deep-stack entry, expected 3 containers restored from saved containerStack. ` +
      `Got openMainContainer=${deepStackRestoredSnap.openMainContainer}, ` +
      `stackedContainersOpen=${deepStackRestoredSnap.stackedContainersOpen}, ` +
      `historyStackDepth=${deepStackRestoredSnap.historyStackDepth}. ` +
      `Snapshot: ${spa.summariseSnapshot(deepStackRestoredSnap)}`
    ).toBe(3);

    // Verify all 4 typed phrases are present somewhere in the DOM —
    // catches the closeContainer-mid-restoration regression where
    // the base container visually closed while stacked layers floated
    // over an empty body.
    const textPresence = await page.evaluate((phrases) => {
      const surfaces = [
        document.querySelector('.main-content'),
        ...document.querySelectorAll('.sub-book-content'),
      ];
      const out = {};
      for (const [key, phrase] of Object.entries(phrases)) {
        out[key] = surfaces.some(s => s && (s.textContent || '').includes(phrase));
      }
      return out;
    }, PHRASES);
    expect(textPresence.L0, 'L0 text should be visible (base book)').toBe(true);
    expect(textPresence.L1, 'L1 text should be visible (footnote)').toBe(true);
    expect(textPresence.L2, 'L2 text should be visible (hyperlight)').toBe(true);
    expect(textPresence.L3, 'L3 text should be visible (innermost footnote)').toBe(true);

    // ── Round-trip: forward then back should also restore cleanly ──
    // (Once we've reached the deep-stack entry, forward goes to the
    // next entry in history, then back again should re-restore.)
    await page.goForward();
    await spa.waitForTransition(page);
    await page.waitForTimeout(700);
    await snap('forward step after deep-stack restore');

    await page.goBack();
    await spa.waitForTransition(page);
    await page.waitForTimeout(1000);
    const restoredAgain = await snap('back after forward — deep stack again');
    expect(restoredAgain.bookId, 'browser back should land in book A again').toBe(bookAId);

    const visibleStackAgain = restoredAgain.stackedContainersOpen
      + (restoredAgain.openMainContainer ? 1 : 0);
    expect(
      visibleStackAgain,
      `after forward-then-back cycle, expected 3 containers visible again. ` +
      `Got openMainContainer=${restoredAgain.openMainContainer}, ` +
      `stackedContainersOpen=${restoredAgain.stackedContainersOpen}. ` +
      `Snapshot: ${spa.summariseSnapshot(restoredAgain)}`
    ).toBe(3);

    // ── ★ CROSS-BOOK FORWARD-LEAK DETECTION ★ ───────────────────────
    // User-reported bug (2026-05-16): pressing forward from book A
    // (containers open) into book B leaves book A's containers stuck
    // on top of book B's content, AND they can't be closed (zombie
    // overlays whose handlers are bound to a destroyed page context).
    //
    // The bug is the inverse of the back-restore path: we have a
    // working test for "back to A restores stack", but NO test for
    // "forward away from A tears down stack". The hyperlitManager
    // rebind-instead-of-destroy logic added in core.js for in-use
    // detection may be firing in the wrong context (cross-book book
    // switch) and preventing the previous book's containers from
    // being cleaned up.
    //
    // We currently sit at A-cs=3 (depth 3 restored). Forward history
    // here only contains more book-A entries (the original cross-book
    // entries got truncated during all the back-walking), so we can't
    // simply press forward to reach book B. Instead we trigger a
    // fresh SPA navigation A → B by clicking a programmatic anchor —
    // exactly equivalent to clicking a hypercite that points to B.
    //
    // Then the test sequence is:
    //   (a) After A → B SPA nav: assert no A-containers leaked into B.
    //   (b) Press back → A-cs=3 restored to depth 3.
    //   (c) Press forward → B (popstate, cross-book FORWARD): assert
    //       no A-containers leaked. THIS is the path the user
    //       reproduced manually.
    //
    // At every step capture container *attribution* (which book each
    // open container's sub-book content belongs to) so any failure
    // pinpoints exactly which layers are zombies.
    const captureContainerAttribution = async () => {
      return page.evaluate(() => {
        const inspect = (el, layerName) => {
          const subBook = el.querySelector('[data-book-id]');
          const subBookId = subBook?.getAttribute('data-book-id') || null;
          // ownerBook = the parent book this container's content lives in.
          // data-book-id is either `book_<n>` or `book_<n>/<sub>`; the
          // owner is everything before the first `/`.
          const ownerBook = subBookId ? subBookId.split('/')[0] : null;
          return {
            layer: layerName,
            classes: el.className,
            isOpen: el.classList.contains('open'),
            subBookId,
            ownerBook,
          };
        };
        const out = { currentBook: window.book || null, base: null, stacked: [], orphans: [] };
        const base = document.querySelector('#hyperlit-container');
        if (base && base.classList.contains('open')) {
          out.base = inspect(base, 'base');
        }
        const allStacked = [...document.querySelectorAll('.hyperlit-container-stacked')];
        allStacked.forEach((el, i) => {
          const info = inspect(el, `stacked-${i}`);
          if (info.isOpen) out.stacked.push(info);
          else out.orphans.push(info); // present in DOM but not .open = zombie
        });
        return out;
      });
    };

    const assertNoLeak = (snap, attr, label) => {
      const visible = snap.stackedContainersOpen + (snap.openMainContainer ? 1 : 0);
      expect(
        visible,
        `${label}: expected 0 hyperlit containers visible in destination book, ` +
        `got ${visible} (openMainContainer=${snap.openMainContainer}, ` +
        `stackedContainersOpen=${snap.stackedContainersOpen}). ` +
        `Attribution: base=${JSON.stringify(attr.base)}, ` +
        `stacked=${JSON.stringify(attr.stacked)}.`
      ).toBe(0);

      const all = [
        ...(attr.base ? [attr.base] : []),
        ...attr.stacked,
        ...attr.orphans,
      ];
      const zombies = all.filter(
        c => c.ownerBook && c.ownerBook !== snap.bookId
      );
      expect(
        zombies,
        `${label}: no hyperlit container in the DOM should be bound to a ` +
        `different book. Currently in ${snap.bookId} but found ${zombies.length} ` +
        `container(s) bound to other books: ${JSON.stringify(zombies, null, 2)}. ` +
        `This is the "containers persist from book A into book B" bug.`
      ).toEqual([]);
    };

    // The user's manual repro was navigating between two books that
    // *both* have containers open. To genuinely trigger the leak we
    // need B to have its own stack too — otherwise tearing down A
    // into an empty B isn't testing the same code path as swapping
    // one book's stack for another's.
    //
    // Sequence:
    //   (a) A-cs=3 (depth 3) — current
    //   (b) Synthetic anchor click → SPA nav to B (B-cs=0)
    //   (c) Click pasted hypercite in B → opens reference container
    //       in B (B-cs=1). Now both books have stacks in history.
    //   (d) Back to B-cs=0 (close B's container via popstate)
    //   (e) Back to A-cs=3 — assert A's depth 3 restored, NO B
    //       remnants
    //   (f) Forward to B-cs=0 — assert NO A containers leaked
    //   (g) Forward to B-cs=1 — assert B's container restored, NO A
    //       containers leaked
    //
    // At every step `captureContainerAttribution` records *which book*
    // each open/orphan container's content belongs to. Any container
    // whose `ownerBook` ≠ the current page's bookId is a zombie leak.
    const logAttr = (label, attr) => {
      // eslint-disable-next-line no-console
      console.log(
        `  attribution[${label}]: current=${attr.currentBook} ` +
        `base=${attr.base ? attr.base.ownerBook : 'none'} ` +
        `stacked=[${attr.stacked.map(c => c.ownerBook).join(',')}] ` +
        `orphans=${attr.orphans.length}`
      );
    };

    // (b) A-cs=3 → B via synthetic anchor click.
    await page.evaluate((targetBookId) => {
      const a = document.createElement('a');
      a.href = `/${targetBookId}`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, bookBId);
    await spa.waitForTransition(page);
    await page.waitForTimeout(1000);
    const inB0 = await snap('B-cs=0 reached via SPA nav from A-cs=3');
    const inB0Attr = await captureContainerAttribution();
    logAttr('B-cs=0', inB0Attr);
    expect(inB0.bookId, 'SPA nav A→B should land in book B').toBe(bookBId);
    assertNoLeak(inB0, inB0Attr, 'A→B SPA nav (A had depth 3, B should be clean)');

    // (c) Click the pasted hypercite in B → opens reference container.
    // This is real user behaviour and gives B its own depth-1 stack
    // pushed onto history.
    await page.click(`.main-content a.open-icon[href*="${clipDeepest.hyperciteId}"]`);
    await page.waitForFunction(() => {
      const base = document.querySelector('#hyperlit-container');
      return base && base.classList.contains('open');
    }, null, { timeout: 5000 });
    await page.waitForTimeout(700);
    const inB1 = await snap('B-cs=1: hypercite ref container opened in B');
    const inB1Attr = await captureContainerAttribution();
    logAttr('B-cs=1', inB1Attr);
    expect(inB1.bookId, 'still in book B').toBe(bookBId);
    const inB1Visible = inB1.stackedContainersOpen + (inB1.openMainContainer ? 1 : 0);
    expect(
      inB1Visible,
      `B-cs=1 should have B's own container open (depth 1). ` +
      `Got visibleStack=${inB1Visible}.`
    ).toBeGreaterThanOrEqual(1);
    // B's container's content should belong to A (the source-text panel
    // shows A's content), but the BOOK we're navigating is still B.
    // The leak check is for ORPHAN containers, not legitimate B
    // containers showing A content. So skip leak check here — both
    // are expected at this state.

    // (d) Back: B-cs=1 → B-cs=0. B's container should close.
    await page.goBack();
    await spa.waitForTransition(page);
    await page.waitForTimeout(800);
    const backB0 = await snap('back B-cs=1 → B-cs=0 (B container should close)');
    const backB0Attr = await captureContainerAttribution();
    logAttr('back B-cs=0', backB0Attr);
    expect(backB0.bookId, 'still in B').toBe(bookBId);
    assertNoLeak(backB0, backB0Attr, 'B-cs=1 → B-cs=0 (same-book popstate close)');

    // (e) Back: B-cs=0 → A-cs=3. THIS is the cross-book back path.
    // A's depth-3 stack must restore from saved containerStack, and
    // there must be no remnants of B's container.
    await page.goBack();
    await spa.waitForTransition(page);
    await page.waitForTimeout(1000);
    const backA3 = await snap('back B-cs=0 → A-cs=3 (★ swap B stack for A stack ★)');
    const backA3Attr = await captureContainerAttribution();
    logAttr('back A-cs=3', backA3Attr);
    expect(backA3.bookId, 'back should land in book A').toBe(bookAId);
    const backA3Visible = backA3.stackedContainersOpen + (backA3.openMainContainer ? 1 : 0);
    expect(
      backA3Visible,
      `back from B-cs=0 to A-cs=3 must restore A's depth-3 stack from ` +
      `saved containerStack. Got visibleStack=${backA3Visible}, ` +
      `historyStackDepth=${backA3.historyStackDepth}.`
    ).toBe(3);
    // Orphan check: no zombies left behind from B's session.
    expect(
      backA3Attr.orphans.length,
      `After cross-book back B → A, no orphan .hyperlit-container-stacked ` +
      `DOM nodes should remain from B's session. Found ${backA3Attr.orphans.length}: ` +
      `${JSON.stringify(backA3Attr.orphans, null, 2)}.`
    ).toBe(0);

    // (f) Forward: A-cs=3 → B-cs=0. ★ THE LOAD-BEARING USER REPRO ★
    // Forward from book A (depth-3 stack visible) to book B (no
    // containers expected). User reported A's containers persisting
    // into B here.
    await page.goForward();
    await spa.waitForTransition(page);
    await page.waitForTimeout(1000);
    const fwdB0 = await snap('forward A-cs=3 → B-cs=0 (★ user-bug repro ★)');
    const fwdB0Attr = await captureContainerAttribution();
    logAttr('fwd B-cs=0', fwdB0Attr);
    expect(fwdB0.bookId, 'forward should land in book B').toBe(bookBId);
    assertNoLeak(fwdB0, fwdB0Attr, '★ A→B forward popstate (A had depth 3) — user-reported leak ★');

    // (g) Forward: B-cs=0 → B-cs=1. B's container should restore.
    //
    // Note: B-cs=1 is B's citation-reference panel for the hypercite
    // pasted from A, so the OPEN container legitimately mounts A's
    // source-text content. We can't distinguish "leaked A container"
    // from "legitimate B reference panel showing A content" by
    // data-book-id alone — both look the same. The catchable invariant
    // is COUNT vs historyStackDepth: containers visible must match the
    // saved state's depth. If B-cs=1 saved depth=1 and 1 container is
    // visible → OK. If 2 are visible → one is leaked.
    await page.goForward();
    await spa.waitForTransition(page);
    await page.waitForTimeout(1000);
    const fwdB1 = await snap('forward B-cs=0 → B-cs=1 (B container should restore)');
    const fwdB1Attr = await captureContainerAttribution();
    logAttr('fwd B-cs=1', fwdB1Attr);
    expect(fwdB1.bookId, 'still in B').toBe(bookBId);
    const fwdB1Visible = fwdB1.stackedContainersOpen + (fwdB1.openMainContainer ? 1 : 0);
    expect(
      fwdB1Visible,
      `B-cs=1 popstate must restore exactly historyStackDepth containers — ` +
      `extra containers indicate a leak from book A. ` +
      `Got visibleStack=${fwdB1Visible}, historyStackDepth=${fwdB1.historyStackDepth}.`
    ).toBe(fwdB1.historyStackDepth);
    // Orphan check: no .hyperlit-container-stacked nodes should exist
    // in the DOM without the .open class. Orphans are zombies left
    // behind from the previous book's session.
    expect(
      fwdB1Attr.orphans.length,
      `After forward popstate, no orphan .hyperlit-container-stacked ` +
      `DOM nodes should remain. Found ${fwdB1Attr.orphans.length}: ` +
      `${JSON.stringify(fwdB1Attr.orphans, null, 2)}.`
    ).toBe(0);

    // (h) Bonus: try to close any container in B by clicking the
    // overlay. User reported "can't even be closed" — captured as
    // forensic info regardless of pass/fail above.
    const closeProbe = await page.evaluate(() => {
      const overlays = [
        ...document.querySelectorAll('.hyperlit-container-stacked .container-overlay'),
        ...(document.querySelector('#hyperlit-container .container-overlay') ? [document.querySelector('#hyperlit-container .container-overlay')] : []),
      ];
      const results = [];
      for (const overlay of overlays) {
        try { overlay.click(); results.push({ ok: true }); }
        catch (e) { results.push({ ok: false, error: String(e) }); }
      }
      return { count: overlays.length, results };
    });
    if (closeProbe.count > 0) {
      await page.waitForTimeout(500);
      const afterClose = await captureContainerAttribution();
      logAttr('after close-probe click', afterClose);
    }

    // ── Final forensics ─────────────────────────────────────────────
    await test.info().attach('cross-book-back-timeline.json', {
      body: JSON.stringify(timeline, null, 2),
      contentType: 'application/json',
    });

    const isKnownIdOneCollision = (e) => /Duplicate IDs found:[^a-zA-Z]*1\(\d+\)/.test(e);
    const errors = spa.filterConsoleErrors(page.consoleErrors)
      .filter(e => !/429.*Too Many Requests/i.test(e))
      .filter(e => !/^🔴 ISSUES FOUND:$/.test(e))
      .filter(e => !isKnownIdOneCollision(e));
    expect(errors, `Console errors: ${JSON.stringify(errors)}`).toEqual([]);
  });
});
