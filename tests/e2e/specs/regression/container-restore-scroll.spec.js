import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Container RESTORE-scroll regression.
 *
 * User-reported bug: pressing Back/Forward to a history entry that should show a
 * hyperlit container open AND the main reader scrolled to the associated
 * hypercite/hyperlight reopens the CONTAINER but leaves the MAIN page stuck (often
 * at the top) — the anchor the container is about can't be seen.
 *
 * Sibling of container-scroll-stability.spec.js (which guards open→close scroll).
 * This guards the RESTORE paths:
 *   1. same-book forward:  open → goBack (close) → goForward (restore)
 *   2. full restore:       open → navigate away → goBack (restore)
 * After each, the container must be open AND the reader must be scrolled back to
 * the anchor (readerScrollTop ≈ the pre-open position, NOT ~0 / top).
 *
 * Scroll is measured on .reader-content-wrapper (the real inner scroller).
 *
 * Verbose nav logging is enabled and the decisive [NAV]/resolver/CONTAINER-CLEAR
 * lines are captured + printed on the run so a failure pinpoints WHICH of the
 * resolve→clear→load→reposition→wait steps drops the scroll.
 */

const READER_SCROLLER = '.reader-content-wrapper, .main-content, main';

async function readerScrollTop(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel.split(',')[0].trim())
      || document.querySelector('.main-content')
      || document.querySelector('main');
    return el ? el.scrollTop : null;
  }, READER_SCROLLER);
}

function visibleStack(page) {
  return page.evaluate(() =>
    (document.querySelector('#hyperlit-container.open') ? 1 : 0)
    + document.querySelectorAll('.hyperlit-container-stacked.open').length);
}

const NAV_LINE = /\[NAV\]|Resolver result|CONTAINER CLEAR \(navigation\)|Navigation target ready|Failed to wait for target|Fast-path: chunk|restoreContainerStack|No block found|Resolved chunk .* not found|Initiating navigation to internal ID/;

test.describe('container restore scroll', () => {
  test('back/forward restoring an open container scrolls the reader back to its anchor', async ({ page, spa }) => {
    // scrollTop-based preconditions + assertions ("reader is scrolled
    // down") — the wrapper never scrolls in paginated mode.
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    test.setTimeout(120_000);

    // Verbose nav logs so the decisive lines are emitted, captured below.
    await page.addInitScript(() => {
      try { localStorage.setItem('hyperlit_verbose_logs', 'true'); } catch (e) { /* ignore */ }
    });
    const navLog = [];
    page.on('console', (msg) => {
      const t = msg.text();
      if (NAV_LINE.test(t)) navLog.push(t);
    });
    const dumpNav = (label) => {
      // eslint-disable-next-line no-console
      console.log(`\n──── NAV LOG (${label}) ────\n${navLog.slice(-40).join('\n')}\n────────────────────────────\n`);
    };

    // Small viewport so modest content overflows → real scroll room, target below the fold.
    await page.setViewportSize({ width: 600, height: 500 });

    // ── Setup: author a book with a hyperlight on a phrase below the fold ──
    await spa.createNewBook(page, spa);

    await page.click('h1[id="100"]');
    await page.keyboard.type('Restore Scroll');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);

    for (let i = 0; i < 14; i++) {
      await page.keyboard.type(`Filler paragraph number ${i} — padding the document so the hyperlight target lives well below the fold.`);
      await page.keyboard.press('Enter');
    }
    const TARGET = 'HYPERLIGHT TARGET PHRASE';
    await page.keyboard.type(TARGET);
    await page.waitForTimeout(300);

    await spa.selectInActiveEditor(page, TARGET);
    await spa.hyperlightSelection(page);
    expect(await spa.getStackDepth(page)).toBeGreaterThan(0);

    // Close the authoring container(s) and leave edit mode → read mode.
    let safety = 6;
    while ((await spa.getStackDepth(page)) > 0 && safety-- > 0) {
      await page.evaluate(() => {
        const top = [...document.querySelectorAll('.hyperlit-container-stacked.open')].pop();
        const ov = top?.querySelector('.container-overlay')
          || document.querySelector('#hyperlit-container.open .container-overlay')
          || document.getElementById('ref-overlay');
        ov?.click();
      });
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);

    // Sanity: a clickable hyperlight mark exists in the main text, container closed.
    const markSel = 'mark.user-highlight, mark.highlight, mark[data-highlight-count]';
    const haveMark = await page.waitForSelector(`.main-content ${markSel}`, { timeout: 8000 })
      .then(() => true).catch(() => false);
    test.skip(!haveMark, 'setup could not produce a clickable hyperlight mark below the fold');
    expect(await visibleStack(page)).toBe(0);

    // ── Position the reader so the mark is on-screen with scroll room above ──
    await page.evaluate((sel) => {
      document.querySelector(`.main-content ${sel}`)?.scrollIntoView({ block: 'center' });
    }, markSel);
    await page.waitForTimeout(300);

    const scrollBeforeOpen = await readerScrollTop(page);
    expect(scrollBeforeOpen, 'precondition: reader is scrolled down (target below the fold)').toBeGreaterThan(50);

    // ── Open the container by clicking the hyperlight mark (read mode) ──
    navLog.length = 0;
    await page.evaluate((sel) => {
      document.querySelector(`.main-content ${sel}`)?.click();
    }, markSel);
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 8000 });
    await page.waitForTimeout(400);
    expect(await visibleStack(page), 'container should be open after clicking the mark').toBeGreaterThanOrEqual(1);

    const bookId = await spa.getCurrentBookId(page);

    // Helper: assert "restored": container open AND reader scrolled back to the anchor.
    const assertRestored = async (label) => {
      const stack = await visibleStack(page);
      const top = await readerScrollTop(page);
      dumpNav(label);
      expect(stack, `${label}: container should be open after restore`).toBeGreaterThanOrEqual(1);
      expect(
        Math.abs(top - scrollBeforeOpen),
        `${label}: reader NOT scrolled back to anchor — before=${scrollBeforeOpen}, afterRestore=${top} (top≈0 means stuck at page top)`
      ).toBeLessThan(60);
    };

    // ── Scenario 1: same-book FORWARD restore (goBack closes, goForward restores) ──
    navLog.length = 0;
    await page.goBack();
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return !c || !c.classList.contains('open');
    }, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);

    await page.goForward();
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
    await assertRestored('scenario-1 same-book forward');

    // ── Scenario 2: full restore from a FRESH main load (the user's confirmed-failing case) ──
    // Reproduce the cross-book/refresh path where the reader (re)loads from scratch and the
    // container is rebuilt from history.state.containerStack. To isolate the container-restore
    // scroll from the two OTHER things that could coincidentally scroll main:
    //   - strip the URL hash (the user's failing case had hash:"" — only ?cs=N), so the
    //     fresh-load hash-nav can't drive the scroll;
    //   - clear the saved reading position, so resume-scroll can't land on the anchor either.
    // After this, the ONLY mechanism that can put the reader on the anchor is the container
    // restoration scrolling main to its metadata anchor.
    navLog.length = 0;
    await page.evaluate((bid) => {
      try {
        const u = new URL(location.href);
        u.hash = '';
        history.replaceState(history.state, '', u.pathname + u.search); // keep ?cs=N + containerStack
        for (const store of [sessionStorage, localStorage]) {
          store.removeItem(`scrollPosition_${bid}`);
          store.removeItem(`scrollPosition_latest`);
        }
      } catch (e) { /* ignore */ }
    }, bookId);

    await page.reload();
    // Container is rebuilt from history.state on fresh load (initializePage.fresh → restoreContainerStack).
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200); // let the restore's layer waits + any main nav settle
    await assertRestored('scenario-2 fresh-load restore (hash-stripped reload)');
  });
});
