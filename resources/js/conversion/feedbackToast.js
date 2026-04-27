/**
 * Conversion feedback toast — shown after PDF import completes.
 * Glassmorphism toast (matches paste toast pattern), fixed top-center.
 *
 * Shows conversion stats and lets user flag issues:
 *   "Looks good" → dismiss (no data sent)
 *   "Report issue" → sends stats-only email (no document content)
 *   × (dismiss) → no data sent
 */

const TOAST_ID = 'conversion-feedback-toast';

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

/* ── build summary text from conversion stats ─────────────── */
function buildSummaryText(stats) {
  if (!stats) return 'PDF imported.';

  const parts = [];

  const refs = stats.references_found ?? 0;
  const linked = stats.citations_linked ?? 0;
  const total = stats.citations_total ?? 0;
  const fn = stats.footnotes_matched ?? 0;

  if (refs > 0) parts.push(`${refs} references`);
  if (total > 0) parts.push(`${linked}/${total} citations linked`);
  if (fn > 0) parts.push(`${fn} footnotes`);

  if (parts.length === 0) return 'PDF imported (no references detected).';
  return `PDF imported: ${parts.join(', ')}.`;
}

/* ── main export ──────────────────────────────────────────── */
export function showConversionFeedbackToast({ bookId, stats, footnoteAudit }) {
  // Remove previous toast if any
  hideConversionFeedbackToast();

  // Don't show if no stats available
  if (!stats) return;

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

  renderInitialState(toast, { bookId, stats, footnoteAudit });

  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
}

/* ── initial state: summary + 3 buttons ───────────────────── */
function renderInitialState(toast, { bookId, stats, footnoteAudit }) {
  toast.innerHTML = '';

  const text = document.createElement('span');
  text.textContent = buildSummaryText(stats);
  text.style.lineHeight = '1.4';

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  // Looks good — just dismiss, no data sent
  const goodBtn = document.createElement('button');
  goodBtn.textContent = 'Looks good';
  applyBtnStyle(goodBtn);
  goodBtn.addEventListener('click', () => {
    hideConversionFeedbackToast();
  });

  // Report issue — sends stats only (no document content)
  const badBtn = document.createElement('button');
  badBtn.textContent = 'Report issue';
  applyBtnStyle(badBtn);
  badBtn.addEventListener('click', () => {
    sendIssueReport(toast, { bookId, stats, footnoteAudit });
  });

  // Dismiss (×)
  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = '\u00d7';
  applyBtnStyle(dismissBtn);
  Object.assign(dismissBtn.style, { padding: '5px 10px', fontSize: '16px' });
  dismissBtn.addEventListener('click', () => {
    hideConversionFeedbackToast();
  });

  btnRow.appendChild(goodBtn);
  btnRow.appendChild(badBtn);
  btnRow.appendChild(dismissBtn);

  toast.appendChild(text);
  toast.appendChild(btnRow);
}

/* ── send issue report (stats only, no document content) ──── */
async function sendIssueReport(toast, { bookId, stats, footnoteAudit }) {
  // Disable buttons while sending
  toast.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

  const payload = {
    bookId: bookId || 'unknown',
    rating: 'bad',
    conversionStats: stats,
    footnoteAudit: footnoteAudit || null,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch('/api/integrity/conversion-feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content,
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('Failed to send conversion feedback:', err);
  }

  renderThankYouState(toast);
}

/* ── thank-you state ──────────────────────────────────────── */
function renderThankYouState(toast) {
  toast.innerHTML = '';

  const msg = document.createElement('span');
  msg.textContent = 'Thanks! Report sent.';
  msg.style.lineHeight = '1.4';

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  applyBtnStyle(dismissBtn);
  dismissBtn.addEventListener('click', () => {
    hideConversionFeedbackToast();
  });

  toast.appendChild(msg);
  toast.appendChild(dismissBtn);

  // Auto-dismiss after 3 seconds
  setTimeout(() => hideConversionFeedbackToast(), 3000);
}

/* ── hide / remove ────────────────────────────────────────── */
export function hideConversionFeedbackToast() {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.style.opacity = '0';
  setTimeout(() => toast.remove(), 200);
}
