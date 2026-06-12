/**
 * Pins core/healthMonitor.js + core/recoveryToast.js ahead of their TS
 * conversion: the 2-failure circuit breaker, toast lifecycle, recovery via
 * the real connection module against fake-indexeddb, and the stashed-ops drain.
 *
 * NOTE: healthMonitor holds module-level state — the tests run as one sequence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudRed: vi.fn(),
}));

import { installFreshIndexedDB, waitFor } from './idbHarness.js';
import {
  reportIDBSuccess,
  reportIDBFailure,
  isIDBBroken,
  attemptRecovery,
} from '../../../resources/js/indexedDB/core/healthMonitor';
import {
  showIDBRecoveryToast,
  updateIDBRecoveryToast,
  hideIDBRecoveryToast,
} from '../../../resources/js/indexedDB/core/recoveryToast';

describe('recoveryToast', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('show creates the toast once (no duplicates), update changes the message, hide removes it', async () => {
    showIDBRecoveryToast();
    showIDBRecoveryToast();
    expect(document.querySelectorAll('#idb-recovery-toast')).toHaveLength(1);
    expect(document.querySelector('[data-role="message"]').textContent).toBe('Reconnecting database...');

    updateIDBRecoveryToast('Still trying…');
    expect(document.querySelector('[data-role="message"]').textContent).toBe('Still trying…');

    hideIDBRecoveryToast();
    await waitFor(() => !document.getElementById('idb-recovery-toast'));
  });
});

describe('healthMonitor circuit breaker (sequential)', () => {
  it('a single failure is transient; success resets the counter', () => {
    installFreshIndexedDB();
    expect(reportIDBFailure(new Error('one'))).toBe(false);
    expect(isIDBBroken()).toBe(false);

    reportIDBSuccess(); // reset
    expect(reportIDBFailure(new Error('again'))).toBe(false);
    expect(isIDBBroken()).toBe(false);
    reportIDBSuccess(); // leave clean for next test
  });

  it('two consecutive failures break IDB, show the toast, then recovery heals and drains stashed ops', async () => {
    installFreshIndexedDB();
    document.body.innerHTML = '';
    const retryFn = vi.fn();

    expect(reportIDBFailure(new Error('one'))).toBe(false);
    // Second consecutive failure → broken; caller told to stop re-queuing
    expect(reportIDBFailure(new Error('two'), { retryFn })).toBe(true);
    expect(isIDBBroken()).toBe(true);
    expect(document.getElementById('idb-recovery-toast')).toBeTruthy();

    // Recovery (auto-kicked) reopens against fake-indexeddb — first attempt
    // succeeds after the initial 500ms backoff.
    const recovered = await attemptRecovery();
    expect(recovered).toBe(true);
    expect(isIDBBroken()).toBe(false);
    expect(retryFn).toHaveBeenCalledTimes(1);
    await waitFor(() => !document.getElementById('idb-recovery-toast'));
  }, 15000);
});
