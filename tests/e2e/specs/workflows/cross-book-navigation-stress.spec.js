import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Cross-book navigation stress test.
 *
 * Hunting for the user-reported bug class (2026-05-16): "hyperlit
 * containers from book A persisting into book B" when navigating via
 * back/forward buttons, AND containers that can't be closed (zombie
 * overlays whose handlers are bound to a destroyed page context).
 *
 * Two books, both with rich content (footnote + hyperlight + a
 * cross-reference hypercite). The test runs many cycles of mixed
 * actions — open container, close, back-back-forward, scroll, click
 * hypercite, etc — across book boundaries, and at every step asserts
 * the load-bearing invariants:
 *
 *   (1) ORPHAN check: zero `.hyperlit-container-stacked` DOM nodes
 *       without the `.open` class. Orphans are the literal "zombie
 *       containers stuck on top" the user reported.
 *
 *   (2) COUNT-vs-DEPTH check: number of visible containers === the
 *       current history entry's `historyStackDepth`. If the SPA
 *       restored fewer than were saved (under-restore), or left
 *       extras over from a prior page (leak), this fails.
 *
 *   (3) ATTRIBUTION trace: at every step we record which book each
 *       open/orphan container's content is bound to. On failure the
 *       trace pinpoints exactly which containers are zombies.
 *
 *   (4) CLOSE-PROBE: on every step that has visible containers, we
 *       record whether overlay-clicks successfully close them. The
 *       "can't even be closed" symptom is captured as forensic info
 *       in the timeline attachment.
 *
 * The action sequence is FIXED (not randomised) so failures are
 * deterministically reproducible. If we want more aggressive coverage
 * later, add more scenarios; don't roll dice.
 */

const PHRASES = {
  AL0: 'AmainAlphaXX',
  AL1: 'AfootnoteBetaXX',
  AL2: 'AhyperlightGammaXX',
  AL3: 'AnestedFootnoteDeltaXX',
  BL0: 'BmainEpsilonXX',
  BL1: 'BfootnoteZetaXX',
};

test.describe('Cross-book navigation stress', () => {
  test('mixed back/forward cycles across two books with containers should not leak', async ({ page, spa }) => {
    test.setTimeout(360_000); // 6 min — stress walk takes time

    const timeline = [];
    const snap = async (label) => {
      const s = await spa.snapshotPageState(page, label);
      timeline.push(s);
      // eslint-disable-next-line no-console
      console.log(spa.summariseSnapshot(s));
      return s;
    };

    // captureContainerAttribution — captures which book each open or
    // orphan hyperlit-container's content belongs to. ownerBook is
    // derived from the data-book-id of the [data-book-id] element
    // mounted inside the container, taking the prefix before the
    // first `/` (so `book_X/Fn_Y` → ownerBook=book_X).
    const captureAttr = async () => {
      return page.evaluate(() => {
        const inspect = (el, layerName) => {
          const subBook = el.querySelector('[data-book-id]');
          const subBookId = subBook?.getAttribute('data-book-id') || null;
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
        if (base) {
          const info = inspect(base, 'base');
          if (info.isOpen) out.base = info;
        }
        const allStacked = [...document.querySelectorAll('.hyperlit-container-stacked')];
        allStacked.forEach((el, i) => {
          const info = inspect(el, `stacked-${i}`);
          if (info.isOpen) out.stacked.push(info);
          else out.orphans.push(info);
        });
        return out;
      });
    };

    const visibleStack = (s) =>
      s.stackedContainersOpen + (s.openMainContainer ? 1 : 0);

    // assertHealthy — the per-step invariant check. Captures attr +
    // snapshot, logs the attribution trace, and asserts:
    //   - zero orphans
    //   - visibleStack matches historyStackDepth (when not in a
    //     mid-transition state)
    // expectedDepth: pass null to derive from historyStackDepth (the
    // normal case). Pass a specific number when you know exactly what
    // depth this action should produce (e.g. just opened a container).
    const assertHealthy = (label, s, attr, expectedDepth = null) => {
      const want = expectedDepth ?? s.historyStackDepth;
      const got = visibleStack(s);
      // eslint-disable-next-line no-console
      console.log(
        `  attr[${label}]: window.book=${attr.currentBook} ` +
        `base=${attr.base ? attr.base.ownerBook : 'none'} ` +
        `stacked=[${attr.stacked.map(c => c.ownerBook).join(',')}] ` +
        `orphans=${attr.orphans.length} ` +
        `visible=${got} histDepth=${s.historyStackDepth} want=${want}`
      );
      expect(
        attr.orphans.length,
        `${label}: orphan zombies found (${attr.orphans.length}) — ` +
        `.hyperlit-container-stacked DOM nodes without .open class. ` +
        `${JSON.stringify(attr.orphans, null, 2)}`
      ).toBe(0);
      expect(
        got,
        `${label}: visible container count (${got}) ≠ expected (${want}). ` +
        `historyStackDepth=${s.historyStackDepth}, ` +
        `openMainContainer=${s.openMainContainer}, ` +
        `stackedContainersOpen=${s.stackedContainersOpen}. ` +
        `Attribution: base=${JSON.stringify(attr.base)}, ` +
        `stacked=${JSON.stringify(attr.stacked)}.`
      ).toBe(want);
    };

    // closeProbe — for every step with visible containers, try clicking
    // overlays and record whether they close. We don't ASSERT this (the
    // count-check above is the primary leak detector) — but the
    // forensic record helps diagnose the "can't be closed" symptom.
    const closeProbeRecord = [];
    const tryCloseAll = async (label) => {
      const before = await captureAttr();
      const totalBefore = (before.base ? 1 : 0) + before.stacked.length;
      if (totalBefore === 0) return;
      const probe = await page.evaluate(() => {
        const overlays = [
          ...document.querySelectorAll('.hyperlit-container-stacked.open .container-overlay'),
        ];
        const baseOv = document.querySelector('#hyperlit-container.open .container-overlay');
        if (baseOv) overlays.push(baseOv);
        const results = [];
        for (const o of overlays) {
          try { o.click(); results.push({ ok: true }); }
          catch (e) { results.push({ ok: false, error: String(e) }); }
        }
        return { count: overlays.length, results };
      });
      await page.waitForTimeout(400);
      const after = await captureAttr();
      const totalAfter = (after.base ? 1 : 0) + after.stacked.length;
      closeProbeRecord.push({
        label,
        totalBefore,
        clicked: probe.count,
        totalAfter,
        clickResults: probe.results,
        closedSuccessfully: totalAfter < totalBefore,
      });
    };

    // ═══════════════════════════════════════════════════════════════
    // SETUP — Build book A (depth-3 nest, hypercite on L3)
    // ═══════════════════════════════════════════════════════════════
    const { bookId: bookAId } = await spa.createNewBook(page, spa);
    await snap(`A book created ${bookAId}`);

    await page.click('h1[id="100"]');
    await page.keyboard.type('Stress Test A');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type(PHRASES.AL0);
    await page.waitForTimeout(400);

    await spa.insertFootnoteAtCaret(page);
    expect(await spa.getStackDepth(page)).toBe(1);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.AL1);
    await page.waitForTimeout(300);

    await spa.selectInActiveEditor(page, PHRASES.AL1);
    await spa.hyperlightSelection(page);
    expect(await spa.getStackDepth(page)).toBe(2);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.AL2);
    await page.waitForTimeout(300);

    await spa.insertFootnoteAtCaret(page);
    expect(await spa.getStackDepth(page)).toBe(3);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.AL3);
    await page.waitForTimeout(400);

    await spa.selectInActiveEditor(page, PHRASES.AL3);
    const clipA = await spa.copyHyperciteFromActiveEditor(page);
    expect(clipA.hyperciteId).toMatch(/^hypercite_/);
    await snap(`A built + hypercite copied ${clipA.hyperciteId}`);

    // Sync wait
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);

    // ═══════════════════════════════════════════════════════════════
    // SETUP — Leave A (state-clean home entry), create book B
    // (with a footnote + a paste of A's hypercite)
    // ═══════════════════════════════════════════════════════════════
    await page.evaluate(() => {
      const logoNav = document.getElementById('homeButtonNav');
      if (logoNav) logoNav.click();
    });
    await spa.waitForTransition(page);
    await page.evaluate(() => {
      const cur = history.state || {};
      if (cur.containerStack) {
        history.replaceState(
          { ...cur, containerStack: null, containerStackBookId: null, hyperlitContainer: null },
          '', window.location.href
        );
      }
    });
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
    try { await spa.waitForEditMode(page); }
    catch (e) {
      const isEditing = await page.evaluate(() => window.isEditing === true);
      if (isEditing) {
        await page.click('#editButton');
        await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
        await page.click('#editButton');
      }
      await spa.waitForEditMode(page);
    }
    const bookBId = await spa.getCurrentBookId(page);
    expect(bookBId).not.toBe(bookAId);

    await page.click('h1[id="100"]');
    await page.keyboard.type('Stress Test B');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type(PHRASES.BL0);
    await page.waitForTimeout(300);

    // Paste A's hypercite into B's main body
    await spa.pasteHyperciteContent(page, clipA.html, clipA.text);
    await page.waitForSelector(
      `.main-content a.open-icon[href*="${clipA.hyperciteId}"]`,
      { timeout: 10000 }
    );
    await page.waitForTimeout(400);

    // Add a footnote in B at end of body, type into it
    await spa.insertFootnoteAtCaret(page);
    expect(await spa.getStackDepth(page)).toBe(1);
    await spa.typeAtEndOfActiveEditor(page, PHRASES.BL1);
    await page.waitForTimeout(300);

    await snap(`B built ${bookBId} with paste + footnote`);

    // Sync wait
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});

    // Close any open containers FIRST. #ref-overlay (base container's
    // backdrop) intercepts the editButton click otherwise. Order: pop
    // stacked layers from top down, then the base container.
    let safety = 8;
    while ((await spa.getStackDepth(page)) > 0 && safety-- > 0) {
      await page.evaluate(() => {
        const topStacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')].pop();
        if (topStacked) {
          const ov = topStacked.querySelector('.container-overlay');
          if (ov) { ov.click(); return; }
        }
        const base = document.querySelector('#hyperlit-container.open');
        if (base) {
          const ov = base.querySelector('.container-overlay') || document.getElementById('ref-overlay');
          if (ov) ov.click();
        }
      });
      await page.waitForTimeout(500);
    }

    // Programmatic editButton click — bypasses overlay intercept if
    // any backdrop remains. The README documents this trick for
    // off-screen / overlay-blocked perimeter buttons.
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    await snap(`B ready for stress (containers closed, edit mode off)`);

    // ═══════════════════════════════════════════════════════════════
    // STRESS LOOP — fixed action sequence for reproducibility.
    //
    // Each action either:
    //   - navigates (back/forward/spa-nav-to-other-book)
    //   - opens a container (click hypercite open-icon)
    //   - scrolls
    //
    // After every action: snapshot + assertHealthy (orphans=0 and
    // visible-count = historyStackDepth). Containers are probed for
    // closability on every step where any are open.
    // ═══════════════════════════════════════════════════════════════

    // Action helpers
    const doBack = async () => {
      const beforeUrl = await page.evaluate(() => window.location.href);
      await page.goBack();
      await spa.waitForTransition(page);
      await page.waitForTimeout(700);
      const afterUrl = await page.evaluate(() => window.location.href);
      return beforeUrl !== afterUrl;
    };
    const doForward = async () => {
      const beforeUrl = await page.evaluate(() => window.location.href);
      await page.goForward();
      await spa.waitForTransition(page);
      await page.waitForTimeout(700);
      const afterUrl = await page.evaluate(() => window.location.href);
      return beforeUrl !== afterUrl;
    };
    const doSpaNavToOtherBook = async (targetBookId) => {
      await page.evaluate((id) => {
        const a = document.createElement('a');
        a.href = `/${id}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, targetBookId);
      await spa.waitForTransition(page);
      await page.waitForTimeout(800);
    };
    const doClickHypercite = async (hyperciteId) => {
      const selector = `.main-content a.open-icon[href*="${hyperciteId}"]`;
      const exists = await page.locator(selector).count();
      if (!exists) return false;
      await page.click(selector);
      await page.waitForFunction(() => {
        const base = document.querySelector('#hyperlit-container');
        return base && base.classList.contains('open');
      }, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(700);
      return true;
    };
    const doScroll = async (px) => {
      await page.evaluate((p) => window.scrollBy(0, p), px);
      await page.waitForTimeout(300);
    };

    // Fixed sequence — design hits the spots most likely to leak:
    //   - direction reversal (back→forward)
    //   - bursts of same direction (back, back, back)
    //   - cross-book transitions inside bursts
    //   - opening containers between transitions
    //   - mixed scroll/open/navigation
    const sequence = [
      { name: 'spa-nav→A', fn: () => doSpaNavToOtherBook(bookAId) },
      { name: 'back', fn: doBack },
      { name: 'forward', fn: doForward },
      { name: 'forward', fn: doForward },
      { name: 'back', fn: doBack },
      { name: 'back', fn: doBack },
      { name: 'spa-nav→B', fn: () => doSpaNavToOtherBook(bookBId) },
      { name: 'click-hypercite-in-B→A', fn: () => doClickHypercite(clipA.hyperciteId) },
      { name: 'back', fn: doBack },
      { name: 'forward', fn: doForward },
      { name: 'back', fn: doBack },
      { name: 'back', fn: doBack },
      { name: 'forward', fn: doForward },
      { name: 'forward', fn: doForward },
      { name: 'forward', fn: doForward },
      { name: 'scroll-down', fn: () => doScroll(400) },
      { name: 'back', fn: doBack },
      { name: 'scroll-up', fn: () => doScroll(-400) },
      { name: 'forward', fn: doForward },
      { name: 'spa-nav→A', fn: () => doSpaNavToOtherBook(bookAId) },
      { name: 'spa-nav→B', fn: () => doSpaNavToOtherBook(bookBId) },
      { name: 'back', fn: doBack },
      { name: 'back', fn: doBack },
      { name: 'back', fn: doBack },
      { name: 'forward', fn: doForward },
      { name: 'forward', fn: doForward },
      { name: 'click-hypercite', fn: () => doClickHypercite(clipA.hyperciteId) },
      { name: 'back', fn: doBack },
      { name: 'back', fn: doBack },
      { name: 'forward', fn: doForward },
    ];

    for (let i = 0; i < sequence.length; i++) {
      const step = sequence[i];
      const advanced = await step.fn();
      const s = await snap(`step ${i + 1}: ${step.name}${advanced === false ? ' (no-op)' : ''}`);
      const attr = await captureAttr();
      assertHealthy(`step ${i + 1} (${step.name})`, s, attr);
      // probe closability when there's something to close
      if (visibleStack(s) > 0) {
        await tryCloseAll(`step ${i + 1} (${step.name})`);
        // After tryCloseAll, the test mutated state — re-snapshot for
        // the next iteration so subsequent navigations start from the
        // user-cleared state, mirroring real interaction.
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Final forensics
    // ═══════════════════════════════════════════════════════════════
    await test.info().attach('cross-book-stress-timeline.json', {
      body: JSON.stringify(timeline, null, 2),
      contentType: 'application/json',
    });
    await test.info().attach('close-probe-record.json', {
      body: JSON.stringify(closeProbeRecord, null, 2),
      contentType: 'application/json',
    });

    // close-probe diagnostic: any step where overlay clicks didn't
    // reduce container count is suspect. We log but don't fail on
    // this (the count-check is the primary fail signal).
    const stuckCloses = closeProbeRecord.filter(r => r.clicked > 0 && !r.closedSuccessfully);
    if (stuckCloses.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `\n  ⚠ ${stuckCloses.length} close-probe step(s) failed to reduce ` +
        `container count after clicking overlay(s) — see ` +
        `close-probe-record.json attachment for details.`
      );
    }

    const isKnownIdOneCollision = (e) => /Duplicate IDs found:[^a-zA-Z]*1\(\d+\)/.test(e);
    const errors = spa.filterConsoleErrors(page.consoleErrors)
      .filter(e => !/429.*Too Many Requests/i.test(e))
      .filter(e => !/^🔴 ISSUES FOUND:$/.test(e))
      .filter(e => !isKnownIdOneCollision(e));
    expect(errors, `Console errors during stress: ${JSON.stringify(errors)}`).toEqual([]);
  });
});
