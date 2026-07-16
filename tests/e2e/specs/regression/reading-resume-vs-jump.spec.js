import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Reading-position RESUME-vs-JUMP — the durable causal rule.
 *
 * A `#<node>` / `#hypercite_` / `#HL_` hash in the URL means one of two things and the reader must
 * tell them apart on load:
 *   • a DELIBERATE deep-link (pasted / typed / shared / clicked) → JUMP to it;
 *   • a RESIDUAL hash the reader navigated to then read PAST → RESUME the reading position
 *     (the "return later, yanked back to the highlight" bug).
 *
 * The discriminator (scrolling/restore.ts + scrolling/navStamp.ts): RESUME iff we recorded a
 * `navigatedAt` for the target on THIS device AND the saved position's `savedAt` is later
 * (we read past it); otherwise JUMP. Both timestamps live in localStorage, so the decision holds
 * across a reload / session close.
 *
 * This spec proves all three arms in a real browser. Manual (npm run test:e2e); scroll container
 * is .reader-content-wrapper.
 */

const SCROLLER = '.reader-content-wrapper';
const NODE_SEL = 'p[id],h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]';

async function buildScrollableBook(page, spa) {
  await page.setViewportSize({ width: 600, height: 500 });
  await spa.createNewBook(page, spa);
  await page.click('h1[id="100"]');
  await page.keyboard.type('Resume vs Jump');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  for (let i = 0; i < 30; i++) {
    await page.keyboard.type(`Paragraph ${i} — filler content so the document overflows the viewport and there is real scroll room between the deep-link target and the reading position.`);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('editButton')?.click());
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

function nodeIds(page) {
  return page.evaluate(({ scroller, sel }) => {
    const root = document.querySelector(scroller);
    if (!root) return [];
    return [...root.querySelectorAll(sel)].map((e) => e.id).filter((id) => /^\d+(\.\d+)?$/.test(id));
  }, { scroller: SCROLLER, sel: NODE_SEL });
}

const readerScrollTop = (page) => page.evaluate((s) => document.querySelector(s)?.scrollTop ?? null, SCROLLER);

/** viewport-relative top of a node (px from the scroller's top edge), or null if absent. */
const nodeTop = (page, id) => page.evaluate(({ nid, s }) => {
  const el = document.getElementById(nid);
  const root = document.querySelector(s);
  if (!el || !root) return null;
  return Math.round(el.getBoundingClientRect().top - root.getBoundingClientRect().top);
}, { nid: id, s: SCROLLER });

/** Cold-load the book at a hash (via home first, so it's a genuine fresh load, not a hashchange). */
async function coldLoadHash(page, bookId, node) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.goto(`/${bookId}#${node}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
}

async function scrollNodeToTop(page, id) {
  await page.evaluate((nid) => document.getElementById(nid)?.scrollIntoView({ block: 'start' }), id);
  await page.waitForTimeout(600); // outlast the 250ms save throttle
}

test.describe('reading position: resume vs jump', () => {
  test('DELIBERATE deep-link JUMPs to the target even when a saved position exists', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await buildScrollableBook(page, spa);
    const bookId = await spa.getCurrentBookId(page);
    const ids = await nodeIds(page);
    const deepId = ids[ids.length - 3];
    const earlyId = ids[2];

    // Establish a saved reading position deep in the doc (so JUMP has something to lose to).
    await scrollNodeToTop(page, deepId);
    // Clear this device's nav memory → the next hash load looks like a fresh, never-navigated
    // deep-link (a pasted/shared URL), which must JUMP even though a saved position exists.
    await page.evaluate((bid) => localStorage.removeItem(`hyperlit_nav_at_${bid}`), bookId);

    await coldLoadHash(page, bookId, earlyId);

    // Landed ON the early target (near the top band), NOT resumed to the deep saved position.
    const top = await nodeTop(page, earlyId);
    expect(top, `deliberate deep-link should land on #${earlyId} near the top (got top=${top})`).not.toBeNull();
    expect(top).toBeLessThan(260); // within the 192px header band + slack
    expect(top).toBeGreaterThan(-120);
  });

  test('navigate then READ PAST → RESUME on reload (not yanked back to the target)', async ({ page, spa }) => {
    // Precondition machinery is scrollTop-based ("scrolled well past the
    // target") — impossible in paginated mode where the wrapper never
    // scrolls. The resume-vs-jump causal invariant itself (savedAt vs
    // navigatedAt) is mode-independent and stays covered by normal runs.
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    test.setTimeout(120_000);
    await buildScrollableBook(page, spa);
    const bookId = await spa.getCurrentBookId(page);
    const ids = await nodeIds(page);
    const earlyId = ids[2];
    const deepId = ids[ids.length - 3];

    // Deliberately go to the early target (cold) → JUMP, and this records navigatedAt[early].
    await coldLoadHash(page, bookId, earlyId);
    const afterJumpTop = await nodeTop(page, earlyId);
    expect(afterJumpTop, 'precondition: initial deep-link jumped to the early target').toBeLessThan(260);

    // Read PAST it — scroll far down. savedAt now moves later than navigatedAt[early].
    await scrollNodeToTop(page, deepId);
    const deepScroll = await readerScrollTop(page);
    expect(deepScroll, 'precondition: scrolled well past the target').toBeGreaterThan(400);

    // Return (reload keeps /book#early in the URL).
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1400);

    // RESUMED to the deep reading position — NOT re-jumped to the early target.
    const resumedScroll = await readerScrollTop(page);
    expect(Math.abs(resumedScroll - deepScroll),
      `should resume the deep position (was ${deepScroll}, now ${resumedScroll}), not re-jump to #${earlyId}`)
      .toBeLessThan(200);
    const earlyTopNow = await nodeTop(page, earlyId);
    // The early target is now ABOVE the viewport (we read past it), i.e. negative top.
    expect(earlyTopNow, `#${earlyId} should be scrolled off the top after resume (top=${earlyTopNow})`).toBeLessThan(0);
  });

  test('navigate but DO NOT move → reload keeps you on the target (JUMP)', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await buildScrollableBook(page, spa);
    const bookId = await spa.getCurrentBookId(page);
    const ids = await nodeIds(page);
    const midId = ids[Math.floor(ids.length / 2)];

    await coldLoadHash(page, bookId, midId);
    const afterJump = await nodeTop(page, midId);
    expect(afterJump, 'precondition: jumped to the mid target').toBeLessThan(260);

    // Do NOT scroll. Reload. We navigated here and haven't moved → stay on the target.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1400);

    const afterReload = await nodeTop(page, midId);
    expect(afterReload, `should stay on #${midId} (top=${afterReload})`).not.toBeNull();
    expect(afterReload).toBeLessThan(260);
    expect(afterReload).toBeGreaterThan(-120);
  });
});
