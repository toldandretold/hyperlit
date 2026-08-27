/**
 * editIndicator machine-readable save-state contract.
 *
 * The VISUAL indicator is an inline-style CSS variable on the SVG path — it is
 * unobservable via getAttribute('fill') (the e2e suite polled that for a hex
 * that nothing sets, so every "wait for green" burned its full timeout) and the
 * green fades after 1.5s, so polling color is racy by design. The durable,
 * deterministic signal is stamped on #cloudRef:
 *   data-save-state: saving | saved | error | pending | idle
 *   data-last-sync:  success | error | local — outcome of the most recent sync;
 *                    survives the idle reset, cleared when a new cycle starts.
 * e2e waits use: data-last-sync === 'success' && data-save-state !== 'saving'
 * (tests/e2e/helpers/pageVerifiers.js waitForCloudGreen + inline copies).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
  verbose: { init: vi.fn() },
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  getPerimeterButtonsHidden: vi.fn(() => false),
}));
vi.mock('../../../resources/js/indexedDB/core/healthMonitor', () => ({
  isIDBBroken: vi.fn(() => false),
}));

import {
  glowCloudOrange, glowCloudGreen, glowCloudRed, glowCloudLocalSave, glowCloudSyncSuccess,
  registerPendingWorkCheck,
} from '../../../resources/js/components/cloudRef/editIndicator';

const btn = () => document.getElementById('cloudRef');
const state = () => btn().getAttribute('data-save-state');
const lastSync = () => btn().getAttribute('data-last-sync');

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `
    <button id="cloudRef">
      <svg id="cloudRef-svg"><path class="cls-1"></path></svg>
    </button>`;
});

afterEach(() => {
  // Drain fade/safety timers so module-level isProcessing/isComplete reset to
  // idle between tests (the module is a singleton across this file).
  vi.runAllTimers();
  vi.useRealTimers();
});

describe('editIndicator data-save-state / data-last-sync contract', () => {
  it('orange stamps saving and clears the previous outcome', () => {
    glowCloudOrange();
    expect(state()).toBe('saving');
    expect(lastSync()).toBeNull();
  });

  it('green after orange stamps saved + success, then idle keeps success', () => {
    glowCloudOrange();
    glowCloudGreen();
    expect(state()).toBe('saved');
    expect(lastSync()).toBe('success');
    vi.advanceTimersByTime(1600); // green fade → resetIndicator
    expect(state()).toBe('idle');
    expect(lastSync()).toBe('success'); // outcome survives the reset
  });

  it('red after orange stamps error + error', () => {
    glowCloudOrange();
    glowCloudRed();
    expect(state()).toBe('error');
    expect(lastSync()).toBe('error');
  });

  it('local save after orange stamps pending + local', () => {
    glowCloudOrange();
    glowCloudLocalSave();
    expect(state()).toBe('pending');
    expect(lastSync()).toBe('local');
  });

  it('green with NO active cycle still records the outcome (sync finished after safety reset)', () => {
    glowCloudGreen();
    expect(lastSync()).toBe('success');
    expect(state()).toBeNull(); // no glow cycle → no state transition
  });

  it('background sync success records the outcome', () => {
    glowCloudSyncSuccess();
    expect(lastSync()).toBe('success');
  });

  it('a NEW cycle clears the stale success so the e2e wait cannot pass early', () => {
    glowCloudOrange();
    glowCloudGreen();
    vi.advanceTimersByTime(1600);
    glowCloudOrange(); // second edit cycle begins
    expect(state()).toBe('saving');
    expect(lastSync()).toBeNull();
  });

  it('an edit arriving DURING the green fade re-arms saving instead of settling idle', () => {
    glowCloudOrange();
    glowCloudGreen();
    expect(state()).toBe('saved');
    glowCloudOrange(); // during the 1.5s fade — the old isProcessing early-return window
    vi.advanceTimersByTime(1600); // fade completes
    expect(state()).toBe('saving'); // re-armed, NOT idle+stale-success
    expect(lastSync()).toBeNull();
    glowCloudGreen(); // let the re-armed cycle finish so module state resets cleanly
  });

  it('mid-fade edits flip data-save-state back to saving IMMEDIATELY (no stale saved+success poll window)', () => {
    glowCloudOrange();
    glowCloudGreen();
    expect(state()).toBe('saved');
    glowCloudOrange(); // edit during the fade
    // BEFORE the fade timer runs, the state must already read saving
    expect(state()).toBe('saving');
    expect(lastSync()).toBeNull();
    vi.advanceTimersByTime(1600);
    expect(state()).toBe('saving'); // re-armed cycle
    glowCloudGreen(); // settle
  });

  it('green while local queues still hold work does NOT declare success (stays saving)', () => {
    let pending = true;
    const unregister = registerPendingWorkCheck(() => pending);
    glowCloudOrange();
    glowCloudGreen(); // server ACK of an earlier batch — but the queue is dirty
    expect(state()).toBe('saving');
    expect(lastSync()).toBeNull();
    pending = false;
    glowCloudGreen(); // the real, everything-drained green
    expect(state()).toBe('saved');
    expect(lastSync()).toBe('success');
    unregister();
  });

  it('a registered pending-work check blocks idle until the work drains', () => {
    let pending = true;
    const unregister = registerPendingWorkCheck(() => pending);

    glowCloudOrange();
    glowCloudGreen();
    vi.advanceTimersByTime(1600); // fade — but SaveQueue still holds nodes
    expect(state()).toBe('saving');

    pending = false; // queue drained
    glowCloudGreen();
    vi.advanceTimersByTime(1600);
    expect(state()).toBe('idle');
    expect(lastSync()).toBe('success');

    unregister();
  });
});
