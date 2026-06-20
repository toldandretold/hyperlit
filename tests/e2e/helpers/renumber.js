/**
 * Renumber driver — deterministically push decimal lineIds deep enough to fire the
 * divEditor ID renumbering, using the FIXED-ANCHOR recipe.
 *
 * Why a recipe (not "press Enter N times"): the id a new node gets depends on its two
 * neighbours' ids at that instant (`generateIdBetween`, idHelpers.ts:186). Inserting
 * into a WIDE integer gap just returns integer midpoints (100,200 → 150 → 125 → …) and
 * the decimal depth never grows. Depth only deepens when you insert between an integer
 * `a` and the smallest decimal sharing its integer part, which appends one decimal
 * place each time (CASE 2): `100 → 100.1 → 100.01 → 100.001`. So:
 *
 *   Keep the lower anchor `a` FIXED and always re-insert JUST AFTER it. After each
 *   Enter the new node becomes the next "immediately after `a`", so the following
 *   insert wedges between `a` and it — driving the decimal chain to depth-3 fast.
 *
 * `needsRenumbering` (idHelpers.ts:84) trips when an INPUT neighbour already has ≥3
 * decimals, so the renumber fires on the insert AFTER `100.001` exists. We therefore
 * keep inserting until the renumber is observed, not merely until depth reaches 3.
 */

/**
 * Init script (install via `page.addInitScript(renumberWatchScript)` BEFORE nav):
 * latch `window.__renumberFired` the instant a renumber starts — two independent ways,
 * because an offline renumber on a small book can complete in well under a poll tick:
 *
 *   1. A property SETTER on `window.renumberingInProgress` — `triggerRenumberingWithModal`
 *      assigns it `true` synchronously at the very start (IDfunctions.ts:31), so the
 *      setter latches even if it flips back to false 1 ms later. The getter still returns
 *      the live value, so the app's own reads (chunkMutationHandler) are unaffected.
 *   2. A `console.log` shim that latches on the renumber's log lines — covers both the
 *      inline trigger ("Renumbering flagged") and the edit-exit trigger ("IDs need cleanup")
 *      and the start banner ("RENUMBERING: Starting").
 */
export const renumberWatchScript = () => {
  window.__renumberFired = false;
  window.__renumberCount = 0;
  window.__renumberLog = [];

  let rip = false;
  try {
    Object.defineProperty(window, 'renumberingInProgress', {
      configurable: true,
      get() { return rip; },
      set(v) {
        rip = v;
        if (v) { window.__renumberFired = true; window.__renumberCount += 1; }
      },
    });
  } catch { /* if the prop is already non-configurable, the console latch below still fires */ }

  try {
    const orig = console.log.bind(console);
    console.log = (...args) => {
      try {
        const s = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
        if (/RENUMBERING|Renumbering flagged|IDs need cleanup/i.test(s)) {
          window.__renumberFired = true;
          window.__renumberLog.push(s.slice(0, 140));
        }
      } catch { /* ignore */ }
      return orig(...args);
    };
  } catch { /* ignore */ }
};

/** Max decimal-part length across numeric-id nodes in `.main-content` (0 = all integers). */
export async function maxDecimalDepth(page) {
  return page.evaluate(() => {
    const re = /^\d+(\.\d+)?$/;
    let max = 0;
    document.querySelectorAll('.main-content [id]').forEach((el) => {
      if (!re.test(el.id)) return;
      const dec = el.id.split('.')[1];
      if (dec) max = Math.max(max, dec.length);
    });
    return max;
  });
}

/** Was a renumber observed since page load (latched by renumberWatchScript)? */
export async function renumberHasFired(page) {
  return page.evaluate(() => !!window.__renumberFired);
}

/**
 * Place a collapsed caret at the start of the numeric-id node IMMEDIATELY AFTER the
 * fixed anchor, in `.main-content` document order (robust across `.chunk` divs).
 * Returns the target's id (for logging) or null if there is no node after the anchor.
 */
export async function caretJustAfterAnchor(page, anchorId = '100') {
  return page.evaluate((anchorId) => {
    const re = /^\d+(\.\d+)?$/;
    const main = document.querySelector('.main-content');
    if (!main) throw new Error('caretJustAfterAnchor: no .main-content');
    const nodes = Array.from(main.querySelectorAll('[id]')).filter((el) => re.test(el.id));
    const idx = nodes.findIndex((el) => el.id === String(anchorId));
    if (idx < 0) throw new Error(`caretJustAfterAnchor: anchor #${anchorId} not found`);
    const target = nodes[idx + 1];
    if (!target) return null; // nothing after the anchor yet
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true); // caret at the very start → Enter inserts between anchor and target
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    target.focus?.();
    return target.id;
  }, anchorId);
}

/**
 * Deterministic fallback: exit edit mode, which runs the editButton exit-scan
 * (components/editButton/index.ts:387) — it fires `triggerRenumberingWithModal`
 * whenever any node's decimal part length ≥3. Used only if the gesture loop made
 * deep decimals but the inline trigger didn't fire within the iteration cap.
 */
export async function triggerRenumberViaEditExit(page) {
  await page.click('#editButton');
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 10000 });
}

/**
 * Run the fixed-anchor recipe until the renumber fires (or the cap is hit).
 *
 * Returns `{ depthReached, renumberFired, iterations }`. Asserts nothing — the caller
 * decides what to assert (e.g. clean integer ids afterwards). Designed to be called
 * with `.main-content` in edit mode and an anchor present (default `100`, the title).
 */
export async function forceDeepDecimalsAndRenumber(
  page,
  { anchorId = '100', maxIters = 25, settleMs = 220, useEditExitFallback = true } = {},
) {
  let depthReached = 0;
  let iterations = 0;

  for (let i = 0; i < maxIters; i++) {
    const target = await caretJustAfterAnchor(page, anchorId);
    if (target === null) {
      throw new Error(
        `forceDeepDecimalsAndRenumber: no node after anchor #${anchorId} — ` +
        'the book needs at least one body node below the title (paste content first).',
      );
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(settleMs); // let the mutation + id assignment (+ maybe renumber) run
    iterations = i + 1;

    if (await renumberHasFired(page)) break;

    const depth = await maxDecimalDepth(page);
    if (depth > depthReached) depthReached = depth;
  }

  let renumberFired = await renumberHasFired(page);

  // Fallback: we deepened to ≥3 but the inline trigger didn't fire — force it via edit-exit.
  if (!renumberFired && useEditExitFallback && depthReached >= 3) {
    await triggerRenumberViaEditExit(page);
    // The edit-exit renumber loads modules + flushes async — poll a few seconds.
    for (let i = 0; i < 15 && !renumberFired; i++) {
      await page.waitForTimeout(300);
      renumberFired = await renumberHasFired(page);
    }
  }

  // Outcome-based belt: if we created depth-≥3 decimals but they're now gone (all ids
  // collapsed to clean integers), a renumber MUST have run even if both latches missed it.
  const finalDepth = await maxDecimalDepth(page);
  if (!renumberFired && depthReached >= 3 && finalDepth === 0) renumberFired = true;

  const renumberLog = await page.evaluate(() => (window.__renumberLog || []).slice());
  return { depthReached, renumberFired, iterations, finalDepth, renumberLog };
}
