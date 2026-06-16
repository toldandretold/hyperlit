/**
 * Save-error toast — surfaced when the cloudRef indicator glows red.
 *
 * The red glow (editIndicator.js:glowCloudRed) tells the user a save/sync failed but
 * not WHAT failed. This module classifies the failure and, when it's worth showing,
 * renders a toast explaining it. Severity drives persistence:
 *   - `transient`  → brief, auto-dismissing (network blip / retryable 5xx; data already
 *                    saved locally and will re-sync — the user needn't do anything).
 *   - `action`     → sticky until the user responds (refresh / log in); won't self-heal.
 *
 * Benign offline saves already show ORANGE (glowCloudLocalSave), not red, so they never
 * reach here. Glassmorphic visual style mirrors the conversion feedback toast
 * (resources/js/conversion/feedbackToast.js); lifecycle mirrors recoveryToast.js.
 */

const TOAST_ID = 'save-error-toast';
const TRANSIENT_DISMISS_MS = 5000;

/**
 * Classify a sync/save failure into a user-facing descriptor.
 *
 * Pure (no DOM) so it can be unit-tested against the mapping table.
 * @param {Object} [errorInfo]
 * @param {Error}   [errorInfo.error]        the caught error
 * @param {number}  [errorInfo.status]       HTTP status, if known
 * @param {string}  [errorInfo.code]         app error code (e.g. 'STALE_DATA')
 * @param {boolean} [errorInfo.savedLocally] whether the change is safe in IndexedDB/historyLog
 * @param {string}  [errorInfo.kind]         explicit category ('incomplete' | 'idb-broken-handled')
 * @returns {{severity:'transient'|'action', title:string, message:string, action?:{label:string,type:string}}|null}
 *          null = show nothing (just the glow).
 */
export function classifySyncError(errorInfo: any) {
  // No context provided → preserve legacy behaviour (glow only, no toast).
  if (!errorInfo || typeof errorInfo !== 'object') return null;

  const { error, status, code, savedLocally, kind } = errorInfo;

  // IndexedDB-broken already has its own recovery toast (showIDBRecoveryToast) — don't double up.
  if (kind === 'idb-broken-handled') return null;

  // Book out of date (409 STALE_DATA): handled by the blocking stale-tab overlay
  // (BroadcastListener.showStaleTabOverlay, fired from master.js) — a passive toast isn't
  // enough since the unsynced edit can't be saved. Return null so we don't double up.
  if (code === 'STALE_DATA') return null;

  // Session expired (419 → token refresh failed). Surfaced via the thrown message.
  const msg = error?.message || '';
  if (status === 419 || /session expired/i.test(msg)) {
    return {
      severity: 'action',
      title: 'Session expired',
      message: 'Please log in again to keep saving. Your changes are saved locally and will sync once you do.',
      action: { label: 'Log in', type: 'login' },
    };
  }

  // Paste/full-book aborted to protect an incomplete document.
  if (kind === 'incomplete') {
    return {
      severity: 'action',
      title: 'Save paused to protect your document',
      message: 'Your local copy looks incomplete, so we stopped to avoid overwriting good data. Refresh to restore it from the server.',
      action: { label: 'Refresh', type: 'refresh' },
    };
  }

  // Backend glitch (5xx) — name it as a SERVER problem and surface the code (not a vague
  // "hiccup"). A single 5xx usually succeeds on retry, so this stays a transient toast;
  // PERSISTENT 5xx is escalated to the serious blackBox modal by master.js (not here).
  if (typeof status === 'number' && status >= 500) {
    return savedLocally
      ? {
          severity: 'transient',
          title: `Server error (${status})`,
          message: 'A glitch on our end — your changes are saved and will retry automatically.',
        }
      : {
          severity: 'action',
          title: `Server error (${status})`,
          message: 'A glitch on our end. Refresh to be safe — your last change may not have saved.',
          action: { label: 'Refresh', type: 'refresh' },
        };
  }

  // Unknown failure, but the change is safe locally and the queue will retry — informational.
  if (savedLocally) {
    return {
      severity: 'transient',
      title: 'Connection hiccup',
      message: 'Your changes are saved and will sync automatically.',
    };
  }

  // Unknown failure with no local-save guarantee — ask the user to refresh to be safe.
  return {
    severity: 'action',
    title: "Couldn't save your change",
    message: 'Something went wrong reaching the server. Refresh to be safe — your latest edit may not have been saved.',
    action: { label: 'Refresh', type: 'refresh' },
  };
}

/** Run the action button's effect. */
function runAction(type: any) {
  if (type === 'refresh') {
    window.location.reload();
  } else if (type === 'login') {
    // Open the user/login container if present; otherwise fall back to a reload.
    const userBtn = document.getElementById('userButton') || document.getElementById('user-button');
    if (userBtn) userBtn.click();
    else window.location.reload();
  }
}

/** Shared button styling (mirrors feedbackToast.applyBtnStyle). */
function applyBtnStyle(btn: any) {
  Object.assign(btn.style, {
    background: '#555',
    color: '#fff',
    border: 'none',
    padding: '5px 14px',
    borderRadius: '4px',
    fontSize: '13px',
    cursor: 'pointer',
    flexShrink: '0',
    whiteSpace: 'nowrap',
  });
  btn.addEventListener('mouseenter', () => { btn.style.background = '#4EACAE'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#555'; });
}

/**
 * Classify `errorInfo` and, if it warrants surfacing, render the toast.
 * Single live instance — a newer error replaces the current toast.
 */
export function showSaveErrorToast(errorInfo: any) {
  const info = classifySyncError(errorInfo);
  if (!info) return;

  hideSaveErrorToast();

  const isLightTheme = document.body.classList.contains('theme-light')
                    || document.body.classList.contains('theme-sepia');
  const glassBg = isLightTheme ? 'rgba(40, 36, 32, 0.75)' : 'rgba(30, 30, 50, 0.55)';
  // Severity accent: warm/red for action-required, calm teal for transient.
  const accent = info.severity === 'action' ? '#EE4A95' : '#4EACAE';

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.setAttribute('role', info.severity === 'action' ? 'alert' : 'status');
  Object.assign(toast.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: glassBg,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    color: '#e0e0e0',
    padding: '12px 18px',
    borderLeft: `3px solid ${accent}`,
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    zIndex: '99999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    opacity: '0',
    transition: 'opacity 0.2s ease',
    width: 'calc(100vw - 32px)',
    maxWidth: '420px',
  });

  // Title row (+ manual dismiss "×" for sticky action toasts)
  const titleRow = document.createElement('div');
  Object.assign(titleRow.style, { display: 'flex', alignItems: 'center', gap: '12px' });

  const title = document.createElement('strong');
  title.textContent = info.title;
  Object.assign(title.style, { flex: '1', fontSize: '14px' });
  titleRow.appendChild(title);

  // Always dismissable — even transient toasts linger ~5s, long enough to annoy,
  // so let the user kill it early. (The auto-dismiss timer still fires for transient.)
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  Object.assign(close.style, {
    background: 'none', border: 'none', color: '#e0e0e0',
    fontSize: '18px', lineHeight: '1', cursor: 'pointer', flexShrink: '0', padding: '0 2px',
  });
  close.addEventListener('click', hideSaveErrorToast);
  titleRow.appendChild(close);
  toast.appendChild(titleRow);

  const body = document.createElement('span');
  body.textContent = info.message;
  Object.assign(body.style, { fontSize: '13px', color: '#cfcfcf' });
  toast.appendChild(body);

  if (info.action) {
    const actionRow = document.createElement('div');
    Object.assign(actionRow.style, { display: 'flex', justifyContent: 'flex-end' });
    const btn = document.createElement('button');
    btn.textContent = info.action.label;
    applyBtnStyle(btn);
    btn.addEventListener('click', () => runAction(info.action.type));
    actionRow.appendChild(btn);
    toast.appendChild(actionRow);
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  // Transient toasts fade themselves out; action toasts stay until dismissed/acted on.
  if (info.severity === 'transient') {
    setTimeout(hideSaveErrorToast, TRANSIENT_DISMISS_MS);
  }
}

export function hideSaveErrorToast() {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.style.opacity = '0';
  setTimeout(() => toast.remove(), 200);
}
