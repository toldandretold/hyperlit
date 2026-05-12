/**
 * Import-failure bug-report modal — shown when /import-file fails or
 * the background import job throws during polling.
 *
 * Lets the user attach a comment and (optionally) re-upload the failed
 * file, then POSTs to /api/integrity/import-failure. Server emails the
 * report + attachment + console-logs + Laravel-log grep to maintainers.
 */

import { getRecentLogs } from '../integrity/logCapture.js';

const MODAL_ID = 'import-failure-modal';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB cap matches server-side max

/* ── shared button style (mirrors feedbackToast.js) ───────── */
function applyBtnStyle(btn, variant = 'default') {
  const palette = {
    primary: { bg: '#2c8a8c', hover: '#37a4a6' },
    danger:  { bg: '#7a3a3a', hover: '#9a4a4a' },
    default: { bg: '#555', hover: '#4EACAE' },
  }[variant] || { bg: '#555', hover: '#4EACAE' };

  Object.assign(btn.style, {
    background: palette.bg,
    color: '#fff',
    border: 'none',
    padding: '6px 16px',
    borderRadius: '4px',
    fontSize: '13px',
    cursor: 'pointer',
    flexShrink: '0',
    whiteSpace: 'nowrap',
  });
  btn.addEventListener('mouseenter', () => { btn.style.background = palette.hover; });
  btn.addEventListener('mouseleave', () => { btn.style.background = palette.bg; });
}

/* ── format file size for display ─────────────────────────── */
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

/* ── main export ──────────────────────────────────────────── */
export function showImportFailureModal({ status, errorMessage, bookId, originalFile, source }) {
  return new Promise((resolve) => {
    hideImportFailureModal();

    const isLightTheme = document.body.classList.contains('theme-light')
                      || document.body.classList.contains('theme-sepia');
    const overlayBg = isLightTheme ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.65)';
    const cardBg    = isLightTheme ? 'rgba(40,36,32,0.92)' : 'rgba(30,30,50,0.92)';

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: overlayBg,
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      zIndex: '99999',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: '0',
      transition: 'opacity 0.2s ease',
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      background: cardBg,
      color: '#e0e0e0',
      padding: '20px 22px',
      borderRadius: '10px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      fontSize: '14px',
      width: 'min(560px, calc(100vw - 32px))',
      maxHeight: 'calc(100vh - 64px)',
      overflowY: 'auto',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    });

    renderBody(card, { status, errorMessage, bookId, originalFile, source }, resolve);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });
  });
}

/* ── modal body ───────────────────────────────────────────── */
function renderBody(card, { status, errorMessage, bookId, originalFile, source }, resolve) {
  card.innerHTML = '';

  // Header
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
  });
  const title = document.createElement('strong');
  title.style.fontSize = '15px';
  title.style.color = '#ef4444';
  title.textContent = source === 'poll_failure' ? 'Import processing failed' : 'Import failed';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  applyBtnStyle(closeBtn);
  Object.assign(closeBtn.style, { padding: '4px 10px', fontSize: '16px' });
  closeBtn.addEventListener('click', () => { hideImportFailureModal(); resolve(null); });
  header.appendChild(title);
  header.appendChild(closeBtn);

  // Error block (read-only)
  const errBox = document.createElement('pre');
  Object.assign(errBox.style, {
    background: 'rgba(0,0,0,0.35)',
    color: '#f3a3a3',
    padding: '10px 12px',
    borderRadius: '6px',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    margin: '0',
    maxHeight: '160px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  });
  const statusLine = status ? `[${status}] ` : '';
  errBox.textContent = `${statusLine}${errorMessage || 'Unknown error'}`;

  // Comment textarea (always visible)
  const label = document.createElement('label');
  label.textContent = 'What happened? (optional, but helpful)';
  Object.assign(label.style, { fontSize: '13px', color: '#bbb' });
  const textarea = document.createElement('textarea');
  textarea.maxLength = 2000;
  textarea.rows = 4;
  textarea.placeholder = 'e.g. tried to upload a 200-page PDF and got an error after a couple of minutes…';
  Object.assign(textarea.style, {
    width: '100%',
    boxSizing: 'border-box',
    background: 'rgba(0,0,0,0.3)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '6px',
    padding: '8px 10px',
    fontFamily: 'inherit',
    fontSize: '13px',
    resize: 'vertical',
  });

  // File checkbox (only when we have a client-side file)
  let fileCheckbox = null;
  let fileNote = null;
  let fileTooLarge = false;
  if (originalFile instanceof File) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });

    fileCheckbox = document.createElement('input');
    fileCheckbox.type = 'checkbox';
    fileCheckbox.id = 'import-failure-include-file';

    const cbLabel = document.createElement('label');
    cbLabel.htmlFor = 'import-failure-include-file';
    cbLabel.style.fontSize = '13px';
    cbLabel.style.color = '#ccc';

    if (originalFile.size <= MAX_UPLOAD_BYTES) {
      fileCheckbox.checked = true;
      cbLabel.textContent = `Include the file I tried to upload (${originalFile.name}, ${formatBytes(originalFile.size)})`;
    } else {
      fileTooLarge = true;
      fileCheckbox.checked = false;
      fileCheckbox.disabled = true;
      cbLabel.textContent = `File too large to attach (${formatBytes(originalFile.size)} > 25 MB)`;
      cbLabel.style.color = '#f59e0b';
      fileNote = document.createElement('div');
      fileNote.textContent = 'Without the file, maintainers cannot reproduce the failure. Try a smaller test document or dismiss.';
      Object.assign(fileNote.style, { fontSize: '11px', color: '#f59e0b', marginTop: '2px' });
    }

    wrap.appendChild(fileCheckbox);
    wrap.appendChild(cbLabel);
    card.appendChild(header);
    card.appendChild(errBox);
    card.appendChild(label);
    card.appendChild(textarea);
    card.appendChild(wrap);
    if (fileNote) card.appendChild(fileNote);
  } else {
    card.appendChild(header);
    card.appendChild(errBox);
    card.appendChild(label);
    card.appendChild(textarea);
  }

  // Privacy notice
  const privacy = document.createElement('div');
  privacy.textContent = 'Your comment and the file (if included) will be emailed to the Hyperlit maintainers to debug this issue.';
  Object.assign(privacy.style, { fontSize: '11px', color: '#888', lineHeight: '1.4' });
  card.appendChild(privacy);

  // Status line for inline feedback (retry messages etc.)
  const statusEl = document.createElement('div');
  Object.assign(statusEl.style, { fontSize: '12px', color: '#f59e0b', minHeight: '16px' });
  card.appendChild(statusEl);

  // Buttons
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' });

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Just dismiss';
  applyBtnStyle(dismissBtn);
  dismissBtn.addEventListener('click', () => { hideImportFailureModal(); resolve(null); });

  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send report';
  applyBtnStyle(sendBtn, 'primary');
  if (fileTooLarge) {
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.4';
    sendBtn.style.cursor = 'not-allowed';
    sendBtn.title = 'Cannot send a report without the file. Try a smaller test document.';
  }
  sendBtn.addEventListener('click', async () => {
    if (sendBtn.disabled) return;
    const comment = textarea.value.trim();
    const includeFile = !!(fileCheckbox && fileCheckbox.checked && originalFile instanceof File);

    sendBtn.disabled = true;
    dismissBtn.disabled = true;
    sendBtn.style.opacity = '0.5';
    dismissBtn.style.opacity = '0.5';
    statusEl.textContent = 'Sending…';
    statusEl.style.color = '#bbb';

    const result = await sendReport({
      bookId,
      errorMessage,
      status,
      source,
      comment,
      file: includeFile ? originalFile : null,
    });

    if (result.ok) {
      renderThankYouState(card, resolve);
    } else {
      sendBtn.disabled = false;
      dismissBtn.disabled = false;
      sendBtn.style.opacity = '1';
      dismissBtn.style.opacity = '1';
      statusEl.textContent = result.message || 'Couldn’t send — try again?';
      statusEl.style.color = '#ef4444';
    }
  });

  btnRow.appendChild(dismissBtn);
  btnRow.appendChild(sendBtn);
  card.appendChild(btnRow);
}

/* ── POST helper ──────────────────────────────────────────── */
async function sendReport({ bookId, errorMessage, status, source, comment, file }) {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  const timestamp = new Date().toISOString();
  const recentLogs = getRecentLogs();

  let body;
  const headers = { 'X-CSRF-TOKEN': csrf, 'Accept': 'application/json' };

  if (file) {
    const fd = new FormData();
    if (bookId) fd.append('bookId', bookId);
    if (errorMessage) fd.append('errorMessage', errorMessage);
    if (status != null) fd.append('status', String(status));
    if (source) fd.append('source', source);
    if (comment) fd.append('comment', comment);
    if (recentLogs && recentLogs.length) {
      recentLogs.forEach((log, i) => {
        if (log.level != null) fd.append(`recentLogs[${i}][level]`, String(log.level));
        if (log.ts != null)    fd.append(`recentLogs[${i}][ts]`, String(log.ts));
        if (log.msg != null)   fd.append(`recentLogs[${i}][msg]`, String(log.msg));
      });
    }
    fd.append('userAgent', navigator.userAgent);
    fd.append('timestamp', timestamp);
    fd.append('original', file, file.name);
    body = fd;
    // Don't set Content-Type — let fetch set the multipart boundary.
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      bookId: bookId || null,
      errorMessage: errorMessage || null,
      status: status != null ? String(status) : null,
      source: source || null,
      comment: comment || null,
      recentLogs,
      userAgent: navigator.userAgent,
      timestamp,
    });
  }

  try {
    const res = await fetch('/api/integrity/import-failure', {
      method: 'POST',
      credentials: 'include',
      headers,
      body,
    });
    if (res.status === 429) {
      return { ok: false, message: 'Throttled — try again in a minute.' };
    }
    if (!res.ok) {
      return { ok: false, message: `Server returned ${res.status}.` };
    }
    return { ok: true };
  } catch (err) {
    console.warn('Failed to send import-failure report:', err);
    return { ok: false, message: 'Network error — try again?' };
  }
}

/* ── thank-you state ──────────────────────────────────────── */
function renderThankYouState(card, resolve) {
  card.innerHTML = '';

  const msg = document.createElement('div');
  msg.textContent = 'Thanks — report sent to the maintainers.';
  Object.assign(msg.style, { fontSize: '14px', color: '#22c55e', lineHeight: '1.4' });

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  applyBtnStyle(dismissBtn);
  Object.assign(dismissBtn.style, { alignSelf: 'flex-end' });
  dismissBtn.addEventListener('click', () => { hideImportFailureModal(); resolve('sent'); });

  card.appendChild(msg);
  card.appendChild(dismissBtn);

  setTimeout(() => { hideImportFailureModal(); resolve('sent'); }, 3500);
}

/* ── hide / remove ────────────────────────────────────────── */
export function hideImportFailureModal() {
  const overlay = document.getElementById(MODAL_ID);
  if (!overlay) return;
  overlay.style.opacity = '0';
  setTimeout(() => overlay.remove(), 200);
}
