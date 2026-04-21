/**
 * Enhanced large-paste toast with conversion summary + glitch report flow.
 * Self-contained — no external CSS dependencies.
 * Glassmorphism toast, fixed top-center, theme-aware.
 *
 * Toast stays until explicitly dismissed (no auto-timeout).
 * Three buttons: Undo / Approve / Report Conversion Glitch
 * "Report" sends email then shows thank-you state with Undo / Deal with it.
 */

import { clearPasteSnapshot } from '../handlers/largePasteHandler.js';
import { getRecentLogs, getPasteLogs } from '../../integrity/logCapture.js';

const TOAST_ID = 'paste-undo-toast';

/* ── shared button style ──────────────────────────────────── */
function applyBtnStyle(btn) {
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
  btn.addEventListener('mousedown', () => { btn.style.background = '#3d8a8c'; });
  btn.addEventListener('mouseup', () => { btn.style.background = '#4EACAE'; });
}

/* ── build summary text from conversion metadata ─────────── */
function buildSummaryText(cs) {
  const parts = [];

  // Node count
  parts.push(`Pasted ~${cs.nodeCount ?? '?'} nodes`);

  // Source type
  if (cs.wasMarkdown) {
    parts[0] += '. Converted from markdown';
  } else if (cs.wasHtml) {
    const fmt = cs.formatType && cs.formatType !== 'general'
      ? ` (${cs.formatType} format)`
      : '';
    parts[0] += `. From HTML${fmt}`;
  }
  parts[0] += '.';

  // Footnotes & references
  const extras = [];
  if (cs.footnoteCount > 0) extras.push(`${cs.footnoteCount} footnote${cs.footnoteCount !== 1 ? 's' : ''}`);
  if (cs.referenceCount > 0) extras.push(`${cs.referenceCount} reference${cs.referenceCount !== 1 ? 's' : ''}`);
  if (extras.length) parts.push(`Extracted ${extras.join(', ')}.`);

  return parts.join(' ');
}

/* ── main export ──────────────────────────────────────────── */
export function showPasteUndoToast(onUndo, conversionSummary = {}) {
  // Remove previous toast if any
  hidePasteUndoToast();

  const isLightTheme = document.body.classList.contains('theme-light')
                    || document.body.classList.contains('theme-sepia');
  const glassBg = isLightTheme ? 'rgba(40, 36, 32, 0.75)' : 'rgba(30, 30, 50, 0.55)';

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
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
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    zIndex: '99999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    opacity: '0',
    transition: 'opacity 0.2s ease',
    maxWidth: '520px',
  });

  renderInitialState(toast, onUndo, conversionSummary);

  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
}

/* ── initial state: summary + 3 buttons ───────────────────── */
function renderInitialState(toast, onUndo, cs) {
  toast.innerHTML = '';

  const text = document.createElement('span');
  text.textContent = buildSummaryText(cs);
  text.style.lineHeight = '1.4';

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  // Undo
  const undoBtn = document.createElement('button');
  undoBtn.textContent = 'Undo';
  applyBtnStyle(undoBtn);
  undoBtn.addEventListener('click', () => {
    hidePasteUndoToast();
    if (onUndo) onUndo();
  });

  // Approve
  const approveBtn = document.createElement('button');
  approveBtn.textContent = 'Approve';
  applyBtnStyle(approveBtn);
  approveBtn.addEventListener('click', () => {
    clearPasteSnapshot();
    hidePasteUndoToast();
  });

  // Report Conversion Glitch
  const reportBtn = document.createElement('button');
  reportBtn.textContent = 'Report Conversion Glitch';
  applyBtnStyle(reportBtn);
  reportBtn.addEventListener('click', () => {
    sendGlitchReport(toast, onUndo, cs);
  });

  btnRow.appendChild(undoBtn);
  btnRow.appendChild(approveBtn);
  btnRow.appendChild(reportBtn);

  toast.appendChild(text);
  toast.appendChild(btnRow);
}

/* ── send glitch report, then show thank-you state ────────── */
async function sendGlitchReport(toast, onUndo, cs) {
  // Disable buttons while sending
  toast.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

  const { pastedContent, ...cleanSummary } = cs;

  const payload = {
    bookId: cs.bookId || 'unknown',
    conversionSummary: cleanSummary,
    recentLogs: getRecentLogs(),
    pasteLogs: getPasteLogs(),
    pastedContent: pastedContent ?? '',
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch('/api/integrity/paste-glitch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content,
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('Failed to send paste glitch report:', err);
  }

  renderThankYouState(toast, onUndo);
}

/* ── thank-you state: message + Undo / Deal with it ───────── */
function renderThankYouState(toast, onUndo) {
  toast.innerHTML = '';

  const msg = document.createElement('span');
  msg.textContent = 'Much thanks comrade! We will update the conversion process.';
  msg.style.lineHeight = '1.4';

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  // Undo
  const undoBtn = document.createElement('button');
  undoBtn.textContent = 'Undo';
  applyBtnStyle(undoBtn);
  undoBtn.addEventListener('click', () => {
    hidePasteUndoToast();
    if (onUndo) onUndo();
  });

  // Deal with it
  const dealBtn = document.createElement('button');
  dealBtn.textContent = 'Deal with it';
  applyBtnStyle(dealBtn);
  dealBtn.addEventListener('click', () => {
    clearPasteSnapshot();
    hidePasteUndoToast();
  });

  btnRow.appendChild(undoBtn);
  btnRow.appendChild(dealBtn);

  toast.appendChild(msg);
  toast.appendChild(btnRow);
}

/* ── hide / remove ────────────────────────────────────────── */
export function hidePasteUndoToast() {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.style.opacity = '0';
  setTimeout(() => toast.remove(), 200);
}
