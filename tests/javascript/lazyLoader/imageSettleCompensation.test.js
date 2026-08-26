/**
 * imageState fold-anchor compensation belt — loop decisions under a stubbed
 * layout (happy-dom has no layout: offsetHeight/getBoundingClientRect are
 * zero, so rects are overridden per element; only the belt's DECISIONS are
 * under test).
 *
 * Under test (resources/js/lazyLoader/imageState.ts): while ≥1 unsized image
 * attached via handleBrokenImages is pending decode, a rAF loop pins the
 * FOLD-STRADDLING node's viewport offset — above-fold growth shows up as the
 * probe drifting WITHOUT a matching scrollTop change, and the loop writes
 * scrollTop by exactly the drift.
 *
 * The world model:
 *  nodeVpTop = baseVpTop + growthAboveFold - scroller.scrollTop
 * so a genuine scroll moves scrollTop AND nodeVpTop by opposite amounts
 * (drift 0), while above-fold growth moves nodeVpTop alone (drift = growth).
 *
 * Covered:
 *  - above-fold growth → scrollTop corrected by exactly the drift, once
 *  - real scrolls (scrollTop moves WITH the fold offset) are not compensated
 *  - stands down under isScrolling / isNavigating, REBASELINING so release
 *    produces no catch-up jump
 *  - its own write never re-triggers a second write (no oscillation)
 *  - loop stops after the last pending image settles (+ tail)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SCROLLER_TOP = 100;
const FRAME = () => new Promise((r) => requestAnimationFrame(r));

function makeWorld(doc, baseVpTop = -40, { maxScrollTop = Infinity, initialTop = 0 } = {}) {
  const writes = [];
  const scroller = doc.createElement('div');
  let top = initialTop;
  let growth = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    // Like the browser: the write clamps to [0, maxScrollTop]; writes[] records
    // what the belt ASKED for.
    set: (v) => { writes.push(v); top = Math.max(0, Math.min(v, maxScrollTop)); },
    configurable: true,
  });
  scroller.getBoundingClientRect = () => ({ top: SCROLLER_TOP, bottom: SCROLLER_TOP + 800, height: 800 });
  Object.defineProperty(scroller, 'clientHeight', { get: () => 800, configurable: true });

  const chunk = doc.createElement('div');
  chunk.className = 'chunk';
  const node = doc.createElement('p');
  node.id = 'n42';
  node.getBoundingClientRect = () => {
    const vpTop = baseVpTop + growth - top;
    return { top: SCROLLER_TOP + vpTop, bottom: SCROLLER_TOP + vpTop + 200 };
  };
  chunk.appendChild(node);
  scroller.appendChild(chunk);
  doc.body.appendChild(scroller);

  return {
    scroller,
    writes,
    // Insert px of above-fold growth (an unsized image decoded) — content
    // shifts down with no scroll.
    growAboveFold(px) { growth += px; },
    // Simulate a real user gesture of +px: scrollTop moves, node vpTop follows.
    userScrollBy(px) {
      scroller.dispatchEvent(new Event('scroll')); // marks user intent
      top += px;
    },
    dispose() { scroller.remove(); },
  };
}

async function attachBelt(world) {
  vi.resetModules();
  const { handleBrokenImages } = await import('../../../resources/js/lazyLoader/imageState');
  const { userScrollState } = await import('../../../resources/js/scrolling/navState');
  const img = document.createElement('img');
  const wrap = document.createElement('div');
  wrap.appendChild(img);
  handleBrokenImages(wrap, { scrollableParent: world.scroller, pagingMode: false });
  await FRAME(); // belt calibrates against the fold node
  return { handleBrokenImages, userScrollState, img };
}

async function frames(n) {
  for (let i = 0; i < n; i++) await FRAME();
  await new Promise((r) => setTimeout(r, 0));
}

describe('imageState fold-anchor compensation belt', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('corrects above-fold growth by exactly the drift', async () => {
    const world = makeWorld(document);
    const { img } = await attachBelt(world);
    world.growAboveFold(280);
    await frames(2);
    expect(world.scroller.scrollTop).toBe(280);
    img.dispatchEvent(new Event('load'));
  });

  it('does not compensate a real scroll (scrollTop moves WITH the fold offset — drift zero)', async () => {
    const world = makeWorld(document);
    await attachBelt(world);
    world.userScrollBy(300);
    await frames(2);
    // No belt write beyond the gesture's own echo — writes[] is empty because
    // userScrollBy mutated top directly (only the belt's writes record).
    expect(world.writes).toEqual([]);
  });

  it('stands down while the user is scrolling, then pays the growth back once the gesture ends', async () => {
    const world = makeWorld(document);
    const { userScrollState, img } = await attachBelt(world);
    userScrollState.isScrolling = true;
    world.growAboveFold(280);
    await frames(2);
    expect(world.writes).toEqual([]);         // never writes against a gesture
    expect(world.scroller.scrollTop).toBe(0); // stood down (drift BANKED as debt)
    userScrollState.isScrolling = false;      // gesture window closes...
    await frames(3);
    // ...one catch-up write restores the reading line by exactly the growth
    // (silently absorbing it was the spec-B 5411px lost-line storm).
    expect(world.scroller.scrollTop).toBe(280);
    await frames(3);
    expect(world.scroller.scrollTop).toBe(280); // paid once — no oscillation
    img.dispatchEvent(new Event('load'));
  });

  it('corrects a bigger-than-viewport displacement IMMEDIATELY, even inside the gesture window', async () => {
    const world = makeWorld(document);
    const { userScrollState, img } = await attachBelt(world);
    userScrollState.isScrolling = true;
    world.growAboveFold(900); // > 800px viewport — an overwhelming shove
    await frames(2);
    // No 1s-decay wait: leaving a full-screen displacement standing is an
    // 850ms visible teleport-and-snap-back (the spec-B storm).
    expect(world.scroller.scrollTop).toBe(900);
    userScrollState.isScrolling = false;
    await frames(3);
    expect(world.scroller.scrollTop).toBe(900); // no double-pay after the flag clears
    img.dispatchEvent(new Event('load'));
  });

  it('drops banked debt when a NEW gesture arrives after the displacement', async () => {
    const world = makeWorld(document);
    const { userScrollState, img } = await attachBelt(world);
    userScrollState.isScrolling = true;
    userScrollState.lastGestureScrollTime = 1000;
    world.growAboveFold(280);
    await frames(2); // debt banked at stamp 1000
    userScrollState.lastGestureScrollTime = 2000; // reader gestures again — re-anchored
    await frames(2);
    userScrollState.isScrolling = false;
    await frames(3);
    expect(world.scroller.scrollTop).toBe(0); // stale debt dropped, no jump
    userScrollState.lastGestureScrollTime = 0;
    img.dispatchEvent(new Event('load'));
  });

  it('stands down under isNavigating (the landing belt owns corrections)', async () => {
    const world = makeWorld(document);
    const { userScrollState, img } = await attachBelt(world);
    userScrollState.isNavigating = true;
    world.growAboveFold(280);
    await frames(2);
    expect(world.writes).toEqual([]);
    userScrollState.isNavigating = false;
    await frames(3);
    expect(world.writes).toEqual([]);
    img.dispatchEvent(new Event('load'));
  });

  it('its own write never re-triggers a second write (no oscillation)', async () => {
    const world = makeWorld(document);
    const { img } = await attachBelt(world);
    world.growAboveFold(280);
    await frames(2);
    const settle = world.scroller.scrollTop;
    expect(settle).toBe(280);
    await frames(4);
    expect(world.scroller.scrollTop).toBe(settle); // converged, no repeat
    img.dispatchEvent(new Event('load'));
  });

  it('does not oscillate when the corrective write clamps at the bottom of the scroller', async () => {
    // Scroller pinned at maxScrollTop (top=500=max), fold node straddling the
    // edge (vpTop = 460 + 0 - 500 = -40). Growth above the fold asks the belt
    // to write 500+280=780, which the browser clamps back to 500. The belt must
    // baseline on the APPLIED value and re-baseline the probe (accept the
    // un-correctable growth) — never retry or reverse into a write ping-pong.
    const world = makeWorld(document, 460, { maxScrollTop: 500, initialTop: 500 });
    const { img } = await attachBelt(world);
    world.growAboveFold(280);
    await frames(2);
    expect(world.writes).toEqual([780]);          // one attempt, clamped by the setter
    expect(world.scroller.scrollTop).toBe(500);   // pinned at max
    await frames(5);
    expect(world.writes).toEqual([780]);          // no retries, no sign-flip ping-pong
    expect(world.scroller.scrollTop).toBe(500);
    img.dispatchEvent(new Event('load'));
  });

  it('stops watching once the last pending image settles (plus tail)', async () => {
    const world = makeWorld(document);
    const { img } = await attachBelt(world);
    img.dispatchEvent(new Event('load')); // pending → 0; tail 400ms
    await new Promise((r) => setTimeout(r, 450));
    await frames(2);
    world.growAboveFold(280);
    await frames(2);
    expect(world.scroller.scrollTop).toBe(0); // belt is gone — no correction
  }, 10000);
});
