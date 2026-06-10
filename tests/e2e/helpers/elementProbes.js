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

/* ── 2. hyperlit-container resize edge ─────────────────────────────────────── */
/**
 * Open a hyperlit-container (via a footnote ref or hypercite) and drag its
 * `.resize-edge`, asserting the width actually changes and no `.resizing`
 * class is left stuck.
 *
 * Suspect: the persistent `window.containerDragger` singleton gets `isResizing`
 * stuck (a missed mouseup during a transition), so the next mousedown is
 * ignored — the leaked `resizing` class is the visible fingerprint.
 *
 * The resize edge only exists while a container is open, and a freshly-created
 * empty book has no footnote/hypercite to open one. With `require:false`
 * (verifier default) such a page SKIPS; the focused spec runs against a
 * content-rich book with `require:true`.
 */
export async function probeResizeHandle(page, spa, { require = false } = {}) {
  const OPEN_SEL = '#hyperlit-container.open, .hyperlit-container-stacked.open';
  const TRIGGER_SEL = 'sup.footnote-ref, sup[fn-count-id], u.couple[id^="hypercite_"], a.open-icon[id^="hypercite_"]';

  const alreadyOpen = await page.evaluate((sel) => !!document.querySelector(sel), OPEN_SEL);
  if (!alreadyOpen) {
    const trigger = page.locator(TRIGGER_SEL).first();
    if (!(await trigger.count())) {
      if (require) throw new Error('probeResizeHandle: no footnote/hypercite trigger on page to open a hyperlit-container');
      return { skipped: true, reason: 'no container-open trigger on page' };
    }
    await trigger.click();
  }

  // Wait for an open container carrying a resize edge.
  try {
    await page.waitForFunction((sel) => {
      const c = document.querySelector(sel);
      return !!(c && c.querySelector('.resize-edge, .resize-handle'));
    }, OPEN_SEL, { timeout: 8000 });
  } catch {
    if (require) throw new Error('probeResizeHandle: container did not open with a resize edge after trigger click');
    return { skipped: true, reason: 'container failed to open with a resize edge' };
  }

  // Stuck-state check BEFORE we touch it — catches the exact reported symptom.
  const preStuck = await page.evaluate((sel) => {
    const edge = document.querySelector(sel)?.querySelector('.resize-edge, .resize-handle');
    return edge ? edge.classList.contains('resizing') : null;
  }, OPEN_SEL);
  if (preStuck) {
    throw new Error('probeResizeHandle: .resize-edge already carries `.resizing` before any drag → containerDragger.reset() did not fire after the last nav');
  }

  // Geometry + hit-test: is the resize edge actually the topmost element at its
  // own centre? If an overlay or a sibling (.scroller, .mask-*) covers it, a
  // real mousedown lands on that instead and drag.js's closest('.resize-edge')
  // resolves to null — the resize is dead even though the listener is fine.
  const start = await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const edge = c.querySelector('.resize-edge, .resize-handle');
    const er = edge.getBoundingClientRect();
    const x = er.x + er.width / 2;
    const y = er.y + er.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      width: c.getBoundingClientRect().width,
      edgeW: er.width,
      x, y,
      topEl: top ? `${top.tagName.toLowerCase()}.${(top.className || '').toString().trim().split(/\s+/).join('.')}` : null,
      topIsEdge: !!(top && top.closest('.resize-edge, .resize-handle')),
    };
  }, OPEN_SEL);

  // Attempt 1 — real Playwright mouse (faithful to a user gesture).
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 80, start.y, { steps: 8 });
  const midResizingReal = await page.evaluate(() => !!document.querySelector('.resize-edge.resizing, .resize-handle.resizing'));
  await page.mouse.up();

  const readState = () => page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const edge = c?.querySelector('.resize-edge, .resize-handle');
    return {
      width: c ? c.getBoundingClientRect().width : null,
      stuck: edge ? edge.classList.contains('resizing') : null,
    };
  }, OPEN_SEL);

  let end = await readState();
  let realWorked = end.width != null && Math.abs(end.width - start.width) >= 6;
  let usedSynthetic = false;
  let midResizingSynthetic = null;

  // Attempt 2 — dispatch the events ON the edge element. drag.js delegates on
  // document via closest(), so a bubbling mousedown whose target IS the edge is
  // handled regardless of what sits on top visually. If THIS works but the real
  // mouse didn't, the cause is hit-testing/overlay, not the listener or state.
  if (!realWorked && !midResizingReal) {
    usedSynthetic = true;
    midResizingSynthetic = await page.evaluate((sel) => {
      const c = document.querySelector(sel);
      const edge = c.querySelector('.resize-edge, .resize-handle');
      const er = edge.getBoundingClientRect();
      const y = er.y + er.height / 2;
      const x = er.x + er.width / 2;
      const opts = (cx) => ({ bubbles: true, cancelable: true, clientX: cx, clientY: y, button: 0 });
      edge.dispatchEvent(new MouseEvent('mousedown', opts(x)));
      const mid = !!document.querySelector('.resize-edge.resizing, .resize-handle.resizing');
      document.dispatchEvent(new MouseEvent('mousemove', opts(x - 80)));
      document.dispatchEvent(new MouseEvent('mouseup', opts(x - 80)));
      return mid;
    }, OPEN_SEL);
    end = await readState();
  }

  const widthDelta = end.width != null ? Math.abs(end.width - start.width) : 0;

  // Restore idempotency.
  await closeAnyContainer(page);

  const diag = `geom={containerW:${start.width}, edgeW:${start.edgeW}, topAtEdge:${start.topEl}, topIsEdge:${start.topIsEdge}} ` +
    `real={mid:${midResizingReal}} synthetic={used:${usedSynthetic}, mid:${midResizingSynthetic}} widthDelta=${widthDelta}`;

  const engaged = midResizingReal || midResizingSynthetic;
  if (!engaged && widthDelta < 6) {
    // Could not engage the drag. In a content-rich book this can be benign
    // (the edge opened off-screen / behind layout for THIS book — `topIsEdge`
    // false / elementFromPoint null), which we can't faithfully drive. Only the
    // focused spec (require:true), which controls the book, treats this as a
    // hard failure; the generic tour soft-skips so it doesn't flake on
    // per-book container geometry. The stuck-`.resizing` symptom (the actual
    // reported bug) is still asserted below regardless.
    if (require) {
      throw new Error(
        `probeResizeHandle: drag on .resize-edge had no effect → mousedown never started a resize ` +
        `(containerDragger isResizing stuck, listener lost, or the edge is covered). ${diag}`
      );
    }
    return { skipped: true, reason: 'could not engage resize drag (edge not drivable on this book)', diag };
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
    usedSynthetic,
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
    document.querySelectorAll('#hyperlit-container, #toc-container, .hyperlit-container-stacked')
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
