/**
 * IDB Health Monitor — Circuit-Breaker Pattern
 *
 * Tracks consecutive IndexedDB failures. After 2 consecutive failures,
 * declares IDB "broken", shows a recovery toast + red cloud, and
 * attempts automatic recovery (reopen DB with exponential backoff).
 */

import { openDatabase, closeDatabase } from './connection.js';
import { showIDBRecoveryToast, updateIDBRecoveryToast, hideIDBRecoveryToast } from './recoveryToast.js';

// ── State ──────────────────────────────────────────────────────────
let consecutiveFailures = 0;
let idbBroken = false;
let recoveryPromise = null;

const FAILURE_THRESHOLD = 2;
const RECOVERY_DELAYS = [500, 1000, 2000, 4000];

/** Operations stashed while IDB is broken — each is a () => Promise */
const failedOperationQueue = [];

// ── Public API ─────────────────────────────────────────────────────

/**
 * Call after every successful IDB write.
 * Resets the consecutive-failure counter.
 */
export function reportIDBSuccess() {
  if (consecutiveFailures > 0) {
    console.log(`[HealthMonitor] IDB success — resetting failure counter (was ${consecutiveFailures})`);
  }
  consecutiveFailures = 0;
}

/**
 * Call when an IDB write fails.
 *
 * @param {Error}    error     The caught error
 * @param {Object}   [opts]
 * @param {Function} [opts.retryFn]  A () => void that re-queues + retries the operation
 * @returns {boolean} `true` if the caller should **stop** re-queuing (IDB is broken)
 */
export function reportIDBFailure(error, opts = {}) {
  consecutiveFailures++;
  console.warn(`[HealthMonitor] IDB failure #${consecutiveFailures}:`, error);

  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    if (!idbBroken) {
      idbBroken = true;
      console.error(`[HealthMonitor] IDB declared BROKEN after ${consecutiveFailures} consecutive failures`);

      // Visual feedback — fire-and-forget dynamic import
      import('../../components/editIndicator.js')
        .then(({ glowCloudRed }) => glowCloudRed())
        .catch(() => { /* editIndicator may not be loaded yet */ });

      showIDBRecoveryToast();
      updateIDBRecoveryToast('Reconnecting database...');
    }

    // Stash the retry function for after recovery
    if (typeof opts.retryFn === 'function') {
      failedOperationQueue.push(opts.retryFn);
    }

    // Kick off recovery (singleton — won't double-start)
    attemptRecovery();

    return true; // caller should NOT re-queue
  }

  return false; // transient — caller can re-queue once
}

/**
 * @returns {boolean} Whether IDB is currently considered broken.
 */
export function isIDBBroken() {
  return idbBroken;
}

/**
 * Singleton recovery: tries openDatabase() up to 4 times with exponential backoff,
 * verifies with a test read transaction, then retries all stashed operations.
 *
 * @returns {Promise<boolean>} true if recovery succeeded
 */
export async function attemptRecovery() {
  // Singleton guard — return existing promise if already recovering
  if (recoveryPromise) return recoveryPromise;

  recoveryPromise = _doRecovery();
  const result = await recoveryPromise;
  recoveryPromise = null;
  return result;
}

// ── Internals ──────────────────────────────────────────────────────

async function _doRecovery() {
  console.log('[HealthMonitor] Starting IDB recovery...');

  // Force-close the stale cached connection so openDatabase() starts fresh
  closeDatabase();

  for (let i = 0; i < RECOVERY_DELAYS.length; i++) {
    const delay = RECOVERY_DELAYS[i];
    console.log(`[HealthMonitor] Recovery attempt ${i + 1}/${RECOVERY_DELAYS.length} (delay ${delay}ms)`);

    await sleep(delay);

    try {
      // Clear cache before each attempt so we get a truly fresh connection
      closeDatabase();
      const db = await openDatabase();

      // Verify with a lightweight test transaction
      await new Promise((resolve, reject) => {
        try {
          const tx = db.transaction('nodes', 'readonly');
          const store = tx.objectStore('nodes');
          const req = store.count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          tx.onerror = () => reject(tx.error);
        } catch (e) {
          reject(e);
        }
      });

      // Don't close — the singleton will keep this healthy connection cached

      // Recovery succeeded
      console.log('[HealthMonitor] IDB recovery SUCCEEDED');
      idbBroken = false;
      consecutiveFailures = 0;
      hideIDBRecoveryToast();

      // Retry stashed operations
      await _drainFailedOps();

      return true;
    } catch (e) {
      console.warn(`[HealthMonitor] Recovery attempt ${i + 1} failed:`, e);
    }
  }

  // All attempts exhausted
  console.error('[HealthMonitor] IDB recovery FAILED — all attempts exhausted');
  updateIDBRecoveryToast('Database unavailable \u2014 tap Refresh');
  return false;
}

async function _drainFailedOps() {
  if (failedOperationQueue.length === 0) return;

  console.log(`[HealthMonitor] Retrying ${failedOperationQueue.length} stashed operations...`);
  const ops = failedOperationQueue.splice(0);

  for (const fn of ops) {
    try {
      await fn();
    } catch (e) {
      console.warn('[HealthMonitor] Stashed operation retry failed:', e);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
