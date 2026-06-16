/**
 * Initial-load bundle-size verification (real browser).
 *
 * Proves the lazy-chunking intent end-to-end: the reader's initial JS is small (editor/paste code is
 * NOT eagerly downloaded), and entering edit mode fetches additional JS on demand. Complements the
 * deterministic, no-server `scripts/measure-eager-bundle.mjs` (which measures from the build manifest).
 *
 * Assertions are BYTE-based, not chunk-name-based: rollup auto-splits, so lazy chunk filenames are
 * content hashes (no stable "editor"/"paste-system" names). MUST run against a PRODUCTION BUILD
 * (`npm run build`, Vite dev server OFF) — in dev mode modules are unbundled and there are no chunks,
 * so the test skips itself. Manual suite: `npm run test:e2e` with E2E_READER_BOOK set.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { startJsChunkCapture } from '../../helpers/networkCapture.js';

// Generous sanity ceiling for reader initial JS (raw bytes to networkidle). Note this is HIGHER than
// the manifest's static-closure measure (~604 kB) because the browser also fetches boot-time dynamic
// imports (NavigationManager, content render). The AUTHORITATIVE eager-byte budget is the deterministic
// `npm run measure:bundle`; here we just catch a gross regression + prove edit-mode lazy-loads more.
const EAGER_BUDGET_KB = 1000;

test.describe('initial-load bundle size', () => {
  test('reader initial load excludes editor/paste; they load on entering edit mode', async ({ page, spa }) => {
    const bookSlug = process.env.E2E_READER_BOOK;
    test.skip(!bookSlug, 'E2E_READER_BOOK not set in .env.e2e');

    const js = startJsChunkCapture(page);

    await page.goto(`/${bookSlug}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    const initial = js.snapshot();
    console.log(`\n📦 Reader initial JS: ${initial.totalKB} kB across ${initial.chunks.length} chunks`);
    for (const c of [...initial.chunks].sort((a, b) => b.kb - a.kb).slice(0, 12)) {
      console.log(`   ${String(c.kb).padStart(8)} kB  ${c.file}`);
    }

    // This spec measures CODE-SPLIT CHUNKS, which only exist in a production build. If no built
    // assets were fetched, we're running against the Vite dev server (unbundled modules, no chunking)
    // — the lazy/eager distinction doesn't exist there, so skip rather than false-fail. Run against a
    // production build: `npm run build` with the Vite dev server OFF, then the e2e suite.
    test.skip(
      initial.builtCount === 0,
      'No /build/assets chunks seen — run against a production build (npm run build, Vite dev server off). ' +
        'Deterministic chunk measurement: `npm run measure:bundle`.',
    );

    // Eager initial JS stays under budget (editor/paste code is lazy, not in the initial download).
    expect(
      initial.totalKB,
      `reader initial JS (${initial.totalKB} kB) should be under the ${EAGER_BUDGET_KB} kB budget`,
    ).toBeLessThan(EAGER_BUDGET_KB);

    // Enter edit mode → the editor/paste chunks should now be fetched on demand (more JS arrives).
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === true, null, { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    const afterEdit = js.since(initial);
    console.log(`\n✏️  On edit-mode entry, fetched ${afterEdit.totalKB} kB across ${afterEdit.chunks.length} chunks: ${afterEdit.files.join(', ')}`);
    expect(
      afterEdit.chunks.length,
      'entering edit mode should lazy-load additional JS chunks (editor/paste)',
    ).toBeGreaterThan(0);

    js.stop();
  });
});
