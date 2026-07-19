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

import { getRecentLogs } from './logCapture';
import { log } from '../utilities/logger';
import { trapModalFocus } from '../utilities/modalFocusTrap';
import { isIDBBroken } from '../indexedDB/core/healthMonitor';
import {
  buildBrowserMd,
  buildBrowserDatabaseMd,
  buildServerDatabaseMd,
  buildStitchedUpMd,
  buildReadme,
} from './emergencyBackup';
import { isLoggedIn } from '../utilities/auth/index';
// Type-only import — verifier imports reporter dynamically, so this back-reference
// is erased at runtime and introduces no static cycle.
import type { NodeMismatch, MissingNode, DuplicateId } from './verifier';

/** A block element with no node id that integrity healing tried to adopt. */
export interface OrphanNode {
  tag: string;
  textSnippet?: string;
  assignedId?: string;
  healFailed?: boolean;
  error?: string;
}

/** The payload reportIntegrityFailure accepts (all collections optional). */
export interface IntegrityFailureReport {
  bookId: string;
  mismatches?: NodeMismatch[];
  // verifier emits rich MissingNode objects; batch.ts reports its invalid-id case
  // as a bare id string — reporter handles both (see the map below).
  missingFromIDB?: Array<MissingNode | string>;
  duplicateIds?: DuplicateId[];
  orphanedNodes?: OrphanNode[];
  trigger?: string;
  selfHealed?: boolean;
  selfHealedNodeIds?: Array<string | number>;
}

const _sessionStartTs = Date.now();
let _lastPopupTs = 0;
const POPUP_COOLDOWN_MS = 60_000;
let _modalEl: any = null;
let _releaseModalTrap: (() => void) | null = null;

/**
 * Report an integrity failure.
 *
 * @param {Object} opts
 * @param {string}   opts.bookId       - Affected book
 * @param {Array}    opts.mismatches   - Array of {startLine, nodeId, domText, idbText}
 * @param {string[]} opts.missingFromIDB - Node IDs present in DOM but absent from IDB
 * @param {string}   opts.trigger      - What triggered the check ("save" | "paste" | "manual")
 */
export async function reportIntegrityFailure({ bookId, mismatches = [], missingFromIDB = [], duplicateIds = [], orphanedNodes = [], trigger = 'unknown', selfHealed = false, selfHealedNodeIds = [] }: IntegrityFailureReport) : Promise<void> {
  // Always log
  console.warn('[integrity] MISMATCH DETECTED', { bookId, mismatches, missingFromIDB, duplicateIds, orphanedNodes, trigger });

  if (orphanedNodes.length > 0) {
    console.warn(`[integrity] Orphaned nodes (${orphanedNodes.length}):`);
    orphanedNodes.forEach((o) => {
      if (o.healFailed) {
        console.warn(`  <${o.tag}> HEAL FAILED: ${o.error || 'unknown'} — "${o.textSnippet?.substring(0, 80)}"`);
      } else {
        console.warn(`  <${o.tag}> healed → ID ${o.assignedId} — "${o.textSnippet?.substring(0, 80)}"`);
      }
    });
  }

  if (mismatches.length > 0) {
    console.group('[integrity] Mismatch details');
    mismatches.forEach((m) => {
      console.warn(`Node ${m.startLine || m.nodeId}:`, {
        domText: m.domText,
        idbText: m.idbText,
        ...(m.diff ? { diffAtChar: m.diff.diffIndex, domSnippet: m.diff.snippetA, idbSnippet: m.diff.snippetB } : {}),
      });
    });
    console.groupEnd();
  }

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
    const { openDatabase } = await import('../indexedDB/core/connection');
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

  // Detect mass local-cache loss: 80%+ of rendered nodes absent from IDB with
  // ZERO content mismatches. The DOM (rendered from the server) is fine — only
  // the local IndexedDB cache is gutted. In practice this is the browser
  // evicting storage (Safari ITP 7-day wipe, storage-pressure eviction, a dead
  // IDB connection dropping writes) — NOT the user in DevTools: a manual wipe +
  // refresh just re-downloads from the server and never produces this signature.
  const localCacheLoss =
    missingFromIDB.length > 10 &&
    mismatches.length === 0 &&
    totalDomNodes > 0 &&
    (missingFromIDB.length / totalDomNodes) > 0.8;

  // Build diagnostic payload
  const payload = {
    bookId,
    // Wire name kept for server compat (IntegrityReportController validates
    // 'suspiciousWipe') — semantically this now means "local cache loss".
    suspiciousWipe: localCacheLoss,
    mismatches: mismatches.map((m: any) => ({
      startLine: m.startLine || m.nodeId,
      nodeId: m.nodeId || null,
      domText: m.domText || '',
      idbText: m.idbText || '',
      diff: m.diff || null,
      // Defect-2 diagnostics: raw seam so a hidden zero-width joiner / collapsed
      // space is identifiable post-hoc (normalised text/diff above can't show it).
      rawDomHtml: (m.rawDomHtml || '').substring(0, 800),
      rawIdbHtml: (m.rawIdbHtml || '').substring(0, 800),
      codesAroundDiff: m.codesAroundDiff || null,
    })),
    missingFromIDB: missingFromIDB.map((m) =>
      typeof m === 'object' ? { startLine: m.startLine || m.nodeId, nodeId: m.nodeId || null, tag: m.tag, domText: (m.domText || '').substring(0, 300) } : { startLine: m }
    ),
    duplicateIds: duplicateIds.map((d: any) => {
      const elements = container
        ? Array.from(container.querySelectorAll(`[id="${CSS.escape(d.id)}"]`))
        : [];
      return {
        ...d,
        elements: elements.map(el => ({
          tag: el.tagName,
          dataNodeId: el.getAttribute('data-node-id') || null,
          outerHTML: (el.outerHTML || '').substring(0, 500),
        })),
      };
    }),
    orphanedNodes: orphanedNodes.map((o: any) => ({
      tag: o.tag || null,
      textSnippet: (o.textSnippet || '').substring(0, 500),
      assignedId: o.assignedId || null,
      healFailed: o.healFailed || false,
      error: o.error || null,
    })),
    trigger,
    selfHealed,
    selfHealedNodeIds,
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    recentLogs: getRecentLogs(),
    context: {
      totalDomNodes,
      totalIdbNodes,
      sessionAgeSec: Math.round((Date.now() - _sessionStartTs) / 1000),
      idbBroken: isIDBBroken(),
    },
  };

  // Rate-limit popup display
  const now = Date.now();
  if (localCacheLoss) {
    // Cache loss overrides any existing modal — the full-book scan
    // has better data than the small post-save check that fired first.
    _closeModal();
    _lastPopupTs = now;
    _showModal(bookId, payload, selfHealed, localCacheLoss);
    return;
  }
  if (now - _lastPopupTs < POPUP_COOLDOWN_MS) {
    console.warn('[integrity] Popup suppressed (cooldown)');
    return;
  }
  _lastPopupTs = now;

  _showModal(bookId, payload, selfHealed, localCacheLoss);
}

/**
 * Report a PERSISTENT server-side sync failure (a 5xx that kept failing).
 *
 * Reuses the integrity modal's blackBox download + bug report, but this is NOT a data-loss
 * case: the edit is saved locally and the queue keeps retrying — the SERVER couldn't accept
 * it. So the modal omits Emergency Rectify and the upfront premium grant (premium instead
 * rides on sending the report). Called from syncQueue/master.js after consecutive 5xx on
 * one book — see the tiered policy: first 5xx → toast, persistent → this modal.
 *
 * @param {Object} opts
 * @param {string} opts.bookId
 * @param {number} opts.status  - failing HTTP status (500/502/503/504…)
 * @param {Error}  [opts.error] - the caught error
 */
export async function reportServerError({ bookId, status, error }: any) : Promise<any> {
  console.warn(`[integrity] Persistent server error (${status}) syncing ${bookId}`);

  const payload = {
    bookId,
    trigger: 'sync-server-error',
    serverError: { status: status ?? null, message: (error?.message || '').slice(0, 2000) },
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    recentLogs: getRecentLogs(),
    context: {
      sessionAgeSec: Math.round((Date.now() - _sessionStartTs) / 1000),
      idbBroken: isIDBBroken(),
    },
  };

  // Same one-per-60s cooldown + single-modal guard as integrity popups.
  const now = Date.now();
  if (now - _lastPopupTs < POPUP_COOLDOWN_MS) {
    console.warn('[integrity] Server-error modal suppressed (cooldown)');
    return;
  }
  _lastPopupTs = now;
  _showModal(bookId, payload, false, false, { status });
}

/**
 * AI citation review completed but found nothing to review (0 bibliography
 * entries + 0 citation footnotes). Fired from the empty-state banner when the
 * user believes the book DOES have references — i.e. they failed to persist to
 * Postgres (the copy-paste-import case). Reuses the integrity report sink
 * (/api/integrity/report) and its retry queue; NO modal (this isn't data loss,
 * just a heads-up). The pipeline id + bibliography signals ride in `comment`
 * because the endpoint only persists its whitelisted fields.
 */
export async function reportCitationMismatch(
  { bookId, pipelineId, signals }: { bookId: string; pipelineId?: string; signals?: any }
): Promise<void> {
  const payload = {
    bookId,
    trigger: 'citation-bibliography-missing',
    comment: (
      `AI citation review found nothing to review, but the user reports this book HAS `
      + `references (likely failed to save to Postgres). `
      + `pipelineId=${pipelineId ?? 'n/a'}; bibliographySignals=${JSON.stringify(signals ?? null)}`
    ).slice(0, 2000),
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    recentLogs: getRecentLogs(),
    context: {
      sessionAgeSec: Math.round((Date.now() - _sessionStartTs) / 1000),
      idbBroken: isIDBBroken(),
    },
  };
  await _sendReport(payload);
}

// ================================================================
// RETRY QUEUE — guarantees no report is silently dropped
// ================================================================
const _retryQueue: any[] = [];
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS  = 300_000;
const MAX_QUEUED    = 20;
let _retryTimer: any = null;

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
    const result: any = await _doSend(entry.payload);
    if (result.ok) {
      _retryQueue.shift();
    } else if (!result.retryable) {
      // Permanent failure — drop and move on instead of looping forever
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
 * On transient failure (network error, 5xx, 429) queues for automatic retry.
 * Permanent failures (4xx other than 429) are dropped — retrying the same
 * payload will produce the same error forever.
 */
async function _sendReport(payload: any) {
  const result: any = await _doSend(payload);
  if (result.ok) return;
  if (!result.retryable) return; // Permanent error — don't queue

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

/**
 * Low-level fetch. Returns {ok, retryable}.
 *   ok: true on 2xx
 *   retryable: true for network errors, 5xx, and 429 (transient)
 *              false for other 4xx (permanent — payload itself is bad)
 */
async function _doSend(payload: any) {
  try {
    const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
    const resp = await fetch('/api/integrity/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {}),
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      console.log('[integrity] Diagnostic report sent');
      return { ok: true, retryable: false };
    }
    // Read body so we can show *what* the server rejected (Laravel 422 returns
    // {message, errors: { 'field.path': ['rule failed'] }}). Without this the
    // "integrity debugger" is itself a black box.
    let body: any = null;
    try {
      const text = await resp.text();
      try { body = JSON.parse(text); } catch { body = text; }
    } catch { /* ignore */ }
    const retryable = resp.status >= 500 || resp.status === 429;
    const tag = retryable ? 'queued for retry' : 'permanent error, not retrying';
    const log = retryable ? console.warn : console.error;
    log(`[integrity] Report delivery failed (${resp.status}) — ${tag}`, {
      status: resp.status,
      errors: body?.errors ?? null,
      message: body?.message ?? null,
      bodyPreview: typeof body === 'string' ? body.slice(0, 500) : null,
      payloadSizes: {
        mismatches:        payload.mismatches?.length        ?? 0,
        missingFromIDB:    payload.missingFromIDB?.length    ?? 0,
        duplicateIds:      payload.duplicateIds?.length      ?? 0,
        orphanedNodes:     payload.orphanedNodes?.length     ?? 0,
        selfHealedNodeIds: payload.selfHealedNodeIds?.length ?? 0,
        recentLogs:        payload.recentLogs?.length        ?? 0,
        payloadBytes:      JSON.stringify(payload).length,
      },
    });
    return { ok: false, retryable };
  } catch (e) {
    console.error('[integrity] Failed to send diagnostic report:', e);
    return { ok: false, retryable: true };
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
function _showModal(bookId: any, payload: any, selfHealed = false, localCacheLoss = false, serverError: any = null) {
  if (_modalEl) return; // Already showing

  const backdrop = document.createElement('div');
  backdrop.id = 'integrity-failure-backdrop';
  backdrop.className = 'integrity-overlay';

  const card = document.createElement('div');
  card.className = 'integrity-card';

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

  if (serverError) {
    // Persistent server-side failure (5xx kept failing). Data is safe locally; the SERVER
    // couldn't accept it. Offer the same blackBox backup + bug report as the data-loss modal,
    // but NO Emergency Rectify (nothing to rectify — the local copy is fine) and NO upfront
    // premium grant (it's not data loss; premium rides on sending the report below).
    card.innerHTML = `
      <h3>Server trouble</h3>
      <p>Hyperlit keeps hitting a server error (<strong>${serverError.status}</strong>) while
      saving. Your work is safe on this device, but it hasn't reached our servers yet — it'll
      keep retrying.</p>
      <p>We recommend <strong>downloading</strong> a backup of your text, and sending a
      <strong>bug report</strong> (it includes the error code and recent logs) so we can fix it.</p>
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
  } else if (localCacheLoss) {
    // The browser evicted/corrupted the local IndexedDB cache (Safari's 7-day
    // ITP wipe, storage-pressure eviction, or a dead IDB connection dropping
    // writes). NOT data loss: the DOM rendered fine from the server, which is
    // the source of truth. Offer a clean rebuild of the local cache.
    card.innerHTML = `
      <h3>Your browser cleared Hyperlit's local cache</h3>
      <p>Most of this book's local offline copy is missing from your browser's
      storage. This is usually the browser itself tidying up (Safari in
      particular evicts site storage after inactivity or when disk is low) —
      not anything you did.</p>
      <p><strong>Your book and annotations are safe on the server.</strong>
      To get a clean local copy, hit Restore — it clears this book's cached
      data and re-downloads it fresh.</p>
      <textarea id="integrity-comment" class="integrity-comment"
        placeholder="Optional: describe what you were doing when this happened..."
        rows="3"></textarea>
      ${disclosureParagraph}
      <div id="integrity-rectify-status" class="integrity-status"></div>
      <div class="integrity-btn-group integrity-btn-group-sticky">
        <button id="integrity-restore-btn" class="integrity-btn integrity-btn-success">Restore from server</button>
        <button id="integrity-send-report-btn" class="integrity-btn">Send Bug Report</button>
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
  // Keyboard: trap Tab inside the modal. Deliberately NO onEscape — this is a
  // blocking data-loss dialog; the choice (report / rectify / dismiss) must be
  // an explicit button press, and the trap swallows Escape while open.
  _releaseModalTrap = trapModalFocus(backdrop);

  // Wire up all "?" info toggles
  card.querySelectorAll('.integrity-info-toggle').forEach(toggle => {
    const detail: any = toggle.nextElementSibling;
    if (detail && detail.classList.contains('integrity-info-detail')) {
      toggle.addEventListener('click', () => {
        const open = detail.style.display === 'none';
        detail.style.display = open ? 'inline' : 'none';
      });
    }
  });

  // Grant premium immediately for data-loss cases (no report required — consent shouldn't be
  // coerced). Server errors and browser cache-loss are NOT data loss, so they don't
  // auto-grant; premium instead rides on sending the bug report (see the send handler below).
  if (!serverError && !localCacheLoss) _grantPremium();

  // Dismiss button
  card.querySelector('#integrity-dismiss-btn')?.addEventListener('click', () => {
    _closeModal();
  });

  // Restore-from-server button (cache-loss variant only): wipe this book's
  // IDB rows (stale survivors included — half-evicted stores can hold rows
  // whose content no longer matches, e.g. highlight charData) and reload.
  // The fresh-load path re-downloads everything from the server.
  const restoreBtn: any = card.querySelector('#integrity-restore-btn');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Clearing local copy…';
      try {
        const { deleteBookFromIndexedDB } = await import('../indexedDB/utilities/cleanup');
        await deleteBookFromIndexedDB(bookId);
      } catch (e) {
        // A broken IDB connection can make the delete fail — reload anyway;
        // the fresh-load path upserts over whatever is left.
        log.error(`[integrity] Restore: could not clear book from IDB, reloading anyway: ${(e as Error)?.message}`, 'integrity/reporter.ts');
      }
      restoreBtn.textContent = 'Re-downloading…';
      window.location.reload();
    });
  }

  // Download emergency backup button
  const downloadBtn : any = card.querySelector('#integrity-download-btn');
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

        const files: any = {};
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
  const reportBtn : any = card.querySelector('#integrity-send-report-btn');
  if (reportBtn) reportBtn.addEventListener('click', async () => {
    const reportBtn : any = card.querySelector('#integrity-send-report-btn');
    reportBtn.disabled = true;
    reportBtn.textContent = 'Sending…';

    // Attach optional comment
    const commentEl : any = card.querySelector('#integrity-comment');
    const comment = commentEl ? commentEl.value.trim() : '';
    if (comment) payload.comment = comment;

    await _sendReport(payload);

    const loggedIn = await isLoggedIn();

    // Server-error and cache-loss modals skipped the upfront grant — reward it
    // now that they've reported.
    if ((serverError || localCacheLoss) && loggedIn) await _grantPremium();

    if (loggedIn) {
      card.innerHTML = `
        <p>Thanks for contributing to the digital knowledge commons! You've been upgraded to premium ✊</p>
        <div class="integrity-btn-group">
          <button class="integrity-btn integrity-btn-primary integrity-dismiss-ok">Ok</button>
          <button class="integrity-btn integrity-btn-primary integrity-dismiss-ok">No worries</button>
        </div>
      `;
      card.querySelectorAll('.integrity-dismiss-ok').forEach(btn => btn.addEventListener('click', () => _closeModal()));
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
      const infoToggleP : any = card.querySelector('.integrity-info-toggle')?.parentElement;
      if (infoToggleP) {
        infoToggleP.parentNode.insertBefore(postSendDiv, infoToggleP);
      } else {
        card.appendChild(postSendDiv);
      }

      const openAuthForm = async (formType: any) => {
        // Hide modal so userContainer (z-index 1000) is accessible
        backdrop.style.display = 'none';
        const { initializeUserContainer } = await import('../components/userButton/userButton');
        const mgr = initializeUserContainer();
        if (mgr) {
          if (formType === 'register') mgr.showRegisterForm();
          else mgr.showLoginForm();
        }
        // Poll for auth — when user logs in/registers, claim premium
        _pollForAuthAndClaim(backdrop, card);
      };

      postSendDiv.querySelector('#integrity-login-link')?.addEventListener('click', () => openAuthForm('login'));
      postSendDiv.querySelector('#integrity-register-link')?.addEventListener('click', () => openAuthForm('register'));
    }
  });

  // Emergency Rectify button (only present when selfHealed = false)
  const rectifyBtn : any = card.querySelector('#integrity-rectify-btn');
  if (rectifyBtn) {
    rectifyBtn.addEventListener('click', async () => {
      const statusEl : any = card.querySelector('#integrity-rectify-status');

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
        const nodeIds: any[] = [];
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
        const { queueNodeForSave, flushAllPendingSaves } = await import('../divEditor/index');

        // Queue all nodes for re-save
        for (const id of nodeIds) {
          queueNodeForSave(id, 'update', bookId);
        }
        await flushAllPendingSaves();

        // Re-verify
        const { verifyNodesIntegrity: verify } = await import('./verifier');
        const result: any = await verify(bookId, nodeIds);

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
        statusEl.textContent = `Rectify error: ${(e as any).message}`;
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
function _pollForAuthAndClaim(backdrop: any, card: any) {
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
      const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
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
        <button class="integrity-btn integrity-btn-primary integrity-dismiss-ok">Ok</button>
        <button class="integrity-btn integrity-btn-primary integrity-dismiss-ok">No worries</button>
      </div>
    `;
    card.querySelectorAll('.integrity-dismiss-ok').forEach((btn: any) => btn.addEventListener('click', () => _closeModal()));
  }, 2000);
}

/**
 * Grant premium immediately when the modal appears (fire-and-forget).
 * Works for logged-in users; anonymous users get it via _pollForAuthAndClaim.
 */
async function _grantPremium() {
  try {
    const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
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
  if (_releaseModalTrap) {
    _releaseModalTrap();
    _releaseModalTrap = null;
  }
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
    const result: any = await Promise.race([
      import('https://cdn.skypack.dev/jszip'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('JSZip CDN timeout')), 3000)),
    ]);
    return result.default || result;
  } catch (e) {
    console.warn('[integrity] Could not load JSZip:', e);
    return null;
  }
}

function _triggerDownload(blob: any, filename: any) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function _downloadAsFile(filename: any, content: any, mimeType: any) {
  const blob = new Blob([content], { type: mimeType });
  _triggerDownload(blob, filename);
}
