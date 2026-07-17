import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Paginated reading mode — the invariants that broke during development,
 * pinned as real-browser behavior. Each test drives pages mode itself (via
 * localStorage init script), so this spec is meaningful in BOTH normal runs
 * and `npm run test:e2e:pages` sweeps.
 *
 * The book: E2E_AIREVIEW_BOOK (public, real content, contains hypercites).
 */

const BOOK = process.env.E2E_AIREVIEW_BOOK;

/** First fragment of `id` horizontally intersects the wrapper's visible band. */
async function targetOnCurrentPage(page, id) {
  return page.evaluate((targetId) => {
    const w = document.querySelector('.reader-content-wrapper');
    const el = document.getElementById(targetId);
    if (!w || !el) return { ok: false, why: el ? 'no wrapper' : 'target not in DOM' };
    const c = w.getBoundingClientRect();
    const r = el.getClientRects()[0] || el.getBoundingClientRect();
    return {
      ok: r.right > c.left + 1 && r.left < c.right - 1,
      why: `frag [${Math.round(r.left)},${Math.round(r.right)}] wrap [${Math.round(c.left)},${Math.round(c.right)}]`,
    };
  }, id);
}

test.describe('paginated reading mode', () => {
  test.skip(!BOOK, 'E2E_AIREVIEW_BOOK not set in tests/e2e/.env.e2e');

  // These tests flip reading mode via the REAL settings toggle
  // (readingModeSwitcher → savePreference), which PERSISTS reading_mode to the
  // SHARED e2e user's SERVER prefs. Because seedFromServer makes "backend wins"
  // (utilities/preferences.ts), leaving it =paginated poisons every spec that
  // boots AFTER this file — the scroll-mechanics specs (reading-position-save,
  // container-restore-scroll, resume-vs-jump, …) then fail as phantom
  // pages-mode regressions. Reset it to scroll after every test so the leak
  // can't cross the spec boundary. NOT during the pages sweep
  // (E2E_READING_MODE=paginated), which deliberately wants it persisted.
  test.afterEach(async ({ page }) => {
    if (process.env.E2E_READING_MODE === 'paginated') return;
    try {
      if (!/^https?:/.test(page.url())) {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
      }
      await page.evaluate(async () => {
        const token = document.querySelector('meta[name="csrf-token"]')?.content;
        if (!token) return;
        await fetch('/api/user/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token, 'Accept': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ reading_mode: null }),
        });
        localStorage.removeItem('hyperlit_reading_mode');
      });
    } catch { /* best-effort cleanup; auth.setup re-normalizes next run */ }
  });

  test('cold deep link to a hypercite lands on its page despite a stale saved position', async ({ browser }) => {
    test.setTimeout(120_000);

    // The target is an env fixture (like E2E_READER_BOOK itself): runtime
    // discovery is not possible — the gate's always-on foreign-singles filter
    // keeps this hypercite OUT of the book's data payload; deep-link nav
    // fetches it on demand, which is exactly the path under test.
    const hcId = process.env.E2E_AIREVIEW_HYPERCITE;
    test.skip(!hcId, 'E2E_AIREVIEW_HYPERCITE not set in tests/e2e/.env.e2e');

    // THE REGRESSION CASE: a brand-new browser (cold IndexedDB) opening a
    // pasted #hypercite_ URL in pages mode, WITH a stale saved reading
    // position pointing somewhere else (in real life this arrives seeded
    // from the server bookmark). The paginator must not position/save from
    // that stale anchor before restore's hash-jump runs — that re-stamped
    // savedAt and flipped resume-vs-jump against the hash, so the hypercite
    // never appeared.
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const fresh = await ctx.newPage();
    await fresh.addInitScript(([bookId]) => {
      indexedDB.deleteDatabase('hyperlit');
      localStorage.clear();
      localStorage.setItem('hyperlit_reading_mode', 'paginated');
      // Stale-but-recent bookmark far from the deep-link target.
      localStorage.setItem(
        `scrollPosition_${bookId}`,
        JSON.stringify({ elementId: '400', offset: 0, savedAt: Date.now() })
      );
    }, [BOOK]);

    await fresh.goto(`/${BOOK}#${hcId}`);
    await fresh.waitForSelector('.chunk [id]', { timeout: 30000 });
    // Give restore + chunk load + any preference reflow time to fully settle.
    await fresh.waitForFunction(
      (targetId) => !!document.getElementById(targetId),
      hcId,
      { timeout: 20000 }
    );
    await fresh.waitForTimeout(4000);

    expect(await fresh.evaluate(() => !!document.querySelector('.paginated-active'))).toBe(true);
    let landing = await targetOnCurrentPage(fresh, hcId);
    expect(landing.ok, `deep-link target must be on the visible page (${landing.why})`).toBe(true);

    // And it must STAY there through the post-boot settle window (font-size
    // preference reflow, background chunk downloads) — the re-anchor must
    // track the nav target, not the page's first paragraph.
    await fresh.waitForTimeout(4000);
    landing = await targetOnCurrentPage(fresh, hcId);
    expect(landing.ok, `deep-link target must SURVIVE post-boot reflows (${landing.why})`).toBe(true);

    await ctx.close();
  });

  test('open → toggle pages → navigate to hypercite → refresh RESUMES to the hypercite page', async ({ page }) => {
    test.setTimeout(120_000);
    const hcId = process.env.E2E_AIREVIEW_HYPERCITE;
    test.skip(!hcId, 'E2E_AIREVIEW_HYPERCITE not set in tests/e2e/.env.e2e');

    // The user's exact bug report: the hypercite lives mid-way through a
    // paragraph LONGER THAN A PAGE. On refresh, restore RESUMES to the saved
    // reading position — which is that paragraph's node id. The node id alone
    // maps to the paragraph's FIRST page; the reader was two pages deeper, on
    // the hypercite. forceSavePosition must record the page-WITHIN-node and
    // restore must replay it, or the hypercite is off-screen after refresh.
    await page.goto(`/${BOOK}`); // NB: pages mode already set by the fixture init script
    await page.waitForSelector('.chunk [id]', { timeout: 20000 });
    await page.waitForTimeout(1500);

    // Navigate to the hypercite (same-tab hash nav), landing on its page.
    await page.goto(`/${BOOK}#${hcId}`);
    await page.waitForFunction((id) => !!document.getElementById(id), hcId, { timeout: 20000 });
    await page.waitForTimeout(2500); // let the landing position save
    let landing = await targetOnCurrentPage(page, hcId);
    expect(landing.ok, `hypercite must be on the page after nav (${landing.why})`).toBe(true);

    // Refresh — the crux. Restore resumes the saved node position; it must land
    // back on the hypercite's page, not the paragraph's first page.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((id) => !!document.getElementById(id), hcId, { timeout: 20000 });
    await page.waitForTimeout(4000);
    landing = await targetOnCurrentPage(page, hcId);
    expect(landing.ok, `hypercite must be on the page after REFRESH (${landing.why})`).toBe(true);
  });

  test('settings toggle engages pages, arrows turn exactly one stride, toggle back restores scroll', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/${BOOK}`);
    await page.waitForSelector('.chunk [id]', { timeout: 20000 });
    await page.waitForTimeout(1500);

    await page.click('#settingsButton');
    await page.waitForSelector('#paginatedModeButton', { state: 'visible' });
    await page.click('#paginatedModeButton');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const state = await page.evaluate(() => {
      const w = document.querySelector('.reader-content-wrapper');
      return {
        engaged: w.classList.contains('paginated-active'),
        prevHidden: document.getElementById('pageNavPrev')?.hidden,
        nextHidden: document.getElementById('pageNavNext')?.hidden,
      };
    });
    expect(state.engaged, 'wrapper gains .paginated-active').toBe(true);
    expect(state.prevHidden).toBe(false);
    expect(state.nextHidden).toBe(false);

    // Mid-session engagement lands at the SAVED anchor (whatever page that
    // is for this user) — assert the turn as a DELTA, not an absolute.
    const stride = await page.evaluate(() => document.querySelector('.reader-content-wrapper').clientWidth);
    const beforeTurn = await page.evaluate(() => Math.round(document.querySelector('.reader-content-wrapper').scrollLeft));
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(900); // smooth scroll + settle snap
    const afterTurn = await page.evaluate(() => Math.round(document.querySelector('.reader-content-wrapper').scrollLeft));
    expect(afterTurn - beforeTurn, 'ArrowRight moves exactly one stride').toBe(stride);

    // Anchor round-trip back to scroll mode.
    const anchorId = await page.evaluate(() => {
      const w = document.querySelector('.reader-content-wrapper');
      const c = w.getBoundingClientRect();
      for (const el of document.querySelectorAll('.chunk > [id]')) {
        if (!/^\d+(\.\d+)?$/.test(el.id)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > c.left + 1 && r.left < c.right - 1 && (r.width || r.height)) return el.id;
      }
      return null;
    });
    await page.click('#settingsButton');
    await page.waitForSelector('#scrollModeButton', { state: 'visible' });
    await page.click('#scrollModeButton');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');

    const back = await page.evaluate((id) => {
      const w = document.querySelector('.reader-content-wrapper');
      const el = document.getElementById(id);
      const c = w.getBoundingClientRect();
      const r = el?.getBoundingClientRect();
      return {
        engaged: w.classList.contains('paginated-active'),
        anchorVisible: !!r && r.bottom > c.top && r.top < c.bottom,
      };
    }, anchorId);
    expect(back.engaged, 'scroll mode restored').toBe(false);
    expect(back.anchorVisible, 'same content visible after toggling back').toBe(true);
  });

  test('one trackpad gesture (with momentum tail) turns exactly one page', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/${BOOK}`);
    await page.waitForSelector('.chunk [id]', { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.click('#settingsButton');
    await page.waitForSelector('#paginatedModeButton', { state: 'visible' });
    await page.click('#paginatedModeButton');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const stride = await page.evaluate(() => document.querySelector('.reader-content-wrapper').clientWidth);
    const start = await page.evaluate(() => Math.round(document.querySelector('.reader-content-wrapper').scrollLeft));

    // Realistic decaying momentum stream (~700ms) — must turn ONE page, not two.
    await page.mouse.move(640, 400);
    for (const d of [40, 60, 55, 45, 35, 28, 20, 14, 10, 7, 5, 3, 2, 2, 1, 1]) {
      await page.mouse.wheel(0, d);
      await page.waitForTimeout(45);
    }
    await page.waitForTimeout(1200); // settle snap
    const end = await page.evaluate(() => Math.round(document.querySelector('.reader-content-wrapper').scrollLeft));
    expect(end - start, 'one gesture = one page').toBe(stride);
  });

  // A swipe helper: a rising-then-decaying delta stream with a low-magnitude
  // momentum tail (the tail dregs the browser keeps streaming for ~1s).
  async function swipeForward(page, tailMs = 40) {
    const active = [40, 60, 50, 40, 30, 22]; // finger-driven, above the momentum floor
    const tail = [15, 10, 7, 4, 2, 1, 1];    // decaying momentum dregs, below the floor
    for (const d of active) { await page.mouse.wheel(0, d); await page.waitForTimeout(tailMs); }
    for (const d of tail) { await page.mouse.wheel(0, d); await page.waitForTimeout(tailMs); }
  }

  async function enterPagesMode(page) {
    await page.goto(`/${BOOK}`);
    await page.waitForSelector('.chunk [id]', { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.click('#settingsButton');
    await page.waitForSelector('#paginatedModeButton', { state: 'visible' });
    await page.click('#paginatedModeButton');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.mouse.move(640, 400);
  }

  const geom = (page) => page.evaluate(() => {
    const w = document.querySelector('.reader-content-wrapper');
    return { stride: w.clientWidth, left: Math.round(w.scrollLeft) };
  });

  test('a second swipe into the momentum tail still turns the page', async ({ page }) => {
    // The "turns one page then stops dead" bug: on a trackpad the first swipe's
    // momentum tail streams for >1s; keeping the gesture alive on every event
    // swallowed a second swipe made before the tail fully died. The gap now
    // only counts SIGNIFICANT motion, so the re-swipe re-arms.
    test.setTimeout(120_000);
    await enterPagesMode(page);
    const { stride, left: start } = await geom(page);

    await swipeForward(page);
    await page.waitForTimeout(90); // no clean all-event gap — tail is still dribbling
    await swipeForward(page);
    await page.waitForTimeout(1200); // settle snap

    const { left: end } = await geom(page);
    expect(end - start, 'two swipes = two pages').toBe(stride * 2);
  });

  test('one bumpy swipe (finger speeds up mid-glide) still turns exactly one page', async ({ page }) => {
    // A real swipe is not smooth: the finger slows then speeds up, so the delta
    // stream dips and rises WITHIN one gesture. That must NOT read as a second
    // swipe — the earlier magnitude-rebound heuristic double-turned here.
    test.setTimeout(120_000);
    await enterPagesMode(page);
    const { stride, left: start } = await geom(page);

    // One continuous swipe with brief sub-floor dips (12) between fast strokes —
    // none long enough to open a real gap in significant motion.
    const bumpy = [40, 60, 20, 12, 25, 30, 20, 12, 22, 30, 18, 10, 6, 3, 2, 1];
    for (const d of bumpy) { await page.mouse.wheel(0, d); await page.waitForTimeout(40); }
    await page.waitForTimeout(1200); // settle snap

    const { left: end } = await geom(page);
    expect(end - start, 'one bumpy gesture = one page').toBe(stride);
  });

  test('reading position survives a Scroll <-> Pages round-trip mid-book', async ({ page }) => {
    // Toggling reading mode must keep your place. The paginator captures the
    // CURRENT anchor (getFreshAnchor, before the layout flips) on Scroll->Pages
    // and firstElementOnCurrentPage on Pages->Scroll — a jump to the top means
    // that handoff broke.
    test.setTimeout(120_000);
    await page.goto(`/${BOOK}`);
    await page.waitForSelector('.chunk [id]', { timeout: 20000 });
    await page.waitForTimeout(1500);

    // Start in SCROLL mode (the shared e2e user's saved pref may be paginated).
    const startedPaginated = await page.evaluate(() =>
      !!document.querySelector('.reader-content-wrapper')?.classList.contains('paginated-active'));
    if (startedPaginated) {
      await page.click('#settingsButton');
      await page.waitForSelector('#scrollModeButton', { state: 'visible' });
      await page.click('#scrollModeButton');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    // Scroll several screens deep so we are clearly NOT at the top.
    const scrolled = await page.evaluate(() => {
      const w = document.querySelector('.reader-content-wrapper');
      const target = Math.min(w.scrollHeight - w.clientHeight - 1, w.clientHeight * 3);
      w.scrollTop = target;
      return { target: Math.round(target), max: Math.round(w.scrollHeight - w.clientHeight) };
    });
    // Book too short to have a meaningful mid-book position → nothing to assert.
    test.skip(scrolled.target < 200, 'book too short to scroll mid-way');
    await page.waitForTimeout(700); // 250ms save throttle + settle

    // The node at the top of the viewport (below the 192px header band) is the
    // reading anchor we expect to survive the round-trip.
    const anchorId = await page.evaluate(() => {
      const w = document.querySelector('.reader-content-wrapper');
      const c = w.getBoundingClientRect();
      for (const el of document.querySelectorAll('.chunk > [id]')) {
        if (!/^\d+(\.\d+)?$/.test(el.id)) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom > c.top + 193 && (r.width || r.height)) return el.id;
      }
      return null;
    });
    expect(anchorId, 'found a mid-book reading anchor').toBeTruthy();

    // Scroll -> Pages: the shown page MUST contain the anchor (not jump to top).
    await page.click('#settingsButton');
    await page.waitForSelector('#paginatedModeButton', { state: 'visible' });
    await page.click('#paginatedModeButton');
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const onPage = await targetOnCurrentPage(page, anchorId);
    expect(onPage.ok, `anchor on the page after Scroll->Pages, not jumped to top (${onPage.why})`).toBe(true);

    // Pages -> Scroll: the anchor must be visible again.
    await page.click('#settingsButton');
    await page.waitForSelector('#scrollModeButton', { state: 'visible' });
    await page.click('#scrollModeButton');
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');

    const back = await page.evaluate((id) => {
      const w = document.querySelector('.reader-content-wrapper');
      const el = document.getElementById(id);
      const c = w.getBoundingClientRect();
      const r = el?.getBoundingClientRect();
      return {
        engaged: w.classList.contains('paginated-active'),
        visible: !!r && r.bottom > c.top && r.top < c.bottom,
      };
    }, anchorId);
    expect(back.engaged, 'scroll mode restored').toBe(false);
    expect(back.visible, 'anchor visible again after Pages->Scroll').toBe(true);
  });
});
