/**
 * Element probes — post-SPA-nav "is this thing still wired up?" checks for the
 * three interactive elements that intermittently die after navigation:
 *
 *   1. The .book-actions → floating-action-menu → Preview flow (home/user).
 *   2. The hyperlit-container resize edge (.resize-edge, reader only).
 *   3. The window-level drag-and-drop file overlay (home/user).
 *
 * Each probe DIAGNOSES rather than just asserting: on failure it throws with a
 * snapshot of the relevant globals / registry / listener state so the report
 * names the cause (e.g. "window.isUserPage is TRUE on a home page"), not just
 * "click did nothing".
 *
 * Probes are wired into pageVerifiers.js so they run at every tour landing
 * (forward nav, bfcache back, forward replay), and driven directly by
 * specs/workflows/post-nav-buttons.spec.js for focused repro.
 *
 * Design notes:
 *   - The probes are idempotent: they open then dismiss any UI they trigger so
 *     a second lap starts clean.
 *   - `require:false` (the default for verifiers) lets a probe SKIP — returning
 *     `{ skipped, reason }` — when the page lacks what it needs (e.g. an empty
 *     book has no footnote to open a container). `require:true` (focused spec)
 *     turns those skips into failures.
 */

import { expect } from '@playwright/test';
import { closeHyperlitContainer } from './pageHelpers.js';

/* ── 1. book-actions / floating menu / preview ────────────────────────────── */
/**
 * Exercise the .book-actions menu on a home/user page.
 *
 * Prime suspect: a stale `window.isUserPage`. The home handler early-returns on
 * `if (window.isUserPage) return` (homepage.js:23) and the user handler on
 * `if (!window.isUserPage) return` (userProfilePage.js:149). If the flag leaks
 * across an SPA nav, BOTH handlers no-op and the menu never opens.
 *
 * @param {object} opts
 * @param {'home'|'user'} opts.expectPage   page type we believe we're on
 * @param {boolean} [opts.clickPreview=true] also click Preview + assert the
 *        shelf-preview overlay opens. Verifiers pass false (menu-open is the
 *        rebind signal; the preview fetch is a server concern); the focused
 *        spec leaves it true for the full flow.
 */
export async function probeBookActionsMenu(page, spa, { expectPage, clickPreview = true } = {}) {
  const snap = await page.evaluate(() => {
    const status = (window.buttonRegistry && window.buttonRegistry.getStatus)
      ? window.buttonRegistry.getStatus() : {};
    const active = status.activeComponents || [];
    return {
      isUserPage: !!window.isUserPage,
      isOwner: !!window.isOwner,
      dataPage: document.body.getAttribute('data-page'),
      registryPage: status.currentPage || null,
      homepageBookActions: active.includes('homepageBookActions'),
      userProfilePage: active.includes('userProfilePage'),
      bookActionsCount: document.querySelectorAll('.book-actions[data-book]').length,
    };
  });

  const fail = (msg) => {
    throw new Error(`probeBookActionsMenu [${expectPage}]: ${msg}\n  diagnostics: ${JSON.stringify(snap)}`);
  };

  // Flag-consistency: data-page must agree with window.isUserPage or BOTH
  // .book-actions handlers silently no-op. This is the exact stale-flag bug.
  if (expectPage === 'home' && snap.isUserPage) {
    fail('window.isUserPage is TRUE on a home page → homepage book-actions handler early-returns → preview menu dead');
  }
  if (expectPage === 'user' && !snap.isUserPage) {
    fail('window.isUserPage is FALSE on a user page → userProfilePage book-actions handler early-returns → preview menu dead');
  }

  // No cards to test (empty library) — skip, don't fail.
  if (snap.bookActionsCount === 0) {
    return { ...snap, skipped: true, reason: 'no .book-actions[data-book] cards on page' };
  }

  // Click the trigger → the floating menu must open with a Preview item.
  await page.locator('.book-actions[data-book]').first().click();
  let menuOpened = true;
  try {
    await page.waitForSelector('.floating-action-menu [data-action="preview"]', { timeout: 2500 });
  } catch {
    menuOpened = false;
  }
  if (!menuOpened) {
    fail('clicked .book-actions but .floating-action-menu (preview) never appeared → click handler not bound to current DOM');
  }

  let previewOpened = null;
  if (clickPreview) {
    await page.click('.floating-action-menu [data-action="preview"]');
    previewOpened = true;
    try {
      await page.waitForSelector('#shelf-preview-overlay', { timeout: 3000 });
    } catch {
      previewOpened = false;
    }
    if (!previewOpened) {
      fail('Preview clicked but #shelf-preview-overlay never opened');
    }
    // Dismiss the preview (Escape handler removes it) so the next lap is clean.
    await page.keyboard.press('Escape');
    await page.waitForSelector('#shelf-preview-overlay', { state: 'detached', timeout: 3000 }).catch(() => {});
  } else {
    // Just dismiss the floating menu.
    await page.keyboard.press('Escape');
  }

  // Belt + braces: remove any lingering overlay/menu/backdrop.
  await page.evaluate(() => {
    document.getElementById('shelf-preview-overlay')?.remove();
    document.querySelectorAll('.floating-action-menu, .floating-action-menu-backdrop')
      .forEach((el) => el.remove());
  });

  return { ...snap, skipped: false, menuOpened: true, previewOpened };
}

/* ── 2. container resize edge (hyperlit left edge / toc right edge) ─────────── */
/**
 * Open a container and drag its full-height `.resize-edge`, asserting the width
 * actually changes and no `.resizing` class is left stuck.
 *
 * Defaults probe the hyperlit-container's left edge (opened via a footnote/
 * hypercite trigger). Pass `openSel`/`edgeSel`/`openFn` to probe another
 * container the same way — e.g. the left-anchored #toc-container's right edge.
 * Both containers are driven by the SAME `window.containerDragger` singleton, so
 * this is a faithful "does the real drag move it" check for either.
 *
 * Suspect: the singleton gets `isResizing` stuck (a missed mouseup during a
 * transition), so the next mousedown is ignored — the leaked `resizing` class is
 * the visible fingerprint.
 *
 * The resize edge only exists while a container is open. With `require:false`
 * (verifier default) a page with nothing to open SKIPS; focused specs that
 * control the book pass `require:true`.
 */
export async function probeResizeHandle(page, spa, {
  require = false,
  openSel = '#hyperlit-container.open, .hyperlit-container-stacked.open',
  edgeSel = '.resize-edge.resize-left',
  triggerSel = 'sup.footnote-ref, sup[fn-count-id], u.couple[id^="hypercite_"], a.open-icon[id^="hypercite_"]',
  openFn = null, // async (page) => void to open the container; falls back to clicking a trigger
} = {}) {
  const OPEN_SEL = openSel;
  const TRIGGER_SEL = triggerSel;
  // Drag the full-height edge strip a user grabs (title "Resize width"). Pin the exact
  // edge — a bare `.resize-edge, .resize-handle` querySelector returns whichever is first
  // in DOM and could grab an off-screen handle, making the probe test the wrong element.
  const EDGE_SEL = edgeSel;

  const alreadyOpen = await page.evaluate((sel) => !!document.querySelector(sel), OPEN_SEL);
  if (!alreadyOpen) {
    if (openFn) {
      await openFn(page);
    } else {
      const trigger = page.locator(TRIGGER_SEL).first();
      if (!(await trigger.count())) {
        if (require) throw new Error('probeResizeHandle: no trigger on page to open the container');
        return { skipped: true, reason: 'no container-open trigger on page' };
      }
      await trigger.click();
    }
  }

  // Wait for an open container carrying the resize edge.
  try {
    await page.waitForFunction(({ open, edge }) => {
      const c = document.querySelector(open);
      return !!(c && c.querySelector(edge));
    }, { open: OPEN_SEL, edge: EDGE_SEL }, { timeout: 8000 });
  } catch {
    if (require) throw new Error(`probeResizeHandle: container did not open with a ${EDGE_SEL} after open`);
    return { skipped: true, reason: 'container failed to open with a resize edge' };
  }

  // Stuck-state check BEFORE we touch it — catches the exact reported symptom.
  const preStuck = await page.evaluate(({ open, edge }) => {
    const e = document.querySelector(open)?.querySelector(edge);
    return e ? e.classList.contains('resizing') : null;
  }, { open: OPEN_SEL, edge: EDGE_SEL });
  if (preStuck) {
    throw new Error('probeResizeHandle: .resize-edge already carries `.resizing` before any drag → containerDragger.reset() did not fire after the last nav');
  }

  // Wait for the slide-in transition to SETTLE before measuring. #hyperlit-container
  // starts off-screen-right (transform: translateX(100% + 2em)) and slides in over 0.3s;
  // `.open` is set at animation START, so measuring immediately puts the left edge still
  // partway off the right of the viewport → elementFromPoint(centre) === null. Wait until
  // the edge's own centre actually resolves to the edge (hit-testable, animation done).
  // If it never settles (genuinely covered/off-screen), fall through — the geometry below
  // records topIsEdge:false and require:true fails with a full diag.
  try {
    await page.waitForFunction(({ open, edge }) => {
      const c = document.querySelector(open);
      const e = c && c.querySelector(edge);
      if (!e) return false;
      // The slide-in transform must have reached REST before we measure. Checking
      // only "edge centre is inside the viewport and topmost" (below) is satisfied
      // far too early for a panel sliding in from the LEFT (e.g. #toc-container,
      // probed via its `.resize-right` edge): that edge is the FIRST thing to cross
      // x=0, so the guard passed while the panel was still ~99% off-screen (edge at
      // x≈1) — geometry captured mid-animation, and the real drag then landed on a
      // moving target (mousedown missed the edge → no resize). #hyperlit-container
      // slides in from the right and its `.resize-left` edge is the LAST thing in,
      // so it happened to be robust; this makes both safe. Both panels rest at
      // translateX(0), so require the horizontal translate to be ~0 first.
      const t = getComputedStyle(c).transform;
      const tx = t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : 0;
      if (Math.abs(tx) > 1) return false;
      const r = e.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return !!(top && top.closest(edge));
    }, { open: OPEN_SEL, edge: EDGE_SEL }, { timeout: 4000 });
  } catch { /* fall through to the diagnostic geometry capture */ }

  // Geometry + hit-test: is the resize edge actually the topmost element at its
  // own centre? If an overlay or a sibling (.scroller, .mask-*) covers it, a
  // real mousedown lands on that instead and drag.js's closest('.resize-edge')
  // resolves to null — the resize is dead even though the listener is fine.
  const start = await page.evaluate(({ open, edge: edgeSel }) => {
    const c = document.querySelector(open);
    const edge = c.querySelector(edgeSel);
    const er = edge.getBoundingClientRect();
    const x = er.x + er.width / 2;
    const y = er.y + er.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      width: c.getBoundingClientRect().width,
      edgeW: er.width,
      x, y,
      topEl: top ? `${top.tagName.toLowerCase()}.${(top.className || '').toString().trim().split(/\s+/).join('.')}` : null,
      topIsEdge: !!(top && top.closest(edgeSel)),
      hasDragger: !!window.containerDragger, // is the dragger even initialised on this page?
    };
  }, { open: OPEN_SEL, edge: EDGE_SEL });

  // Attempt 1 — real Playwright mouse (faithful to a user gesture).
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 80, start.y, { steps: 8 });
  const midResizingReal = await page.evaluate(() => !!document.querySelector('.resize-edge.resizing, .resize-handle.resizing'));
  await page.mouse.up();

  const readState = () => page.evaluate(({ open, edge: edgeSel }) => {
    const c = document.querySelector(open);
    const edge = c?.querySelector(edgeSel);
    return {
      width: c ? c.getBoundingClientRect().width : null,
      stuck: edge ? edge.classList.contains('resizing') : null,
    };
  }, { open: OPEN_SEL, edge: EDGE_SEL });

  const end = await readState();
  const widthDelta = end.width != null ? Math.abs(end.width - start.width) : 0;
  const realWorked = end.width != null && widthDelta >= 6;

  // Restore idempotency.
  await closeAnyContainer(page);

  // REAL gesture ONLY — there is deliberately no synthetic `edge.dispatchEvent(...)`
  // fallback. A user cannot dispatch events onto the element; a synthetic mousedown
  // bypasses hit-testing and would report "works" even when the edge is covered or
  // the document listener is missing. That fallback is exactly how this probe used to
  // pass green on a resize feature that was dead after SPA nav.
  const diag = `geom={containerW:${start.width}, edgeW:${start.edgeW}, edgeX:${Math.round(start.x)}, topAtEdge:${start.topEl}, topIsEdge:${start.topIsEdge}, hasDragger:${start.hasDragger}} ` +
    `real={mid:${midResizingReal}} widthDelta=${widthDelta}`;

  const engaged = midResizingReal || realWorked;
  if (!engaged) {
    // The real drag did nothing — covered edge, lost listener, or stuck state.
    // require:true (focused specs that control the book) → hard failure. The generic
    // verifier soft-skips ONLY genuinely undrivable per-book geometry; the stuck-
    // `.resizing` symptom is still asserted below regardless.
    if (require) {
      throw new Error(
        `probeResizeHandle: REAL drag on .resize-edge had no effect → mousedown never started a resize ` +
        `(containerDragger missing/stuck, document listener lost, or the edge is covered). ${diag}`
      );
    }
    return { skipped: true, reason: 'could not engage real resize drag (edge not drivable on this book)', diag };
  }
  if (end.stuck) {
    throw new Error(`probeResizeHandle: \`.resizing\` left on the edge after mouseup → the next resize will be dead. ${diag}`);
  }

  return {
    skipped: false,
    widthBefore: start.width,
    widthAfter: end.width,
    widthDelta,
    realWorked,
    topIsEdge: start.topIsEdge,
    topAtEdge: start.topEl,
  };
}

/**
 * Close whatever hyperlit-container is open (base via the ref-overlay path, or a
 * stacked one by force) so verifiers stay idempotent.
 */
async function closeAnyContainer(page) {
  await closeHyperlitContainer(page).catch(() => {});
  await page.evaluate(() => {
    // Force every container shut and clear every overlay/body state that could
    // keep intercepting pointer events (which would break the next navigation).
    document.querySelectorAll('#hyperlit-container, #toc-container, #source-container, .hyperlit-container-stacked')
      .forEach((c) => { c.classList.remove('open'); c.classList.add('hidden'); });
    document.querySelectorAll('#ref-overlay, #source-overlay, .navigation-overlay, [id$="-overlay"].active')
      .forEach((o) => o.classList.remove('active'));
    document.body.classList.remove('hyperlit-container-open', 'container-resizing');
    document.querySelectorAll('.resize-edge.resizing, .resize-handle.resizing')
      .forEach((e) => e.classList.remove('resizing'));
    if (window.containerDragger && typeof window.containerDragger.reset === 'function') {
      window.containerDragger.reset();
    }
  });
  // Let any close transition settle so the app container is interactable again.
  await page.waitForTimeout(250);
}

/* ── 3. window drag-drop listener balance ─────────────────────────────────── */
/**
 * Read the listener-monitor counts for the window-level drop handlers and the
 * #page-drop-overlay element. Unlike the other two elements, homepageDropTarget
 * binds directly to `window` (not delegation), so an unbalanced destroy/init
 * across navs shows up as either a missing listener (drop dead) or a leaked
 * overlay (double-init).
 *
 * Absolute window::drop counts are noisy (other code may also bind), so the
 * verifier only fails on the unambiguous signals: zero listeners, or an overlay
 * count != 1. The focused spec compares counts ACROSS round-trips to catch slow
 * growth (the double-bind leak signature).
 */
export async function probeDropListenerBalance(page) {
  const data = await page.evaluate(() => {
    const m = window.__listenerMonitor;
    const get = (k) => (m ? m.get(k) : null);
    return {
      drop: get('window::drop'),
      dragover: get('window::dragover'),
      dragenter: get('window::dragenter'),
      dragleave: get('window::dragleave'),
      overlayCount: document.querySelectorAll('#page-drop-overlay').length,
    };
  });

  const errs = [];
  if (data.drop === 0) errs.push('window::drop listener count is 0 → drop handler not bound (drag-drop dead)');
  if (data.overlayCount === 0) errs.push('no #page-drop-overlay element → drop target not initialised');
  if (data.overlayCount > 1) errs.push(`${data.overlayCount} #page-drop-overlay elements → overlay leaked across navs (double-init)`);

  if (errs.length) {
    throw new Error(`probeDropListenerBalance: ${errs.join('; ')}\n  counts: ${JSON.stringify(data)}`);
  }
  return data;
}
