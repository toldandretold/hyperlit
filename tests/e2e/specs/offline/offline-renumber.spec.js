/**
 * Offline renumbering: with the network OFF, drive decimal lineIds deep enough to
 * fire the divEditor ID renumbering, then assert it completed offline — DOM + IDB now
 * hold clean integer ids and the change is queued (pending) for later sync.
 *
 * Trigger = the fixed-anchor recipe (see helpers/renumber.js): keep the title (id 100)
 * as the lower anchor and repeatedly insert JUST AFTER it, deepening the decimal chain
 * 100 → 100.1 → 100.01 → 100.001 until needsRenumbering (≥3 decimals) trips. A
 * deterministic edit-exit fallback guarantees the renumber fires. MANUAL ONLY.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { unregisterSwScript, goOffline } from '../../helpers/offline.js';
import { dumpBookNodes, dumpHistoryLog } from '../../helpers/idbInspect.js';
import { createBaselineBook, numericNodeIds } from '../../helpers/offlineGestures.js';
import { renumberWatchScript, forceDeepDecimalsAndRenumber } from '../../helpers/renumber.js';

test.describe('Offline ID renumbering', () => {
  test.setTimeout(240_000);

  test('deep decimals trigger a renumber offline; ids snap to clean integers in DOM + IDB', async ({ page, spa }) => {
    await page.addInitScript(unregisterSwScript);
    await page.addInitScript(renumberWatchScript);

    const { bookId } = await createBaselineBook(page, spa, { paraCount: 12 });

    await goOffline(page);

    // Drive the fixed-anchor recipe until the renumber fires.
    const res = await forceDeepDecimalsAndRenumber(page, { anchorId: '100' });
    const { depthReached, renumberFired, iterations, finalDepth, renumberLog } = res;
    expect(depthReached, `decimal depth should have crossed 3 (reached ${depthReached} in ${iterations} inserts)`).toBeGreaterThanOrEqual(3);
    expect(renumberFired,
      `the renumber should have fired while offline (finalDepth=${finalDepth}, log=${JSON.stringify(renumberLog)})`).toBe(true);

    // Give the renumber's IDB write + WAL entry a beat to settle.
    await page.waitForTimeout(1500);

    // ── DOM: every node id is now a clean integer (no decimals survived) ──
    const ids = await numericNodeIds(page);
    expect(ids.length, 'there should be nodes in the DOM').toBeGreaterThan(0);
    expect(ids.some((id) => /\.\d/.test(id)), `no decimal ids should remain; got ${ids.join(', ')}`).toBe(false);

    // ── IDB: startLines are integers with stable node_ids preserved ──
    const nodes = await dumpBookNodes(page, bookId);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => Number.isInteger(Number(n.startLine))),
      `all IDB startLines should be integers; got ${nodes.map((n) => n.startLine).join(', ')}`).toBe(true);
    expect(nodes.every((n) => !!n.node_id), 'every node should keep its stable node_id through the renumber').toBe(true);

    // ── Sync queue: the renumber is captured and pending (still offline) ──
    const logs = await dumpHistoryLog(page, bookId);
    expect(logs.length, 'historyLog should have batches for the book').toBeGreaterThan(0);
    expect(logs.some((l) => l.nodeUpdates > 0), 'a batch should carry the renumbered node updates').toBe(true);
    expect(logs.every((l) => l.status === 'pending'),
      `offline batches should be pending; got ${JSON.stringify(logs.map((l) => l.status))}`).toBe(true);

    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  });
});
