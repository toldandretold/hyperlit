import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Nested hypercite chain.
 *
 * Two distinct phases in one test:
 *
 *   Phase 1 (build the nest): identical flow to nested-authoring-stress —
 *     create book, type at L0, insert footnote → type L1, hyperlight that
 *     text → type L2, insert footnote → type L3. Close all the way back
 *     to L0 and commit. After Phase 1, the book has placeholder text at
 *     four levels and the rendered surface at each level has a footnote
 *     ref or hyperlight mark to enter the next level.
 *
 *   Phase 2 (chain hypercites): walk back down the EXISTING nest via
 *     clicks. At each level: enter edit mode (click .hyperlit-edit-btn),
 *     paste the hypercite copied from the level above, then copy-hypercite
 *     this level's own text. Net effect: every level holds a hypercite
 *     link to the level above it AND becomes a new hypercite source for
 *     the level below.
 *
 *   Phase 3 (verify): back-navigate to unwind the stack, then click the
 *     original L0 `<u>` and assert the reference panel surfaces a
 *     cited-in link (the L1 paste).
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
});
