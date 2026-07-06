/**
 * The lava-rise ceiling: scrolling the homepage intro grows the lava hills,
 * but blobs that start BELOW the docked hero card must never crest more than
 * OVERSHOOT_PX above the card's bottom edge — the scrolled copy always sits
 * over lava while a dark band survives at the very top. The two already-tall
 * masses (clusters 0 and 4, `data-lava-capped="0"`) are exempt: they keep
 * rising, just slowly (riseAmount 130/110 vs the ~683 the pillar used to get).
 *
 * The clamp is applied AFTER the anim breathing (capRise in
 * lavaLampBackground.ts), so the ceiling assertion must hold at EVERY
 * animation phase — we sample it repeatedly while the lava keeps morphing.
 *
 * Geometry is viewport-dependent (preserveAspectRatio slice), so the viewport
 * is pinned. Constants mirror lavaLampBackground.ts (OVERSHOOT_PX = 40).
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

test.use({ reducedMotion: 'no-preference', viewport: { width: 1280, height: 720 } });

const OVERSHOOT_PX = 40;
const TOL = 6;

/** { id, capped, top } for every lava path, in one evaluate. */
async function snapshotBlobs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.lava-lamp-bg path[data-lava]')).map(p => ({
      id: p.dataset.lava,
      capped: p.dataset.lavaCapped === '1',
      top: p.getBoundingClientRect().top,
    })),
  );
}

test('home: risen lava respects the header ceiling; exempt pillar rises slowly', async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // boot: lava present, every path labelled; clusters 0+4 (n:10 each) exempt
  await expect(page.locator('.lava-lamp-bg path[data-lava]').first()).toBeAttached();
  expect(await page.locator('.lava-lamp-bg path[data-lava-capped="0"]').count()).toBe(20);

  const rest = await snapshotBlobs(page);
  const restTop = new Map(rest.map(b => [b.id, b.top]));

  // scroll past full rise (rise = min(800/700, 1) = 1 → the cap is HARD)
  await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 800 }));
  await expect(page.locator('#app-container.lava-lamp-background.scrolled')).toBeAttached();
  await expect
    .poll(() => page.locator('.fixed-header').evaluate(el => el.getBoundingClientRect().top))
    .toBeLessThan(60);

  const headerBottom = await page
    .locator('.fixed-header')
    .evaluate(el => el.getBoundingClientRect().bottom);
  const ceiling = headerBottom - OVERSHOOT_PX - TOL; // screen y grows downward

  // let the ≤33ms anim frame apply the new rise before the first strict check
  await expect
    .poll(async () => {
      const blobs = await snapshotBlobs(page);
      return Math.min(...blobs.filter(b => b.capped).map(b => b.top));
    })
    .toBeGreaterThanOrEqual(ceiling);

  // the cap must hold at every animation phase — sample while the lava morphs
  for (let sample = 0; sample < 3; sample++) {
    const blobs = await snapshotBlobs(page);

    for (const b of blobs.filter(x => x.capped)) {
      expect(b.top, `capped blob ${b.id} crossed the ceiling`).toBeGreaterThanOrEqual(ceiling);
    }

    // capped copy-column hills actually ROSE (they aren't parked): the best
    // riser among clusters 1/2 must have climbed well past anim-sway noise
    // (~±20px). 80 not 100: the 2026-07 a11y/copy edits shifted the copy
    // column's rest geometry a few px and the best riser now peaks ~96.
    const columnRise = Math.max(
      ...blobs
        .filter(b => /^c[12]-/.test(b.id))
        .map(b => restTop.get(b.id) - b.top),
    );
    expect(columnRise, 'copy-column hills should rise toward the ceiling').toBeGreaterThanOrEqual(80);

    // the exempt pillar still pokes ABOVE the header line…
    const pillar = blobs.find(b => b.id === 'c0-0');
    expect(pillar.top, 'pillar should stay above the header line').toBeLessThan(headerBottom);
    // …but rises SLOWLY now (old behavior climbed ≈680px; new peaks ≈300px
    // including parallax and breathing)
    expect(restTop.get('c0-0') - pillar.top, 'pillar must rise slowly').toBeLessThan(450);

    await page.waitForTimeout(700);
  }

  // scrolling back re-lowers the hills: a mid-column blob returns near its rest top
  await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 0 }));
  await expect
    .poll(async () => {
      const blobs = await snapshotBlobs(page);
      const b = blobs.find(x => /^c2-/.test(x.id));
      return Math.abs(restTop.get(b.id) - b.top);
    })
    // anim breathing keeps moving the top; "near" = within its sway envelope
    .toBeLessThan(120);
});
