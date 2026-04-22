/**
 * Integrity Reporter
 *
 * When the verifier detects a DOM-vs-IDB mismatch this module:
 *  1. console.warn (always — dev debugging)
 *  2. Shows a blocking modal overlay (data-loss situation, not a minor warning)
 *  3. Offers opt-in "Send Bug Report" button (consent required — payload contains HTML)
 *
 * Rate-limited: one popup per 60 seconds max.
 */

import { getRecentLogs } from './logCapture.js';
import { isIDBBroken } from '../indexedDB/core/healthMonitor.js';
import {
  buildBrowserMd,
  buildBrowserDatabaseMd,
  buildServerDatabaseMd,
  buildStitchedUpMd,
  buildReadme,
} from './emergencyBackup.js';
import { isLoggedIn } from '../utilities/auth.js';

const _sessionStartTs = Date.now();
let _lastPopupTs = 0;
const POPUP_COOLDOWN_MS = 60_000;
let _modalEl = null;

/**
 * Report an integrity failure.
 *
 * @param {Object} opts
 * @param {string}   opts.bookId       - Affected book
 * @param {Array}    opts.mismatches   - Array of {startLine, nodeId, domText, idbText}
 * @param {string[]} opts.missingFromIDB - Node IDs present in DOM but absent from IDB
 * @param {string}   opts.trigger      - What triggered the check ("save" | "paste" | "manual")
 */
export async function reportIntegrityFailure({ bookId, mismatches = [], missingFromIDB = [], duplicateIds = [], trigger = 'unknown', selfHealed = false, selfHealedNodeIds = [] }) {
  // Always log
  console.warn('[integrity] MISMATCH DETECTED', { bookId, mismatches, missingFromIDB, duplicateIds, trigger });

  // TODO: Re-enable once self-healing is battle-tested and we're confident no data is lost.
  // For now, always show the modal so users can send bug reports and claim premium.
  // if (selfHealed) {
  //   console.log('[integrity] Self-healing succeeded — no data loss, suppressing modal');
  //   return;
  // }

  // Count total DOM nodes for this book
  const container = document.querySelector(`[data-book-id="${bookId}"]`)
    || document.getElementById(bookId);
  let totalDomNodes = 0;
  if (container) {
    container.querySelectorAll('[id]').forEach(el => {
      if (/^\d+(\.\d+)?$/.test(el.id)) totalDomNodes++;
    });
  }

  // Count IDB nodes for this book
  let totalIdbNodes = 0;
  try {
    const { openDatabase } = await import('../indexedDB/core/connection.js');
    const db = await openDatabase();
    const tx = db.transaction('nodes', 'readonly');
    const index = tx.objectStore('nodes').index('book');
    totalIdbNodes = await new Promise((resolve, reject) => {
      const req = index.count(bookId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
  } catch (e) {
    console.warn('[integrity] Could not count IDB nodes:', e);
  }

  // Detect deliberate IDB wipe: 80%+ nodes missing, zero mismatches, non-trivial book
  const suspiciousWipe =
    missingFromIDB.length > 10 &&
    mismatches.length === 0 &&
    totalDomNodes > 0 &&
    (missingFromIDB.length / totalDomNodes) > 0.8;

  // Build diagnostic payload
  const payload = {
    bookId,
    suspiciousWipe,
    mismatches: mismatches.map(m => ({
      startLine: m.startLine || m.nodeId,
      nodeId: m.nodeId || null,
      domText: (m.domText || '').substring(0, 500),
      idbText: (m.idbText || '').substring(0, 500),
    })),
    missingFromIDB: missingFromIDB.map(m =>
      typeof m === 'object' ? { startLine: m.startLine || m.nodeId, nodeId: m.nodeId || null, tag: m.tag, domText: (m.domText || '').substring(0, 300) } : { startLine: m }
    ),
    duplicateIds,
    trigger,
    selfHealed,
    selfHealedNodeIds,
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

  // Rate-limit popup display
  const now = Date.now();
  if (suspiciousWipe) {
    // Suspicious wipe overrides any existing modal — the full-book scan
    // has better data than the small post-save check that fired first.
    _closeModal();
    _lastPopupTs = now;
    _showModal(bookId, payload, selfHealed, suspiciousWipe);
    return;
  }
  if (now - _lastPopupTs < POPUP_COOLDOWN_MS) {
    console.warn('[integrity] Popup suppressed (cooldown)');
    return;
  }
  _lastPopupTs = now;

  _showModal(bookId, payload, selfHealed, suspiciousWipe);
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
 * Show a blocking modal overlay with consent-based reporting.
 * Not dismissable by clicking outside — only the Dismiss button closes it.
 *
 * @param {string}  bookId     - Affected book
 * @param {Object}  payload    - Diagnostic payload (sent only if user clicks Send Bug Report)
 * @param {boolean} selfHealed - Whether the issue was auto-fixed
 */
function _showModal(bookId, payload, selfHealed = false, suspiciousWipe = false) {
  if (_modalEl) return; // Already showing

  const backdrop = document.createElement('div');
  backdrop.id = 'integrity-failure-backdrop';
  backdrop.className = 'integrity-overlay';

  const card = document.createElement('div');
  card.className = 'integrity-card';

  const premiumParagraph = `
    <p>While we are still in beta testing, this is not good enough.
    <strong>Free Premium 🙏</strong> — as compensation you have been awarded one month premium membership,
    including free PDF conversion, AI Archivist, and Citation Review.</p>
  `;

  const disclosureParagraph = `
    <p style="font-size:13px; opacity:0.65; font-style:italic;">
      Why or why not submit?
      <span class="integrity-info-toggle" tabindex="0" role="button" aria-label="More info"
        style="cursor:pointer;display:inline-block;width:15px;height:15px;line-height:15px;
        text-align:center;border-radius:50%;border:1px solid rgba(78,172,174,0.5);
        font-size:10px;vertical-align:middle;margin-left:4px;">?</span>
      <span class="integrity-info-detail" style="display:none;">
        Why: Support the digital knowledge commons.
        Why not: Requires sending some potentially private HTML to fml@hyperlit.io.
        You will <em>always</em> have full personal data sovereignty.
      </span>
    </p>
  `;

  if (suspiciousWipe) {
    card.innerHTML = `
      <h3>Okay, hacker 👀</h3>
      <p>Looks like someone's been in DevTools clearing out IndexedDB nodes...
      We see you.</p>
      <p>Here's the thing though — you still get premium. Consider it a reward
      for your curiosity. Welcome to the club ✊</p>
      ${premiumParagraph}
      <div class="integrity-btn-group integrity-btn-group-sticky">
        <button id="integrity-dismiss-btn" class="integrity-btn integrity-btn-primary">Dismiss</button>
      </div>
    `;
  } else if (selfHealed) {
    card.innerHTML = `
      <h3>Apologies comrade</h3>
      <p>
        Hyperlit detected a data sync issue and automatically
        fixed it. We believe no data was lost.
      </p>
      <p>
      While we are in beta testing, this is not good enough. Please enjoy <strong>Free Premium</strong> 🙏.
      <span class="integrity-info-toggle" tabindex="0" role="button" aria-label="Premium details"
        style="cursor:pointer;display:inline-block;width:15px;height:15px;line-height:15px;
        text-align:center;border-radius:50%;border:1px solid rgba(78,172,174,0.5);
        font-size:10px;vertical-align:middle;margin-left:4px;">?</span>
      <span class="integrity-info-detail" style="display:none;">
        Includes free PDF conversion, AI Archivist, and Citation Review.
      </span> </p>
      <p>We recommend <strong>downloading</strong> a backup of your text as markdown, and sending a <strong>bug report</strong>.
      </p>
      <textarea id="integrity-comment" class="integrity-comment"
        placeholder="Optional: describe what you were doing when this happened..."
        rows="3"></textarea>
      ${disclosureParagraph}
      <div id="integrity-rectify-status" class="integrity-status"></div>
      <div class="integrity-btn-group integrity-btn-group-sticky">
        <button id="integrity-download-btn" class="integrity-btn-download">Download blackBox.md</button>
        <button id="integrity-send-report-btn" class="integrity-btn integrity-btn-success">Send Bug Report</button>
        <button id="integrity-dismiss-btn" class="integrity-btn integrity-btn-primary">Dismiss</button>
      </div>
    `;
  } else {
    card.innerHTML = `
      <h3>Apologies comrade</h3>
      <p>
        Hyperlit is in pre-beta testing. We have detected data
        loss (our bad). We recommend downloading a backup so you won't lose any of your work.
      </p>
      <p>
      While we are in beta testing, this is not good enough. Please enjoy <strong>Free Premium</strong> 🙏.
      <span class="integrity-info-toggle" tabindex="0" role="button" aria-label="Premium details"
        style="cursor:pointer;display:inline-block;width:15px;height:15px;line-height:15px;
        text-align:center;border-radius:50%;border:1px solid rgba(78,172,174,0.5);
        font-size:10px;vertical-align:middle;margin-left:4px;">?</span>
      <span class="integrity-info-detail" style="display:none;">
        Includes free PDF conversion, AI Archivist, and Citation Review.
      </span> </p>
      <p>We recommend <strong>downloading</strong> a backup of your text as markdown, and sending a <strong>bug report</strong>.
      </p>
      
      <textarea id="integrity-comment" class="integrity-comment"
        placeholder="Optional: describe what you were doing when this happened..."
        rows="3"></textarea>
      ${disclosureParagraph}
      <div id="integrity-rectify-status" class="integrity-status"></div>
      <div class="integrity-btn-group integrity-btn-group-sticky">
        <button id="integrity-download-btn" class="integrity-btn-download">Download blackBox.md</button>
        <button id="integrity-send-report-btn" class="integrity-btn integrity-btn-success">Send Bug Report</button>
        <button id="integrity-rectify-btn" class="integrity-btn integrity-btn-danger">Emergency Rectify</button>
        <button id="integrity-dismiss-btn" class="integrity-btn integrity-btn-primary">Dismiss</button>
      </div>
    `;
  }

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  _modalEl = backdrop;

  // Wire up all "?" info toggles
  card.querySelectorAll('.integrity-info-toggle').forEach(toggle => {
    const detail = toggle.nextElementSibling;
    if (detail && detail.classList.contains('integrity-info-detail')) {
      toggle.addEventListener('click', () => {
        const open = detail.style.display === 'none';
        detail.style.display = open ? 'inline' : 'none';
      });
    }
  });

  // Grant premium immediately (no report required — consent shouldn't be coerced)
  _grantPremium();

  // Dismiss button
  card.querySelector('#integrity-dismiss-btn').addEventListener('click', () => {
    _closeModal();
  });

  // Download emergency backup button
  const downloadBtn = card.querySelector('#integrity-download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Preparing backup…';

      try {
        const [browserResult, idbResult, serverMd] = await Promise.all([
          buildBrowserMd(bookId),
          buildBrowserDatabaseMd(bookId),
          buildServerDatabaseMd(bookId),
        ]);

        const stitchedMd = buildStitchedUpMd(
          idbResult?.nodeMap || null,
          browserResult?.nodeMap || null,
        );

        const files = {};
        if (browserResult?.markdown) files['browser.md'] = browserResult.markdown;
        if (idbResult?.markdown) files['browserDatabase.md'] = idbResult.markdown;
        if (serverMd) files['serverDatabase.md'] = serverMd;
        if (stitchedMd) files['stitchedUp.md'] = stitchedMd;

        const readme = buildReadme(bookId, files);
        files['README.md'] = readme;

        const JSZip = await _loadJSZipSafe();
        if (JSZip) {
          const zip = new JSZip();
          for (const [name, content] of Object.entries(files)) {
            zip.file(name, content);
          }
          const blob = await zip.generateAsync({ type: 'blob' });
          _triggerDownload(blob, `hyperlit-backup-${bookId}.zip`);
        } else {
          // Fallback: download best available file as plain text
          const fallback = files['stitchedUp.md'] || files['browser.md'] || files['browserDatabase.md'] || readme;
          _downloadAsFile(`hyperlit-backup-${bookId}.md`, fallback, 'text/markdown');
        }

        downloadBtn.textContent = 'Downloaded!';
        downloadBtn.className = 'integrity-btn integrity-btn-success';
      } catch (e) {
        console.error('[integrity] Emergency backup failed:', e);
        downloadBtn.textContent = 'Download failed';
        downloadBtn.className = 'integrity-btn integrity-btn-danger';
      }
    });
  }

  // Send Bug Report button (consent-based — not present in suspiciousWipe variant)
  const reportBtn = card.querySelector('#integrity-send-report-btn');
  if (reportBtn) reportBtn.addEventListener('click', async () => {
    const reportBtn = card.querySelector('#integrity-send-report-btn');
    reportBtn.disabled = true;
    reportBtn.textContent = 'Sending…';

    // Attach optional comment
    const commentEl = card.querySelector('#integrity-comment');
    const comment = commentEl ? commentEl.value.trim() : '';
    if (comment) payload.comment = comment;

    await _sendReport(payload);

    const loggedIn = await isLoggedIn();

    if (loggedIn) {
      card.innerHTML = `
        <p>Thanks for contributing to the digital knowledge commons! You've been upgraded to premium ✊</p>
        <div class="integrity-btn-group">
          <button id="integrity-dismiss-btn" class="integrity-btn integrity-btn-primary">Dismiss</button>
        </div>
      `;
      card.querySelector('#integrity-dismiss-btn').addEventListener('click', () => _closeModal());
    } else {
      reportBtn.remove();
      // Insert login/register prompt where button was
      const postSendDiv = document.createElement('div');
      postSendDiv.style.margin = '0 0 16px';
      postSendDiv.innerHTML = `
        <p style="margin:0; font-size:14px;">
          Sent — thank you, comrade!
          <a class="integrity-auth-link" id="integrity-login-link">Log in</a> or
          <a class="integrity-auth-link" id="integrity-register-link">register</a>
          to claim your free month of premium.
        </p>
      `;
      const infoToggleP = card.querySelector('.integrity-info-toggle')?.parentElement;
      if (infoToggleP) {
        infoToggleP.parentNode.insertBefore(postSendDiv, infoToggleP);
      } else {
        card.appendChild(postSendDiv);
      }

      const openAuthForm = async (formType) => {
        // Hide modal so userContainer (z-index 1000) is accessible
        backdrop.style.display = 'none';
        const { initializeUserContainer } = await import('../components/userContainer.js');
        const mgr = initializeUserContainer();
        if (mgr) {
          if (formType === 'register') mgr.showRegisterForm();
          else mgr.showLoginForm();
        }
        // Poll for auth — when user logs in/registers, claim premium
        _pollForAuthAndClaim(backdrop, card);
      };

      postSendDiv.querySelector('#integrity-login-link').addEventListener('click', () => openAuthForm('login'));
      postSendDiv.querySelector('#integrity-register-link').addEventListener('click', () => openAuthForm('register'));
    }
  });

  // Emergency Rectify button (only present when selfHealed = false)
  const rectifyBtn = card.querySelector('#integrity-rectify-btn');
  if (rectifyBtn) {
    rectifyBtn.addEventListener('click', async () => {
      const statusEl = card.querySelector('#integrity-rectify-status');

      if (isIDBBroken()) {
        statusEl.className = 'integrity-status integrity-status-error';
        statusEl.style.display = 'block';
        statusEl.textContent = 'Database is unreachable — cannot rectify.';
        return;
      }

      rectifyBtn.disabled = true;
      rectifyBtn.textContent = 'Rectifying…';
      statusEl.style.display = 'none';

      try {
        const container = document.querySelector(`[data-book-id="${bookId}"]`)
          || document.getElementById(bookId);

        if (!container) {
          statusEl.className = 'integrity-status integrity-status-error';
          statusEl.style.display = 'block';
          statusEl.textContent = 'Book container not found in DOM.';
          rectifyBtn.disabled = false;
          rectifyBtn.textContent = 'Emergency Rectify';
          return;
        }

        // Collect all numeric-ID node elements
        const nodeEls = container.querySelectorAll('[id]');
        const nodeIds = [];
        nodeEls.forEach(el => {
          if (/^\d+(\.\d+)?$/.test(el.id)) nodeIds.push(el.id);
        });

        if (nodeIds.length === 0) {
          statusEl.className = 'integrity-status integrity-status-error';
          statusEl.style.display = 'block';
          statusEl.textContent = 'No nodes found in book container.';
          rectifyBtn.disabled = false;
          rectifyBtn.textContent = 'Emergency Rectify';
          return;
        }

        // Dynamic import to avoid circular dependency (reporter.js is imported by saveQueue.js)
        const { queueNodeForSave, flushAllPendingSaves } = await import('../divEditor/index.js');

        // Queue all nodes for re-save
        for (const id of nodeIds) {
          queueNodeForSave(id, 'update', bookId);
        }
        await flushAllPendingSaves();

        // Re-verify
        const { verifyNodesIntegrity: verify } = await import('./verifier.js');
        const result = await verify(bookId, nodeIds);

        const stillBroken = result.mismatches.length + result.missingFromIDB.length + result.duplicateIds.length;

        if (stillBroken === 0) {
          statusEl.className = 'integrity-status integrity-status-success';
          statusEl.style.display = 'block';
          statusEl.textContent = `All ${nodeIds.length} nodes OK`;
          setTimeout(() => _closeModal(), 2000);
        } else {
          statusEl.className = 'integrity-status integrity-status-error';
          statusEl.style.display = 'block';
          statusEl.textContent = `${stillBroken} node(s) still broken after rectify.`;
          rectifyBtn.disabled = false;
          rectifyBtn.textContent = 'Emergency Rectify';
        }
      } catch (e) {
        console.error('[integrity] Emergency Rectify failed:', e);
        statusEl.className = 'integrity-status integrity-status-error';
        statusEl.style.display = 'block';
        statusEl.textContent = `Rectify error: ${e.message}`;
        rectifyBtn.disabled = false;
        rectifyBtn.textContent = 'Emergency Rectify';
      }
    });
  }
}

/**
 * Poll isLoggedIn() every 2s. Once authenticated, call claim-premium
 * and re-show the modal with a success message.
 */
function _pollForAuthAndClaim(backdrop, card) {
  let attempts = 0;
  const MAX_ATTEMPTS = 150; // 5 minutes at 2s intervals
  const poll = setInterval(async () => {
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      clearInterval(poll);
      return;
    }
    // If modal was removed (user dismissed via other means), stop
    if (!_modalEl) {
      clearInterval(poll);
      return;
    }
    const loggedIn = await isLoggedIn();
    if (!loggedIn) return;
    clearInterval(poll);

    // Claim premium
    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
      await fetch('/api/integrity/claim-premium', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {}),
        },
        credentials: 'include',
      });
    } catch (e) {
      console.warn('[integrity] Failed to claim premium:', e);
    }

    // Re-show the modal with success — replace entire card
    backdrop.style.display = 'flex';
    card.innerHTML = `
      <p>Thanks for contributing to the digital knowledge commons! You've been upgraded to premium ✊</p>
      <div class="integrity-btn-group">
        <button id="integrity-dismiss-btn" class="integrity-btn integrity-btn-primary">Dismiss</button>
      </div>
    `;
    card.querySelector('#integrity-dismiss-btn').addEventListener('click', () => _closeModal());
  }, 2000);
}

/**
 * Grant premium immediately when the modal appears (fire-and-forget).
 * Works for logged-in users; anonymous users get it via _pollForAuthAndClaim.
 */
async function _grantPremium() {
  try {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    await fetch('/api/integrity/claim-premium', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {}),
      },
      credentials: 'include',
    });
  } catch (e) {
    // Silent — anonymous users won't have auth, that's fine
  }
}

function _closeModal() {
  if (_modalEl) {
    _modalEl.remove();
    _modalEl = null;
  }
}

// ================================================================
// EMERGENCY BACKUP — zip / download helpers (builders in emergencyBackup.js)
// ================================================================

/**
 * Load JSZip from Skypack CDN with a 3s timeout.
 * Returns the JSZip constructor or null on failure.
 */
async function _loadJSZipSafe() {
  try {
    const result = await Promise.race([
      import('https://cdn.skypack.dev/jszip'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('JSZip CDN timeout')), 3000)),
    ]);
    return result.default || result;
  } catch (e) {
    console.warn('[integrity] Could not load JSZip:', e);
    return null;
  }
}

function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function _downloadAsFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  _triggerDownload(blob, filename);
}
