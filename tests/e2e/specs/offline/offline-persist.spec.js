/**
 * Offline persistence: with the network OFF, creating highlights / footnotes /
 * hypercites / pastes must all land in IndexedDB and be captured by the sync queue
 * as `pending` (recoverable when back online). No online phase here — this isolates
 * "offline writes survive locally".
 *
 * Companion specs: offline-renumber (renumber works offline) and offline-online-sync
 * (the queue actually drains to Postgres). MANUAL ONLY (`npm run test:e2e`).
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { unregisterSwScript, goOffline } from '../../helpers/offline.js';
import { dumpBookNodes, dumpHistoryLog, dumpStore, snapshotFootnoteState, enableFnDiagScript } from '../../helpers/idbInspect.js';
import { createBaselineBook, performOfflineAuthoring, warmUpLazyModules } from '../../helpers/offlineGestures.js';

test.describe('Offline authoring persists to IndexedDB', () => {
  test.setTimeout(240_000);

  test('highlights + footnotes + hypercites + pastes survive offline in IDB + sync queue', async ({ page, spa }) => {
    await page.addInitScript(unregisterSwScript);
    await page.addInitScript(enableFnDiagScript);

    const { bookId } = await createBaselineBook(page, spa, { paraCount: 30 });
    const warmed = await warmUpLazyModules(page); // online: cache lazy footnote chunk (Vite dev can't serve it offline)
    expect(warmed.every((r) => r.startsWith('ok')), `lazy module warm-up failed: ${JSON.stringify(warmed)}`).toBe(true);

    await goOffline(page);
    await performOfflineAuthoring(page, spa);

    // ── IndexedDB nodes: inline artifacts (footnote sup + pasted text) live in node content ──
    const nodes = await dumpBookNodes(page, bookId);
    expect(nodes.length, 'main book should have nodes in IDB').toBeGreaterThan(0);
    const allContent = nodes.map((n) => n.content).join('\n');
    expect(allContent, 'a footnote <sup> should be inline in node content').toMatch(/<sup/i);
    expect(allContent, 'pasted offline paragraph text should be present').toMatch(/OFF\d paragraph/);
    expect(nodes.some((n) => Array.isArray(n.footnotes) && n.footnotes.length > 0),
      'at least one node should record a footnote in its footnotes[] array').toBe(true);

    // ── IndexedDB stores: hyperlights + hypercites persist in their OWN stores (rendered
    //    as marks at display time, not embedded in node.content) ──
    const hyperlights = await dumpStore(page, 'hyperlights', bookId);
    expect(hyperlights.length, 'a hyperlight should be in the hyperlights store').toBeGreaterThanOrEqual(1);
    const hypercites = await dumpStore(page, 'hypercites', bookId);
    expect(hypercites.length, 'a hypercite should be in the hypercites store').toBeGreaterThanOrEqual(1);

    // Footnote three-way invariants should still agree offline.
    const { violations } = await snapshotFootnoteState(page, bookId);
    expect(violations, `footnote invariant violations: ${JSON.stringify(violations.slice(0, 5))}`).toHaveLength(0);

    // ── Sync queue: WAL captured the edits and is holding them as pending (offline) ──
    const logs = await dumpHistoryLog(page, bookId);
    expect(logs.length, 'historyLog should have at least one batch for the book').toBeGreaterThan(0);
    // The offline edits are held as pending node-bearing batches. (A warm-up footnote made
    // online before going offline may already be 'synced', so we assert existence, not all.)
    expect(logs.some((l) => l.status === 'pending' && l.nodeUpdates > 0),
      `expected a pending node batch (offline); got: ${JSON.stringify(logs.map((l) => ({ s: l.status, n: l.nodeUpdates })))}`).toBe(true);

    // Still offline — nothing should have flipped to synced.
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  });
});
