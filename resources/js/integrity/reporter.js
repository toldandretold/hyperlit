/**
 * Integrity Reporter
 *
 * When the verifier detects a DOM-vs-IDB mismatch this module:
 *  1. console.warn (always — dev debugging)
 *  2. Shows a blocking modal overlay (data-loss situation, not a minor warning)
 *  3. Auto-sends diagnostic email to fml@hyperlit.io via backend endpoint
 *
 * Rate-limited: one popup per 60 seconds max.
 */

import { getRecentLogs } from './logCapture.js';
import { isIDBBroken } from '../indexedDB/core/healthMonitor.js';

const _sessionStartTs = Date.now();
let _lastPopupTs = 0;
const POPUP_COOLDOWN_MS = 60_000;
let _modalEl = null;

/**
 * Report an integrity failure.
 *
 * @param {Object} opts
 * @param {string}   opts.bookId       - Affected book
 * @param {Array}    opts.mismatches   - Array of {nodeId, domText, idbText}
 * @param {string[]} opts.missingFromIDB - Node IDs present in DOM but absent from IDB
 * @param {string}   opts.trigger      - What triggered the check ("save" | "paste" | "manual")
 */
export function reportIntegrityFailure({ bookId, mismatches = [], missingFromIDB = [], duplicateIds = [], trigger = 'unknown' }) {
  // Always log
  console.warn('[integrity] MISMATCH DETECTED', { bookId, mismatches, missingFromIDB, duplicateIds, trigger });

  // Count total DOM nodes for this book
  const container = document.querySelector(`[data-book-id="${bookId}"]`)
    || document.getElementById(bookId);
  let totalDomNodes = 0;
  if (container) {
    container.querySelectorAll('[id]').forEach(el => {
      if (/^\d+(\.\d+)?$/.test(el.id)) totalDomNodes++;
    });
  }

  // Build diagnostic payload
  const payload = {
    bookId,
    mismatches: mismatches.map(m => ({
      nodeId: m.nodeId,
      domText: (m.domText || '').substring(0, 500),
      idbText: (m.idbText || '').substring(0, 500),
    })),
    missingFromIDB: missingFromIDB.map(m =>
      typeof m === 'object' ? { nodeId: m.nodeId, tag: m.tag, domText: (m.domText || '').substring(0, 300) } : { nodeId: m }
    ),
    duplicateIds,
    trigger,
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    recentLogs: getRecentLogs(),
    context: {
      totalDomNodes,
      sessionAgeSec: Math.round((Date.now() - _sessionStartTs) / 1000),
      idbBroken: isIDBBroken(),
    },
  };

  // Fire email report immediately (don't wait for user action)
  _sendReport(payload);

  // Rate-limit popup display
  const now = Date.now();
  if (now - _lastPopupTs < POPUP_COOLDOWN_MS) {
    console.warn('[integrity] Popup suppressed (cooldown)');
    return;
  }
  _lastPopupTs = now;

  _showModal();
}

// ================================================================
// RETRY QUEUE — guarantees no report is silently dropped
// ================================================================
const _retryQueue = [];
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS  = 300_000;
const MAX_QUEUED    = 20;
let _retryTimer     = null;

function _scheduleRetry() {
  if (_retryTimer || _retryQueue.length === 0) return;
  const delay = Math.min(RETRY_BASE_MS * Math.pow(2, _retryQueue[0].attempts - 1), RETRY_MAX_MS);
  console.log(`[integrity] Retry scheduled in ${(delay / 1000).toFixed(0)}s (${_retryQueue.length} queued)`);
  _retryTimer = setTimeout(async () => {
    _retryTimer = null;
    await _flushRetryQueue();
  }, delay);
}

async function _flushRetryQueue() {
  while (_retryQueue.length > 0) {
    const entry = _retryQueue[0];
    const ok = await _doSend(entry.payload);
    if (ok) {
      _retryQueue.shift();
    } else {
      entry.attempts++;
      _scheduleRetry();
      return;
    }
  }
}

/**
 * Send diagnostic report to backend.
 * On failure (429, network error, etc.) queues for automatic retry.
 */
async function _sendReport(payload) {
  const ok = await _doSend(payload);
  if (!ok) {
    if (_retryQueue.length < MAX_QUEUED) {
      _retryQueue.push({ payload, attempts: 1 });
      _scheduleRetry();
    } else {
      console.warn('[integrity] Retry queue full — dropping oldest report');
      _retryQueue.shift();
      _retryQueue.push({ payload, attempts: 1 });
      _scheduleRetry();
    }
  }
}

/**
 * Low-level fetch. Returns true on 2xx, false on anything else.
 */
async function _doSend(payload) {
  try {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    const resp = await fetch('/api/integrity/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {}),
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      console.log('[integrity] Diagnostic report sent');
      return true;
    }
    console.warn(`[integrity] Report delivery failed (${resp.status}) — queued for retry`);
    return false;
  } catch (e) {
    console.error('[integrity] Failed to send diagnostic report:', e);
    return false;
  }
}

/**
 * Show a blocking modal overlay.
 * Not dismissable by clicking outside — only the Dismiss button closes it.
 */
function _showModal() {
  if (_modalEl) return; // Already showing

  const backdrop = document.createElement('div');
  backdrop.id = 'integrity-failure-backdrop';
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '999999',
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#fff',
    color: '#1a1a1a',
    borderRadius: '12px',
    padding: '32px',
    maxWidth: '480px',
    width: '90%',
    boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    lineHeight: '1.5',
  });

  card.innerHTML = `
    <p style="margin:0 0 20px; font-size:15px;">
      Apologies! Hyperlit is in pre-beta. We just failed to sync some of
      your changes. Our team has been automatically notified.
    </p>
    <div style="display:flex; gap:12px; flex-wrap:wrap;">
      <button id="integrity-download-btn" style="
        padding:10px 20px; border-radius:8px; border:1px solid #ccc;
        background:#f5f5f5; cursor:pointer; font-size:14px;
      ">Download content as .md</button>
      <button id="integrity-dismiss-btn" style="
        padding:10px 20px; border-radius:8px; border:none;
        background:#2563eb; color:#fff; cursor:pointer; font-size:14px;
      ">Dismiss</button>
    </div>
  `;

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  _modalEl = backdrop;

  // Dismiss button
  card.querySelector('#integrity-dismiss-btn').addEventListener('click', () => {
    _closeModal();
  });

  // Download button (placeholder)
  card.querySelector('#integrity-download-btn').addEventListener('click', () => {
    // TODO: implement DOM-to-markdown export for unsaved content
    console.log('[integrity] Download .md clicked — not yet implemented');
  });
}

function _closeModal() {
  if (_modalEl) {
    _modalEl.remove();
    _modalEl = null;
  }
}
