/**
 * Conversion feedback toast — shown after PDF import completes.
 * Glassmorphism toast (matches paste toast pattern), fixed top-center.
 *
 * Shows conversion stats and lets user send feedback:
 *   "Looks good" → sends report with "good" rating (seeds test fixture)
 *   "Report issue" → sends report with "bad" rating (prioritises debugging)
 *   × (cancel) → dismiss, nothing sent
 *
 * Both feedback buttons send stats + bookId so server can attach
 * ocr_response.json / debug_converted.html for reproduction.
 */

import { getRecentLogs } from '../integrity/logCapture.js';

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
    width: 'calc(100vw - 32px)',
    maxWidth: '720px',
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

  const textarea = document.createElement('textarea');
  textarea.maxLength = 2000;
  textarea.rows = 2;
  textarea.placeholder = 'Anything to add about the conversion? (optional)';
  Object.assign(textarea.style, {
    width: '100%',
    boxSizing: 'border-box',
    background: 'rgba(0,0,0,0.3)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '6px',
    padding: '6px 8px',
    fontFamily: 'inherit',
    fontSize: '13px',
    resize: 'vertical',
  });

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  // Looks good — send positive report
  const goodBtn = document.createElement('button');
  goodBtn.textContent = 'Looks good';
  applyBtnStyle(goodBtn);
  goodBtn.addEventListener('click', () => {
    sendFeedback(toast, { bookId, stats, footnoteAudit, rating: 'good', comment: textarea.value.trim() });
  });

  // Report issue — send negative report
  const badBtn = document.createElement('button');
  badBtn.textContent = 'Report issue';
  applyBtnStyle(badBtn);
  badBtn.addEventListener('click', () => {
    sendFeedback(toast, { bookId, stats, footnoteAudit, rating: 'bad', comment: textarea.value.trim() });
  });

  // Vibe convert — LLM re-conversion of THIS document. The textarea note becomes the
  // reader's own description of what's wrong, fed to the model.
  const vibeBtn = document.createElement('button');
  vibeBtn.textContent = '✨ Vibe convert';
  applyVibeBtnStyle(vibeBtn);
  vibeBtn.addEventListener('click', () => {
    startVibeConvert(toast, { bookId, note: textarea.value.trim() });
  });

  // Cancel (×) — dismiss, nothing sent
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '\u00d7';
  applyBtnStyle(cancelBtn);
  Object.assign(cancelBtn.style, { padding: '5px 10px', fontSize: '16px' });
  cancelBtn.addEventListener('click', () => {
    hideConversionFeedbackToast();
  });

  btnRow.appendChild(goodBtn);
  btnRow.appendChild(badBtn);
  btnRow.appendChild(vibeBtn);
  btnRow.appendChild(cancelBtn);

  toast.appendChild(text);
  toast.appendChild(textarea);
  toast.appendChild(btnRow);
}

/* ── send feedback (both good and bad) ────────────────────── */
async function sendFeedback(toast, { bookId, stats, footnoteAudit, rating, comment }) {
  // Disable buttons while sending
  toast.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

  const payload = {
    bookId: bookId || 'unknown',
    rating,
    conversionStats: stats,
    footnoteAudit: footnoteAudit || null,
    comment: comment || null,
    recentLogs: getRecentLogs(),
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

/* ── vibe convert: gradient button + live SSE flow ────────── */
function applyVibeBtnStyle(btn) {
  Object.assign(btn.style, {
    background: 'linear-gradient(135deg, #EE4A95, #EF8D34, #4EACAE)',
    color: '#fff', border: 'none', padding: '5px 14px', borderRadius: '4px',
    fontSize: '13px', cursor: 'pointer', flexShrink: '0', whiteSpace: 'nowrap',
  });
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.85'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
}

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content;
}

/* working state: header + live status list */
function renderVibeWorking(toast) {
  toast.innerHTML = '';
  const header = document.createElement('div');
  header.textContent = '✨ Vibe converting — this can take a minute or two';
  header.style.fontWeight = 'bold';
  const sub = document.createElement('div');
  sub.textContent = "DeepSeek reasons about why your file confused the converter, proposes a fix, "
    + 'and tests it on your document — repeating until it works or it runs out of tries.';
  Object.assign(sub.style, { fontSize: '12px', opacity: '0.7', lineHeight: '1.4' });
  const status = document.createElement('div');
  status.id = 'vibe-status';
  Object.assign(status.style, {
    display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px',
    opacity: '0.95', maxHeight: '160px', overflowY: 'auto', lineHeight: '1.4',
  });
  toast.appendChild(header);
  toast.appendChild(sub);
  toast.appendChild(status);
  return status;
}

/* stream the SSE progress from /api/vibe-convert/stream into the toast */
async function startVibeConvert(toast, { bookId, note }) {
  const status = renderVibeWorking(toast);

  // Reveal beats ONE AT A TIME with a paced fade-in, so even when events arrive bunched it
  // plays like a sequence ("something is happening") instead of dumping a block of text.
  const queue = [];
  let revealing = false;
  const MIN_GAP = 1100; // ms between lines
  const pump = () => {
    if (revealing || queue.length === 0) return;
    revealing = true;
    const text = queue.shift();
    const d = document.createElement('div');
    d.textContent = '· ' + text;
    d.style.opacity = '0';
    d.style.transition = 'opacity 0.45s ease';
    status.appendChild(d);
    status.scrollTop = status.scrollHeight;
    requestAnimationFrame(() => { d.style.opacity = '1'; });
    setTimeout(() => { revealing = false; pump(); }, MIN_GAP);
  };
  const addLine = (text) => { queue.push(text); pump(); };
  const drained = () => new Promise((res) => {
    const check = () => (queue.length === 0 && !revealing ? res() : setTimeout(check, 120));
    check();
  });

  let result = null;
  try {
    const resp = await fetch('/api/vibe-convert/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken() },
      credentials: 'include',
      body: JSON.stringify({ bookId: bookId || 'unknown', note: note || null }),
    });
    if (!resp.ok || !resp.body) {
      addLine('Could not start — ' + (resp.status === 402 ? 'insufficient balance.' : 'server error.'));
    } else {
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          let evt;
          try { evt = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (evt.message) addLine(evt.message);
          if (['success', 'exhausted', 'error'].includes(evt.phase)) result = evt;
        }
      }
    }
  } catch (e) {
    addLine('Vibe conversion failed to run.');
  }

  await drained();  // let the last beats finish playing before showing the outcome

  if (result && result.phase === 'success') {
    renderVibeResult(toast, {
      bookId, before: result.before, after: result.after,
      tier: result.tier || 'clean', caveat: result.caveat || '',
    });
  } else {
    renderVibeEnd(toast, (result && result.message) || 'Could not improve it this time.');
  }
}

/* success state: before/after + accept/reject. tier 'clean' = confident; 'improved' = better
   but with a caveat for the user to judge. Accepting is non-destructive — the original is
   archived to version history, revertible anytime. */
function renderVibeResult(toast, { bookId, before, after, tier, caveat }) {
  toast.innerHTML = '';
  const msg = document.createElement('div');
  const heading = tier === 'improved'
    ? '✨ <b>Improved — but worth a look</b>'
    : '✨ <b>Fixed this conversion</b>';
  const caveatHtml = (tier === 'improved' && caveat)
    ? '<br><span style="color:#fbbf24">⚠ ' + caveat + '</span>' : '';
  msg.innerHTML = heading
    + '<br><span style="opacity:0.8">before: ' + (before || '') + '<br>after: ' + (after || '') + '</span>'
    + caveatHtml
    + '<br><span style="opacity:0.6;font-size:12px">Applying keeps your original in version '
    + 'history — you can revert anytime.</span>';
  msg.style.lineHeight = '1.5';

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  const useBtn = document.createElement('button');
  useBtn.textContent = 'Use this conversion';
  applyVibeBtnStyle(useBtn);
  useBtn.addEventListener('click', async () => {
    useBtn.disabled = true;
    useBtn.textContent = 'Applying…';
    try {
      const r = await fetch('/api/vibe-convert/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken() },
        credentials: 'include',
        body: JSON.stringify({ bookId }),
      });
      if (r.ok) {
        renderVibeEnd(toast, 'Applied! Reloading…');
        setTimeout(() => location.reload(), 800);
      } else {
        renderVibeEnd(toast, 'Could not apply the conversion.');
      }
    } catch {
      renderVibeEnd(toast, 'Could not apply the conversion.');
    }
  });

  const keepBtn = document.createElement('button');
  keepBtn.textContent = 'Keep original';
  applyBtnStyle(keepBtn);
  keepBtn.addEventListener('click', () => hideConversionFeedbackToast());

  row.appendChild(useBtn);
  row.appendChild(keepBtn);
  toast.appendChild(msg);
  toast.appendChild(row);
}

/* terminal message + dismiss */
function renderVibeEnd(toast, text) {
  toast.innerHTML = '';
  const msg = document.createElement('span');
  msg.textContent = text;
  msg.style.lineHeight = '1.4';
  const dismiss = document.createElement('button');
  dismiss.textContent = 'Dismiss';
  applyBtnStyle(dismiss);
  dismiss.addEventListener('click', () => hideConversionFeedbackToast());
  toast.appendChild(msg);
  toast.appendChild(dismiss);
}

/* ── hide / remove ────────────────────────────────────────── */
export function hideConversionFeedbackToast() {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.style.opacity = '0';
  setTimeout(() => toast.remove(), 200);
}
