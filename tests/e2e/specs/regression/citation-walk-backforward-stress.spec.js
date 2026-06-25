import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from '../../fixtures/navigation.fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EPUB_A = path.join(REPO_ROOT, 'tests/conversion/import-samples/dropbox/rockhill.epub');

/**
 * Citation-walk back/forward STRESS — "it OFTEN opens to the start of the book on back or forward".
 *
 * This mirrors the user's real gesture (from their prod log): click a hypercite → land on the
 * source → its container links to the citing book → click through → walk A↔B several times → then
 * press back all the way and forward all the way. The failure is landing at the TOP of a book
 * (scrollTop ≈ 0) when the history entry is a deep hypercite.
 *
 * Faithful conditions vs the synthetic specs that "passed":
 *   - BIG multi-chunk source (deep hypercite, not chunk 0)
 *   - IndexedDB primed for BOTH books (so the client-only nav path is the one exercised — the path
 *     the user's final back actually took: "fresh in IndexedDB — client-only nav")
 *   - MANY back/forward presses, not one
 *   - per-step scrollTop recorded on the way IN, asserted on the way back
 */

const NAV_LINE = /Cleaning up URL|Computed hash URL|Stack PUSHED|Navigating to \/|replaceState|pushState|client-only|No hash navigation|Already at|restoreContainerStack|Navigation target ready|Initiating navigation|Stack cleared|closeHyperlitContainer\] ENTER/;

async function readerScrollTop(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.reader-content-wrapper') || document.querySelector('.main-content');
    return el ? Math.round(el.scrollTop) : null;
  });
}

test.describe('citation walk — back/forward stress', () => {
  test('walking A<->B then back/forward all the way never lands at the start of a deep entry', async ({ page, spa }) => {
    test.setTimeout(360_000);
    await page.addInitScript(() => {
      try { localStorage.setItem('hyperlit_verbose_logs', 'true'); } catch (e) {}
      // Trace every history mutation that drops a #hash, with the caller.
      for (const m of ['pushState', 'replaceState']) {
        const orig = history[m].bind(history);
        history[m] = function (state, title, url) {
          try {
            const before = location.pathname + location.search + location.hash;
            const hadHash = !!location.hash;
            const willHaveHash = url == null ? hadHash : /#/.test(String(url));
            if (hadHash && !willHaveHash) {
              const caller = (new Error().stack || '').split('\n').slice(2, 5).join(' << ');
              console.log(`🩸 HASH DROPPED by ${m}: "${before}" → "${url}"  CALLER: ${caller}`);
            }
          } catch (e) {}
          return orig(state, title, url);
        };
      }
    });
    const navLog = [];
    const hashDrops = [];
    let replayPhase = false;
    const fetchesDuringReplay = [];
    const transitionStalls = [];
    const supersedeBails = [];
    page.on('console', (m) => {
      const t = m.text();
      if (NAV_LINE.test(t)) navLog.push(t);
      if (t.includes('🩸 HASH DROPPED')) hashDrops.push(t);
      // A cached book must NEVER trigger a server page fetch on back/forward (the lag).
      if (replayPhase && t.includes('Fetching reader HTML')) fetchesDuringReplay.push(t);
      // A new nav must SUPERSEDE the in-flight one, never wait for it to time out (the 3s stall).
      if (t.includes('Previous transition timed out')) transitionStalls.push(t);
      // Proof the cancel-and-replace path actually fires under contention.
      if (t.includes('superseded by a newer nav')) supersedeBails.push(t);
    });
    const dump = (l) => console.log(`\n──── NAV (${l}) ────\n${navLog.slice(-18).join('\n')}\n────\n`);

    await page.setViewportSize({ width: 760, height: 640 });

    // ── REAL imported EPUB as source book A (multi-chunk, real structure) ──
    const { bookId: A } = await spa.importMarkdownBook(page, spa, { filePath: EPUB_A });
    await page.waitForTimeout(1500);
    if (!(await page.evaluate(() => !!window.isEditing))) { await page.click('#editButton'); await spa.waitForEditMode(page); }
    await spa.openToc(page);
    const toc = await spa.getTocEntries(page);
    const deep = toc[Math.floor(toc.length * 0.8)];
    await spa.clickTocEntry(page, deep.index);
    await page.waitForTimeout(900);
    // Pick any sizable rendered paragraph near the current (deep) scroll position — robust to the
    // real EPUB's heading/paragraph structure.
    const paraSel = await page.evaluate(() => {
      const ps = [...document.querySelectorAll('.main-content p[id]')]
        .filter(p => (p.textContent || '').trim().length > 50);
      if (!ps.length) return null;
      // Prefer one in/near the viewport (we just TOC-navigated here).
      const inView = ps.find(p => { const r = p.getBoundingClientRect(); return r.top > 60 && r.top < window.innerHeight; });
      const chosen = inView || ps[Math.floor(ps.length / 2)];
      return chosen?.id ? `.main-content p[id="${chosen.id}"]` : null;
    });
    expect(paraSel, 'found a sizable deep paragraph to hypercite').not.toBeNull();
    const txt = (await page.locator(paraSel).textContent()).trim();
    await spa.selectTextInElement(page, paraSel, 0, Math.min(26, txt.length));
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hypercite');
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 8000 });
    const clip = await page.evaluate(() => {
      const u = document.querySelector('u[id^="hypercite_"].single');
      const bid = document.querySelector('.main-content')?.id;
      const href = `${location.origin}/${bid}#${u.id}`;
      return { id: u.id, html: `'${u.textContent}'⁠<a href="${href}" id="${u.id}" class="open-icon">↗</a>`, text: `'${u.textContent}' [↗](${href})` };
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});

    // ── Citing book B: paste A's hypercite ──
    const { bookId: B } = await spa.createNewBook(page, spa);
    await page.click('h1[id="100"]');
    await page.keyboard.type('Citer B');
    await page.keyboard.press('Enter');
    await page.keyboard.type('We cite A: ');
    await page.waitForTimeout(300);
    await spa.pasteHyperciteContent(page, clip.html, clip.text);
    await page.waitForSelector('.main-content a.open-icon[id^="hypercite_"]', { timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});

    // Both books are now primed in IndexedDB. Walk A<->B by clicking citation links, recording the
    // url + scrollTop reached at each forward step.
    const probe = (label) => page.evaluate((hcId) => {
      const u = document.querySelector(`u[id="${hcId}"], a[id="${hcId}"]`);
      const r = u?.getBoundingClientRect();
      const wrap = document.querySelector('.reader-content-wrapper') || document.querySelector('.main-content');
      return {
        bookId: document.querySelector('.main-content')?.id || null,
        url: location.pathname + location.hash, hash: location.hash,
        scrollTop: wrap ? Math.round(wrap.scrollTop) : null,
        found: !!u, top: r ? Math.round(r.top) : null,
        inView: !!r && r.top >= -60 && r.top < window.innerHeight - 40,
        container: !!document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open'),
      };
    }, clip.id);

    const trail = [];
    // Hop 1: from B, click the pasted hypercite → opens ref → "See in source" → A (deep hypercite).
    navLog.length = 0;
    await page.locator('.main-content a.open-icon[id^="hypercite_"]').first().click();
    await page.waitForFunction(() => document.querySelector('#hyperlit-container.open'), null, { timeout: 10000 });
    await page.locator('#hyperlit-container a.see-in-source-btn').first().click();
    await spa.waitForTransition(page).catch(() => {});
    await page.waitForTimeout(1500);
    let s = await probe('hop1→A'); trail.push(s);
    console.log('HOP1 (B→A):', JSON.stringify(s));
    expect(s.bookId, 'hop1 should land on A').toBe(A);
    expect(s.inView, `hop1: deep hypercite not in view (top=${s.top}, scrollTop=${s.scrollTop})`).toBe(true);

    // Hops 2-N: ensure a container is open (click the hypercite in main text if needed), then click
    // the citation / see-in-source link inside it to hop to the other book. Walks A↔B.
    for (let i = 0; i < 5; i++) {
      // 1) Make sure a container is open over the current book.
      await page.evaluate(() => {
        if (document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open')) return;
        const hash = location.hash.slice(1);
        const u = document.querySelector(`u[id="${hash}"], a.open-icon[id="${hash}"]`)
          || document.querySelector('.main-content u[id^="hypercite_"], .main-content a.open-icon[id^="hypercite_"]');
        u?.click();
      });
      await page.waitForFunction(() => document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open'), null, { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(800);
      // 2) Click a link inside the open container that navigates to the other book.
      const hopped = await page.evaluate(() => {
        const sel = '#hyperlit-container.open a.see-in-source-btn, .hyperlit-container-stacked.open a.see-in-source-btn, #hyperlit-container.open a.citation-link, .hyperlit-container-stacked.open a.citation-link, #hyperlit-container.open a.open-icon, .hyperlit-container-stacked.open a.open-icon';
        const link = [...document.querySelectorAll(sel)].find(l => getComputedStyle(l).pointerEvents !== 'none' && getComputedStyle(l).display !== 'none');
        if (link) { link.click(); return link.getAttribute('href') || true; }
        return false;
      });
      if (!hopped) { console.log(`hop ${i + 2}: no clickable citation link, stopping walk`); break; }
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(1600);
      s = await probe(`hop${i + 2}`); trail.push(s);
      console.log(`HOP${i + 2}:`, JSON.stringify(s));
    }

    expect(trail.length, 'should have walked several hops').toBeGreaterThanOrEqual(2);

    // ── Now press BACK all the way, then FORWARD all the way — the user's exact replay ──
    replayPhase = true; // both books are cached → no server fetch may happen from here on
    const steps = trail.length + 2;
    const backStates = [];
    for (let i = 0; i < steps; i++) {
      await page.goBack();
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(1100);
      const st = await probe(`back${i + 1}`);
      backStates.push(st);
      console.log(`BACK ${i + 1}:`, JSON.stringify(st));
    }
    const fwdStates = [];
    for (let i = 0; i < steps; i++) {
      await page.goForward();
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(1100);
      const st = await probe(`fwd${i + 1}`);
      fwdStates.push(st);
      console.log(`FWD ${i + 1}:`, JSON.stringify(st));
    }
    dump('after full back/forward replay');

    // ── ASSERTION 1: no history entry may have its #hash stripped (the root cause). A stripped hash
    // turns a deterministic "go to the hypercite" into a flaky saved-scroll resume → "opens at start".
    console.log('HASH DROPS:', hashDrops.length, hashDrops.slice(0, 3).join(' || '));
    expect(hashDrops, `something replaceState-stripped the #hash from a history entry (back/forward then can't return to the hypercite):\n${hashDrops.join('\n')}`).toHaveLength(0);

    // ── ASSERTION 2: every settled back/forward landing on the BIG book A must sit on its deep
    // hypercite (in view, well below the fold) — never scrolled to the start. This is "opens to the
    // start of the book" made testable.
    const settledA = [...backStates, ...fwdStates].filter(st =>
      st.bookId === A && st.url.includes(A) && st.found
    );
    expect(settledA.length, 'should have several settled landings on book A').toBeGreaterThanOrEqual(3);
    const startOffenders = settledA.filter(st => !st.inView || st.scrollTop < 1000);
    console.log('START-OF-BOOK OFFENDERS:', JSON.stringify(startOffenders));
    expect(startOffenders, `book A opened at/near the START on ${startOffenders.length} back/forward step(s) instead of its deep hypercite`).toHaveLength(0);
    // And the deep hypercite must carry its hash on those landings (proves it wasn't stripped).
    const hashlessA = settledA.filter(st => st.hash !== `#${clip.id}`);
    expect(hashlessA, `book A landings lost the #${clip.id} hash on back/forward:\n${JSON.stringify(hashlessA)}`).toHaveLength(0);

    // ── RAPID-BACK BURST: press back faster than a transition settles, colliding with an in-flight
    // transition. Old behaviour hung (concurrent) or stalled up to 8s (serialized-wait). With
    // abort-aware supersede each new press cancels the previous → no timeout, no hang.
    await page.goForward().catch(() => {});
    await page.waitForTimeout(1200);
    const burstStart = Date.now();
    // Fire history.back() rapidly IN-BROWSER (no Playwright round-trip between presses, no awaiting
    // navigation) so popstates land WHILE a transition is still running → real lock contention.
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) { window.history.back(); await new Promise(r => setTimeout(r, 40)); }
    });
    await spa.waitForTransition(page).catch(() => {});
    await page.waitForTimeout(2500);
    const burstMs = Date.now() - burstStart;
    // The reader must still be alive (not hung) — a click must work immediately after the burst.
    const aliveAfterBurst = await page.evaluate(() => !!document.querySelector('.main-content'));
    console.log('RAPID-BACK BURST took', burstMs, 'ms; transitionStalls=', transitionStalls.length, 'supersedeBails=', supersedeBails.length, 'alive=', aliveAfterBurst);

    // ── ASSERTION 4: rapid back/forward must not stall on / time out the transition lock, and must
    // not hang the reader. (8s timeout fired even once = a stall; burst blowing past ~10s = hang.)
    expect(transitionStalls, `a transition timed out waiting on a previous one (the 3s freeze):\n${transitionStalls.join('\n')}`).toHaveLength(0);
    expect(aliveAfterBurst, 'reader was destroyed/hung after the rapid-back burst').toBe(true);
    expect(burstMs, `5 rapid back presses took ${burstMs}ms — transitions are stalling/hanging`).toBeLessThan(10000);
    // Proof the burst genuinely collided (so 0 stalls means the SUPERSEDE handled it, not that the
    // presses never overlapped). The abort-aware cancel path must have fired at least once.
    expect(supersedeBails.length, 'rapid back presses never actually collided — burst too slow to prove the fix').toBeGreaterThan(0);

    // ── ASSERTION 3 (Part B): a CACHED book must never server-fetch on back/forward (the lag).
    console.log('SERVER FETCHES DURING REPLAY:', fetchesDuringReplay.length);
    expect(fetchesDuringReplay,
      `pressed back/forward to a CACHED book and it did a full server page fetch (the "nothing happens then it fetches" lag):\n${fetchesDuringReplay.join('\n')}`
    ).toHaveLength(0);
  });
});
