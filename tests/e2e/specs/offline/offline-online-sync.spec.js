/**
 * The headline journey: go OFFLINE, create highlights + footnotes + hypercites +
 * pastes AND trigger an ID renumber (all offline, all in IndexedDB), then go ONLINE
 * and prove every piece — the renumbered clean integer ids, the highlight/hypercite/
 * footnote artifacts in the node content, and the annotation counts — reached Postgres.
 *
 * Assertions read the backend via in-page fetch (helpers/backendRead.js) so the
 * Sanctum stateful session + Origin match. MANUAL ONLY (`npm run test:e2e`).
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  unregisterSwScript, goOffline, goOnline, forceOnlineFlush, waitForSyncDrain,
} from '../../helpers/offline.js';
import { enableFnDiagScript } from '../../helpers/idbInspect.js';
import {
  createBaselineBook, performOfflineAuthoring, filterOfflineConsoleErrors,
} from '../../helpers/offlineGestures.js';
import { renumberWatchScript, forceDeepDecimalsAndRenumber } from '../../helpers/renumber.js';
import { readBookData, readAnnotations } from '../../helpers/backendRead.js';

test.describe('Offline → online: full sync to Postgres', () => {
  test.setTimeout(300_000);

  test('offline authoring + renumber all sync to the backend when reconnected', async ({ page, spa }) => {
    await page.addInitScript(unregisterSwScript);
    await page.addInitScript(enableFnDiagScript);
    await page.addInitScript(renumberWatchScript);

    const { bookId } = await createBaselineBook(page, spa, { paraCount: 30 });

    // ── Offline: author everything, then renumber LAST (its flush consolidates the queue) ──
    await goOffline(page);
    await performOfflineAuthoring(page, spa);
    const { depthReached, renumberFired } = await forceDeepDecimalsAndRenumber(page, { anchorId: '100' });
    expect(depthReached, 'should have deepened decimals to ≥3 offline').toBeGreaterThanOrEqual(3);
    expect(renumberFired, 'renumber should have fired offline').toBe(true);
    await page.waitForTimeout(1500);

    // ── Back online: nudge the retry and wait for the queue to fully drain ──
    await goOnline(page);
    await forceOnlineFlush(page);
    await waitForSyncDrain(page, bookId, { timeout: 90_000 });

    // ── Postgres has the main book's nodes (clean integer ids + the offline content) ──
    const data = await readBookData(page, bookId);
    expect(data.ok, `book data should be 200; got ${data.status} ${JSON.stringify(data.body).slice(0, 200)}`).toBe(true);
    const nodes = data.body.nodes || [];
    expect(nodes.length, 'backend should have nodes for the book').toBeGreaterThan(0);
    expect(nodes.some((n) => /\.\d/.test(String(n.startLine))),
      `no decimal startLines should reach PG after renumber; got ${nodes.map((n) => n.startLine).join(', ')}`).toBe(false);
    const pgContent = nodes.map((n) => n.content).join('\n');
    expect(pgContent, 'baseline paste text should be in PG').toMatch(/BASE paragraph/);
    expect(pgContent, 'offline pasted text should be in PG').toMatch(/OFF\d paragraph/);
    expect(pgContent, 'hyperlight <mark> should be in PG node content').toMatch(/<mark/i);
    expect(pgContent, 'hypercite <u> should be in PG node content').toMatch(/<u[^>]+id="hypercite_/i);
    expect(pgContent, 'footnote <sup> should be in PG node content').toMatch(/<sup/i);

    // ── Annotation counts reached PG ──
    expect(data.body.metadata.total_hyperlights, 'PG should have ≥1 hyperlight').toBeGreaterThanOrEqual(1);
    expect(data.body.metadata.total_hypercites, 'PG should have ≥1 hypercite').toBeGreaterThanOrEqual(1);

    const ann = await readAnnotations(page, bookId);
    expect(ann.ok, `annotations should be 200; got ${ann.status}`).toBe(true);
    expect(ann.body.metadata.total_hyperlights).toBeGreaterThanOrEqual(1);
    expect(ann.body.metadata.total_hypercites).toBeGreaterThanOrEqual(1);

    // NOTE: sub-book INTERIOR content is intentionally not asserted — authoring inside a
    // freshly-opened sub-book is network-coupled and unsupported offline (see
    // performOfflineAuthoring's scope note). The parent-node artifacts above are what
    // offline authoring produces, and they all reached PG.

    // ── No unexpected console errors (offline-network noise filtered) ──
    expect(filterOfflineConsoleErrors(spa, page)).toHaveLength(0);
  });
});
