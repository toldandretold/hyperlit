/**
 * Conversion feedback toast — shown after PDF import completes.
 * Glassmorphism toast (matches paste toast pattern), fixed top-center.
 *
 * Shows conversion stats and lets user send feedback:
 *   "Looks good" → sends report with "good" rating (seeds test fixture)
 *   "Report issue" → reveals a structured issue picker (category chips + free-text), THEN offers
 *                    "Send report" (rides in the conversion-report email) or "Try vibe fix"
 *                    (the per-document LLM re-conversion). The vibe button only appears here.
 *   × (cancel) → dismiss, nothing sent
 *
 * Both feedback buttons send stats + bookId so server can attach
 * ocr_response.json / debug_converted.html for reproduction. The structured categories route to the
 * responsible pipeline stage in the vibe loop (see vibe_convert.py _ISSUE_CATEGORY_MODULES).
 */

import { getRecentLogs } from '../integrity/logCapture.js';

const TOAST_ID = 'conversion-feedback-toast';

/* Structured issue categories — KEEP IN SYNC with the PHP enum (VibeConvertController /
   IntegrityReportController) and the Python keys (vibe_convert.py _ISSUE_CATEGORY_MODULES). */
const CATEGORIES = [
  { key: 'citations_not_matched',     label: 'Citations not matched' },
  { key: 'citations_wrongly_matched', label: 'Citations wrongly matched' },
  { key: 'footnotes_not_matched',     label: 'Footnotes not matched' },
  { key: 'footnotes_wrongly_matched', label: 'Footnotes wrongly matched' },
  { key: 'headings_wrong',            label: 'Headings wrong / bad hierarchy' },
];

/* shared button style */
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

/* build summary text from conversion stats (+ the footnote audit, for the linked ratio) */
function buildSummaryText(stats, footnoteAudit) {
  // Mirror the real source type (the converter writes file_type into conversion_stats); fall back to a
  // neutral word so a missing field never mislabels (it used to hard-code "PDF" even for EPUBs).
  const kind = stats?.file_type || 'Document';
  if (!stats) return `${kind} imported.`;

  const parts = [];

  const refs = stats.references_found ?? 0;
  const linked = stats.citations_linked ?? 0;
  const total = stats.citations_total ?? 0;
  const fn = stats.footnotes_matched ?? 0;

  // Be explicit about WHICH thing each count is — "references" was ambiguous (bibliography entries vs
  // footnote markers). refs = entries found in the bibliography; total/linked = in-text (Author Year) citations.
  if (refs > 0) parts.push(`${refs} references found in the bibliography`);
  if (total > 0) parts.push(`${linked}/${total} in-text citations linked`);
  // Footnotes: show how many are actually LINKED, like citations — `footnotes_matched` is just the count of
  // definitions found (a misnomer), so the linked count comes from the audit (defs that have an in-text [^1]).
  if (footnoteAudit && footnoteAudit.total_defs > 0) {
    const defs = footnoteAudit.total_defs;
    const linkedFn = defs - (footnoteAudit.unmatched_defs?.length ?? 0);   // defs with an in-text [^1]
    parts.push(`${linkedFn}/${defs} footnotes linked`);
  } else if (fn > 0) {
    parts.push(`${fn} footnote definitions found`);
  }

  if (parts.length === 0) return `${kind} imported (no bibliography, citations or footnotes detected).`;
  return `${kind} imported: ${parts.join('; ')}.`;
}

/* main export */
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

/* initial state: summary + [Looks good] [Report issue] [×] (no vibe button yet) */
function renderInitialState(toast, { bookId, stats, footnoteAudit }) {
  toast.innerHTML = '';

  const text = document.createElement('span');
  text.textContent = buildSummaryText(stats, footnoteAudit);
  text.style.lineHeight = '1.4';

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  // Looks good — positive report (no note/categories needed)
  const goodBtn = document.createElement('button');
  goodBtn.textContent = 'Looks good';
  applyBtnStyle(goodBtn);
  goodBtn.addEventListener('click', () => {
    sendFeedback(toast, { bookId, stats, footnoteAudit, rating: 'good' });
  });

  // Report issue — reveal the structured picker (chips + free-text + the vibe option)
  const badBtn = document.createElement('button');
  badBtn.textContent = 'Report issue';
  applyBtnStyle(badBtn);
  badBtn.addEventListener('click', () => {
    renderReportState(toast, { bookId, stats, footnoteAudit });
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '×';
  applyBtnStyle(cancelBtn);
  Object.assign(cancelBtn.style, { padding: '5px 10px', fontSize: '16px' });
  cancelBtn.addEventListener('click', () => hideConversionFeedbackToast());

  btnRow.appendChild(goodBtn);
  btnRow.appendChild(badBtn);
  btnRow.appendChild(cancelBtn);

  toast.appendChild(text);
  toast.appendChild(btnRow);
}

/* a toggle "chip" for one issue category (tracks selection in `selected`) */
function makeChip({ key, label }, selected) {
  const chip = document.createElement('button');
  chip.textContent = label;
  chip.dataset.key = key;
  const base = {
    background: 'rgba(255,255,255,0.08)', color: '#e0e0e0',
    border: '1px solid rgba(255,255,255,0.2)', padding: '4px 10px', borderRadius: '14px',
    fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
  };
  const on = { background: '#4EACAE', color: '#fff', border: '1px solid #4EACAE' };
  Object.assign(chip.style, base);
  chip.addEventListener('click', () => {
    if (selected.has(key)) { selected.delete(key); Object.assign(chip.style, base); }
    else { selected.add(key); Object.assign(chip.style, on); }
  });
  return chip;
}

/* report state: summary + category chips + free-text + [Send report] [Try vibe fix] [×] */
/* The issue picker (chips) + free-text note — shared by the initial report state AND the post-apply
   "give feedback & re-try" panel. Returns the elements + a reader for the selected categories. */
function buildIssueControls(selected, { promptText, placeholder } = {}) {
  const prompt = document.createElement('div');
  prompt.textContent = promptText || 'What went wrong? (optional — pick any that apply, it helps the fix)';
  Object.assign(prompt.style, { fontSize: '12px', opacity: '0.75' });

  const chipRow = document.createElement('div');
  Object.assign(chipRow.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
  CATEGORIES.forEach((c) => chipRow.appendChild(makeChip(c, selected)));

  const textarea = document.createElement('textarea');
  textarea.maxLength = 2000;
  textarea.rows = 2;
  textarea.placeholder = placeholder || 'Anything to add? (optional — fed to the fixer)';
  Object.assign(textarea.style, {
    width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', color: '#fff',
    border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '6px 8px',
    fontFamily: 'inherit', fontSize: '13px', resize: 'vertical',
  });
  return { prompt, chipRow, textarea };
}

function renderReportState(toast, { bookId, stats, footnoteAudit }) {
  toast.innerHTML = '';
  const selected = new Set();

  const text = document.createElement('span');
  text.textContent = buildSummaryText(stats, footnoteAudit);
  text.style.lineHeight = '1.4';

  const { prompt, chipRow, textarea } = buildIssueControls(selected);

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  // Send report — rides in the conversion-report email we already send (no LLM run)
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send report';
  applyBtnStyle(sendBtn);
  sendBtn.addEventListener('click', () => {
    sendFeedback(toast, { bookId, stats, footnoteAudit, rating: 'bad',
                          comment: textarea.value.trim(), issueTypes: [...selected] });
  });

  // Try vibe fix — the per-document LLM re-conversion, with the structured signals + note
  const vibeBtn = document.createElement('button');
  vibeBtn.textContent = '✨ Try vibe fix';
  applyVibeBtnStyle(vibeBtn);
  vibeBtn.addEventListener('click', () => {
    startVibeConvert(toast, { bookId, note: textarea.value.trim(), issueTypes: [...selected] });
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '×';
  applyBtnStyle(cancelBtn);
  Object.assign(cancelBtn.style, { padding: '5px 10px', fontSize: '16px' });
  cancelBtn.addEventListener('click', () => hideConversionFeedbackToast());

  btnRow.appendChild(sendBtn);
  btnRow.appendChild(vibeBtn);
  btnRow.appendChild(cancelBtn);

  toast.appendChild(text);
  toast.appendChild(prompt);
  toast.appendChild(chipRow);
  toast.appendChild(textarea);
  toast.appendChild(btnRow);
}

/* send feedback (good rating, or bad rating with optional categories + comment) */
async function sendFeedback(toast, { bookId, stats, footnoteAudit, rating, comment, issueTypes }) {
  // Disable buttons while sending
  toast.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

  const payload = {
    bookId: bookId || 'unknown',
    rating,
    conversionStats: stats,
    footnoteAudit: footnoteAudit || null,
    comment: comment || null,
    issueTypes: (issueTypes && issueTypes.length) ? issueTypes : null,
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

/* thank-you state */
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

/* vibe convert: gradient button + live SSE flow */
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

/* working state: header + live status list + (Use this one) / Cancel / Email-me-when-done.
   The "Use this one" button is hidden until an attempt improves the document (revealed by the poll loop
   when an `improved_partial` beat arrives) — clicking it stops the loop early and applies the best so far. */
function renderVibeWorking(toast, { onCancel, onEmailMe, onUseNow }) {
  toast.innerHTML = '';
  const header = document.createElement('div');
  header.textContent = '✨ Vibe converting — this can take a minute or two';
  header.style.fontWeight = 'bold';
  const sub = document.createElement('div');
  sub.textContent = 'The fixer reasons about why your file confused the converter, proposes a fix, '
    + 'and tests it on your document — repeating until it works or it runs out of tries.';
  Object.assign(sub.style, { fontSize: '12px', opacity: '0.7', lineHeight: '1.4' });
  const status = document.createElement('div');
  status.id = 'vibe-status';
  Object.assign(status.style, {
    display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px',
    opacity: '0.95', maxHeight: '160px', overflowY: 'auto', lineHeight: '1.4',
  });
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
  // Revealed once an attempt improves the doc — apply the best so far instead of waiting for all tries.
  const useNowBtn = document.createElement('button');
  useNowBtn.id = 'vibe-use-now-btn';
  useNowBtn.textContent = 'Use this one ✓';
  useNowBtn.title = 'Apply the best improvement found so far (re-validated in a sandbox) instead of waiting '
    + 'for the remaining attempts.';
  applyVibeBtnStyle(useNowBtn);
  useNowBtn.style.display = 'none';
  useNowBtn.addEventListener('click', () => {
    useNowBtn.disabled = true;
    useNowBtn.textContent = 'Applying…';
    onUseNow && onUseNow();
  });
  const emailBtn = document.createElement('button');
  emailBtn.textContent = 'Email me when done';
  applyBtnStyle(emailBtn);
  emailBtn.addEventListener('click', onEmailMe);
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  applyBtnStyle(cancelBtn);
  cancelBtn.addEventListener('click', onCancel);
  row.appendChild(useNowBtn);
  row.appendChild(emailBtn);
  row.appendChild(cancelBtn);

  toast.appendChild(header);
  toast.appendChild(sub);
  toast.appendChild(status);
  toast.appendChild(row);
  return status;
}

/* Run as a BACKGROUND job: POST start, then poll progress (so the user can close the toast or
   ask to be emailed). Beats reveal one-at-a-time with a paced fade-in. */
async function startVibeConvert(toast, { bookId, note, issueTypes }) {
  const book = bookId || 'unknown';
  let stopped = false;

  // POST /start first; only show the working state once the job is queued.
  let startResp;
  try {
    startResp = await fetch('/api/vibe-convert/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken() },
      credentials: 'include',
      body: JSON.stringify({
        bookId: book,
        note: note || null,
        issueTypes: (issueTypes && issueTypes.length) ? issueTypes : null,
      }),
    });
  } catch { startResp = null; }
  if (!startResp || !startResp.ok) {
    renderVibeEnd(toast, !startResp ? 'Could not start vibe conversion.'
      : (startResp.status === 402 ? 'Insufficient balance.' : 'Could not start vibe conversion.'));
    return;
  }

  const post = (url) => fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { 'X-CSRF-TOKEN': csrfToken() },
  }).catch(() => {});

  const status = renderVibeWorking(toast, {
    onCancel: () => { addLine('Cancelling…'); post(`/api/vibe-convert/cancel/${encodeURIComponent(book)}`); },
    onUseNow: () => {
      addLine('Using this one — applying the best fix so far (re-validating first)…');
      post(`/api/vibe-convert/use-now/${encodeURIComponent(book)}`);
      // keep polling: the loop will stop at the next boundary, apply, and emit `success` → the
      // existing done → waitForApply → reload path takes over.
    },
    onEmailMe: () => {
      stopped = true;
      post(`/api/vibe-convert/notify/${encodeURIComponent(book)}`);
      renderVibeEnd(toast, "Got it — we'll email you when it's done. You can close this.");
    },
  });

  // Paced one-at-a-time reveal (so it plays like a sequence, not a block dump).
  const queue = [];
  let revealing = false;
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
    setTimeout(() => { revealing = false; pump(); }, 1100);
  };
  const addLine = (text) => { queue.push(text); pump(); };
  const drained = () => new Promise((res) => {
    const check = () => (queue.length === 0 && !revealing ? res() : setTimeout(check, 120));
    check();
  });

  // Poll the job's progress file until a terminal beat.
  let shown = 0;
  let result = null;
  while (!stopped) {
    await new Promise((r) => setTimeout(r, 1500));
    if (stopped) break;
    let data;
    try {
      const r = await fetch(`/api/vibe-convert/progress/${encodeURIComponent(book)}`, { credentials: 'include' });
      data = await r.json();
    } catch { continue; }
    const beats = data.beats || [];
    for (; shown < beats.length; shown++) {
      const b = beats[shown];
      if (b.message) addLine(b.message);
      // An attempt improved the doc → offer "Use this one" so the reader needn't wait for the rest.
      if (b.phase === 'improved_partial') {
        const btn = document.getElementById('vibe-use-now-btn');
        if (btn && !btn.disabled) btn.style.display = '';
      }
    }
    if (data.done) { result = data.last; result._report = data.result; break; }
  }
  if (stopped) return;

  await drained();
  if (result && result.phase === 'success') {
    // The loop FOUND a fix — but `phase:'success'` fires the instant the Python loop ends, BEFORE the
    // job's VibePatchApplier::apply() re-converts + saves to the DB + bumps the library timestamp (a
    // seconds-to-minutes step). Reloading now would race that: the server timestamp is still the OLD
    // value, isLocalCacheFresh() sees the cache as fresh, and the reader shows STALE nodes/footnotes
    // (the "nothing changed until a hard refresh" bug). So WAIT for apply() to land before reloading.
    // The job writes vibe_review.json at the very END of apply(), so its appearance is the "DB updated,
    // timestamp bumped" signal — then a normal reload's checkAndUpdateIfNeeded → fetchInitialChunk
    // re-syncs nodes + footnotes + bibliography automatically. (start() cleared any prior marker.)
    renderVibeEnd(toast, 'Fixed it — applying to your book…');
    const applied = await waitForApply(book, 120000);
    if (applied === 'apply_failed') {
      renderVibeEnd(toast, 'A vibe fix was found but could not be applied to your book.');
      return;
    }
    renderVibeEnd(toast, 'Applied — reloading to show you the new conversion…');
    setTimeout(() => location.reload(), 600);
  } else {
    renderVibeEnd(toast, (result && result.message) || 'Could not improve it this time.');
  }
}

/* Poll the review marker until the job's apply() has landed (DB saved + library timestamp bumped).
   Returns 'pending' (applied OK), 'apply_failed', or 'timeout' (fall back to a reload anyway so a
   missed signal can't hang the toast). */
async function waitForApply(book, capMs) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await fetch(`/api/vibe-convert/review/${encodeURIComponent(book)}`, { credentials: 'include' });
      if (r.ok) {
        const data = await r.json();
        if (data && data.status && data.status !== 'none') return data.status; // 'pending' | 'apply_failed'
      }
    } catch { /* keep polling */ }
  }
  return 'timeout';
}

/* ── Post-auto-apply review: Keep the new conversion, or Revert to the original ──────────────────
   Shown on book load whenever the job left a pending vibe_review.json (so it survives navigation). */
export async function checkPendingVibeReview(bookId) {
  if (!bookId) return;
  let data;
  try {
    const r = await fetch(`/api/vibe-convert/review/${encodeURIComponent(bookId)}`, { credentials: 'include' });
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }
  if (!data || data.status === 'none') return;

  hideConversionFeedbackToast();
  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  const isLight = document.body.classList.contains('theme-light') || document.body.classList.contains('theme-sepia');
  Object.assign(toast.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    background: isLight ? 'rgba(40, 36, 32, 0.75)' : 'rgba(30, 30, 50, 0.55)',
    backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: '#e0e0e0',
    padding: '12px 18px', borderRadius: '8px', fontSize: '14px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', display: 'flex',
    flexDirection: 'column', gap: '10px', zIndex: '99999', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    opacity: '0', transition: 'opacity 0.2s ease', width: 'calc(100vw - 32px)', maxWidth: '720px',
  });
  document.body.appendChild(toast);
  if (data.status === 'apply_failed') {
    renderVibeEnd(toast, 'A vibe fix was found but could not be applied. ' + (data.message || ''));
  } else {
    renderVibeReviewToast(toast, { bookId, tier: data.tier, before: data.before, after: data.after, caveat: data.caveat });
  }
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
}

/* The applied-conversion review toast: Keep this / Revert to original. */
function renderVibeReviewToast(toast, { bookId, tier, before, after, caveat }) {
  toast.innerHTML = '';
  const msg = document.createElement('div');
  const heading = tier === 'improved'
    ? '✨ <b>Re-converted this — but worth a look</b>'
    : '✨ <b>Re-converted this with a fix</b>';
  const caveatHtml = (tier === 'improved' && caveat)
    ? '<br><span style="color:#fbbf24">⚠ ' + caveat + '</span>' : '';
  msg.innerHTML = heading
    + (before || after ? '<br><span style="opacity:0.8">before: ' + (before || '') + '<br>after: ' + (after || '') + '</span>' : '')
    + caveatHtml
    + '<br><span style="opacity:0.6;font-size:12px">This was applied to your book. Revert restores the '
    + 'original (kept in version history).</span>';
  msg.style.lineHeight = '1.5';

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  const keepBtn = document.createElement('button');
  keepBtn.textContent = 'Keep this';
  applyVibeBtnStyle(keepBtn);
  keepBtn.addEventListener('click', async () => {
    keepBtn.disabled = true;
    try {
      await fetch(`/api/vibe-convert/review/${encodeURIComponent(bookId)}/keep`, {
        method: 'POST', credentials: 'include', headers: { 'X-CSRF-TOKEN': csrfToken() },
      });
    } catch {}
    hideConversionFeedbackToast();
  });

  const revertBtn = document.createElement('button');
  revertBtn.textContent = 'Revert to original';
  applyBtnStyle(revertBtn);
  revertBtn.addEventListener('click', async () => {
    revertBtn.disabled = true;
    revertBtn.textContent = 'Reverting…';
    try {
      const r = await fetch(`/api/vibe-convert/review/${encodeURIComponent(bookId)}/reject`, {
        method: 'POST', credentials: 'include', headers: { 'X-CSRF-TOKEN': csrfToken() },
      });
      if (r.ok) {
        renderVibeEnd(toast, 'Reverted to the original — reloading…');
        setTimeout(() => location.reload(), 800);
      } else {
        renderVibeEnd(toast, 'Could not revert.');
      }
    } catch {
      renderVibeEnd(toast, 'Could not revert.');
    }
  });

  // Give feedback & re-try — iterate the loop ON the applied version with the reader's critique.
  const feedbackBtn = document.createElement('button');
  feedbackBtn.textContent = 'Give feedback & re-try';
  applyBtnStyle(feedbackBtn);
  feedbackBtn.addEventListener('click', () => {
    renderFeedbackRetryPanel(toast, { bookId, review: { tier, before, after, caveat } });
  });

  row.appendChild(keepBtn);
  row.appendChild(feedbackBtn);
  row.appendChild(revertBtn);
  toast.appendChild(msg);
  toast.appendChild(row);
}

/* "Give feedback & re-try": refine the APPLIED conversion. The reader picks what's still wrong + types a
   note; re-running starts a fresh loop whose baseline is the already-applied version (the artifacts on disk
   are now the applied ones), and the note carries the critique (e.g. "better, but citations link wrong").
   "Revert to original" still restores the very first pre-vibe conversion (the backend pins that origin). */
function renderFeedbackRetryPanel(toast, { bookId, review }) {
  toast.innerHTML = '';
  const selected = new Set();
  const header = document.createElement('div');
  header.innerHTML = '✨ <b>Refine this conversion</b>';
  header.style.lineHeight = '1.5';

  const { prompt, chipRow, textarea } = buildIssueControls(selected, {
    promptText: "What's still off? (pick any that apply — it focuses the next attempt)",
    placeholder: 'e.g. "better, but some citations link to the wrong entry"',
  });

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  const goBtn = document.createElement('button');
  goBtn.textContent = '✨ Re-try with this feedback';
  applyVibeBtnStyle(goBtn);
  goBtn.addEventListener('click', () => {
    startVibeConvert(toast, { bookId, note: textarea.value.trim(), issueTypes: [...selected] });
  });

  const backBtn = document.createElement('button');
  backBtn.textContent = '← Back';
  applyBtnStyle(backBtn);
  backBtn.addEventListener('click', () => renderVibeReviewToast(toast, { bookId, ...review }));

  btnRow.appendChild(goBtn);
  btnRow.appendChild(backBtn);
  toast.appendChild(header);
  toast.appendChild(prompt);
  toast.appendChild(chipRow);
  toast.appendChild(textarea);
  toast.appendChild(btnRow);
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

/* hide / remove */
export function hideConversionFeedbackToast() {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.style.opacity = '0';
  setTimeout(() => toast.remove(), 200);
}
