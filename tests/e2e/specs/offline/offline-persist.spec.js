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
import { dumpBookNodes, dumpHistoryLog, snapshotFootnoteState, enableFnDiagScript } from '../../helpers/idbInspect.js';
import { createBaselineBook, performOfflineAuthoring } from '../../helpers/offlineGestures.js';

test.describe('Offline authoring persists to IndexedDB', () => {
  test.setTimeout(240_000);

  test('highlights + footnotes + hypercites + pastes survive offline in IDB + sync queue', async ({ page, spa }) => {
    await page.addInitScript(unregisterSwScript);
    await page.addInitScript(enableFnDiagScript);

    const { bookId } = await createBaselineBook(page, spa, { paraCount: 30 });

    await goOffline(page);
    await performOfflineAuthoring(page, spa);

    // ── IndexedDB: the main book's nodes carry the offline edits ──
    const nodes = await dumpBookNodes(page, bookId);
    expect(nodes.length, 'main book should have nodes in IDB').toBeGreaterThan(0);
    const allContent = nodes.map((n) => n.content).join('\n');
    expect(allContent, 'a hyperlight <mark> should be in node content').toMatch(/<mark/i);
    expect(allContent, 'a hypercite <u id="hypercite_…"> should be in node content').toMatch(/<u[^>]+id="hypercite_/i);
    expect(allContent, 'a footnote <sup> should be in node content').toMatch(/<sup/i);
    expect(allContent, 'pasted offline paragraph text should be present').toMatch(/OFF\d paragraph/);
    expect(nodes.some((n) => Array.isArray(n.footnotes) && n.footnotes.length > 0),
      'at least one node should record a footnote in its footnotes[] array').toBe(true);

    // Footnote three-way invariants should still agree offline.
    const { violations } = await snapshotFootnoteState(page, bookId);
    expect(violations, `footnote invariant violations: ${JSON.stringify(violations.slice(0, 5))}`).toHaveLength(0);

    // ── Sync queue: WAL captured the edits and is holding them as pending (offline) ──
    const logs = await dumpHistoryLog(page, bookId);
    expect(logs.length, 'historyLog should have at least one batch for the book').toBeGreaterThan(0);
    expect(logs.some((l) => l.nodeUpdates > 0), 'a batch should carry node updates').toBe(true);
    expect(logs.every((l) => l.status === 'pending'),
      `all offline batches should be pending; got: ${JSON.stringify(logs.map((l) => l.status))}`).toBe(true);

    // Still offline — nothing should have flipped to synced.
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  });
});
