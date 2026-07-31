import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  authorAudioBook, routeAudioManifest, routeAudioFiles, unrouteAudio,
  startListening, waitForNodesStarted, attachTraceOnFailure, PILL,
} from '../../helpers/audioHarness.js';

/**
 * Dragging the audio pill (components/audioPlayer/playerDrag.ts).
 *
 * The pill is fixed bottom-centre at z-index 999998, which is the right default
 * but lands on top of the edit toolbar and the corner button clusters on smaller
 * screens. The dotted grip moves it; the position has to persist, stay on
 * screen when the viewport changes, and be resettable.
 *
 * Real pointer input, because the interesting failure modes are engine-level:
 * `touch-action`, pointer capture, and the centring `transform` fighting the
 * inline left/top.
 */

// serviceWorkers 'block': public/sw.js proxies non-/api/ GETs through its own
// fetch(), and a service-worker fetch is invisible to page.route — so the MP3
// routes below silently never fired and every paragraph 404'd from the real
// server. Blocking it also keeps these specs off the SW's stale-JS cache.
test.use({
  serviceWorkers: 'block',
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const STORAGE_KEY = 'hyperlitAudioPillPos';
const GRIP = '#audio-drag-handle';

/** Get the pill on screen: it only exists while audio is playing. */
async function showPill(page, spa, title) {
  await page.setViewportSize({ width: 1000, height: 800 });
  await authorAudioBook(page, spa, { paragraphs: 4, title });
  await routeAudioManifest(page);
  await routeAudioFiles(page);
  await startListening(page);
  await waitForNodesStarted(page, 1);
  await expect(page.locator(PILL)).toHaveClass(/visible/);
}

async function dragBy(page, dx, dy) {
  const grip = await page.locator(GRIP).boundingBox();
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Multiple steps: a single jump doesn't produce a real pointermove stream.
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

const storedPos = (page) => page.evaluate((key) => {
  const raw = localStorage.getItem(key);

  return raw ? JSON.parse(raw) : null;
}, STORAGE_KEY);

test.afterEach(async ({ page }, testInfo) => {
  await attachTraceOnFailure(page, testInfo);
  await unrouteAudio(page);
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY).catch(() => {});
});

test.describe('dragging the audio pill', () => {
  test('moves with the grip and remembers where it was put', async ({ page, spa }) => {
    test.setTimeout(180_000);
    await showPill(page, spa, 'Pill Drag');

    const before = await page.locator(PILL).boundingBox();
    await dragBy(page, -220, -160);
    const after = await page.locator(PILL).boundingBox();

    expect(after.x - before.x, 'moved left by roughly the drag distance').toBeLessThan(-180);
    expect(after.y - before.y, 'moved up by roughly the drag distance').toBeLessThan(-120);
    await expect(page.locator(PILL)).toHaveClass(/audio-player-bar--moved/);
    expect(await storedPos(page)).toMatchObject({ v: 1 });

    // It must also be usable where it landed — the whole point of moving it.
    await page.click('#audio-speed');
    await expect(page.locator('#audio-speed')).toHaveText('1.25×');
  });

  test('keeps its place across a reload', async ({ page, spa }) => {
    test.setTimeout(180_000);
    await showPill(page, spa, 'Pill Persist');

    await dragBy(page, -200, -150);
    const moved = await page.locator(PILL).boundingBox();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await routeAudioManifest(page);
    await routeAudioFiles(page);
    await startListening(page);
    await waitForNodesStarted(page, 1);

    const restored = await page.locator(PILL).boundingBox();
    expect(Math.abs(restored.x - moved.x), 'same horizontal position').toBeLessThanOrEqual(3);
    expect(Math.abs(restored.y - moved.y), 'same vertical position').toBeLessThanOrEqual(3);
  });

  test('cannot be parked off screen, and comes back when the window shrinks', async ({ page, spa }) => {
    test.setTimeout(180_000);
    await showPill(page, spa, 'Pill Clamp');

    await dragBy(page, 5000, 5000); // yank it way past the bottom-right corner

    let box = await page.locator(PILL).boundingBox();
    expect(box.x + box.width, 'clamped inside the right edge').toBeLessThanOrEqual(1000);
    expect(box.y + box.height, 'clamped inside the bottom edge').toBeLessThanOrEqual(800);

    await page.setViewportSize({ width: 520, height: 420 });
    await page.waitForTimeout(400);

    box = await page.locator(PILL).boundingBox();
    expect(box.x, 'still on screen after the shrink').toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(520);
    expect(box.y + box.height).toBeLessThanOrEqual(420);
  });

  test('double-clicking the grip puts it back to the default', async ({ page, spa }) => {
    test.setTimeout(180_000);
    await showPill(page, spa, 'Pill Reset');

    await dragBy(page, -250, -200);
    await expect(page.locator(PILL)).toHaveClass(/audio-player-bar--moved/);

    await page.locator(GRIP).dblclick();
    await page.waitForTimeout(200);

    await expect(page.locator(PILL)).not.toHaveClass(/audio-player-bar--moved/);
    expect(await storedPos(page), 'the saved position was forgotten').toBeNull();

    const box = await page.locator(PILL).boundingBox();
    expect(Math.abs((box.x + box.width / 2) - 500), 'back to horizontally centred').toBeLessThan(4);
  });

  test('can be nudged from the keyboard', async ({ page, spa }) => {
    test.setTimeout(180_000);
    await showPill(page, spa, 'Pill Keyboard');

    const before = await page.locator(PILL).boundingBox();
    await page.locator(GRIP).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);

    const after = await page.locator(PILL).boundingBox();
    expect(after.x - before.x, 'three 10px nudges').toBeGreaterThanOrEqual(25);
    expect(await storedPos(page)).toMatchObject({ v: 1 });

    await page.keyboard.press('Home');
    await page.waitForTimeout(150);
    await expect(page.locator(PILL)).not.toHaveClass(/audio-player-bar--moved/);
  });
});
