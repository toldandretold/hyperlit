// Quality feedback for auto-harvested COMMONS books. These texts were
// converted by the automatic open-access harvester with no human owner, so
// there's otherwise no one to flag a bad conversion (mismatched footnotes /
// citations / headings). Two surfaces:
//   1. a transient toast on opening a commons book (first impression), and
//   2. a persistent note in the source panel's Librarian section (in case the
//      reader dismisses the toast but later spots an issue).
// Both route a report to the maintainers via the existing conversion-feedback
// endpoint (audit.json / assessment.json attached server-side). Honest framing:
// this feeds a converter-fix + batch-reconvert loop, not an instant self-heal.
import { book } from '../../app';
import { checklistDialog, alertDialog } from '../dialog/dialog';
import { isCommonsBook } from './researchWorkflows';
import { log } from '../../utilities/logger';

const FILE = 'components/sourceContainer/commonsFeedback.ts';
const TOAST_ID = 'commons-harvest-toast';

const ISSUE_TYPES = [
  { value: 'footnotes_not_matched', label: "Footnotes aren't linked / are missing their links" },
  { value: 'footnotes_wrongly_matched', label: 'Footnotes link to the wrong place' },
  { value: 'citations_not_matched', label: "Citations aren't linked to their references" },
  { value: 'citations_wrongly_matched', label: 'Citations link to the wrong reference' },
  { value: 'headings_wrong', label: 'Headings / structure are wrong' },
];

function postHeaders(): Record<string, string> {
  const csrf = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
  return { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf };
}

/** Persistent note + report button for the Librarian section (commons books only). */
export function commonsFeedbackNoteHtml(record: any): string {
  if (!isCommonsBook(record)) return '';
  return `<p id="commons-feedback-note" style="font-size: 11px; color: var(--color-text-faint); margin: 8px 0 0; line-height: 1.5;">
      Converted automatically by the Knowledge Commons Harvester. Spot a problem — footnotes, citations, headings?
      <button type="button" id="commons-feedback-btn" style="background: none; border: none; color: var(--hyperlit-aqua, #4EACAE); text-decoration: underline; cursor: pointer; padding: 0; font-size: 11px;">Report an issue</button>
    </p>`;
}

/** Open the report checklist and POST it to the conversion-feedback endpoint. */
export async function handleCommonsFeedback(): Promise<void> {
  const result = await checklistDialog({
    title: 'Report a conversion issue',
    message: 'Thanks for helping improve the commons. This goes to the maintainers, who fix the converter and re-run it — so it may not change instantly, but it makes every future copy better.',
    items: ISSUE_TYPES,
    comment: { label: 'Anything to add? (optional)', placeholder: 'e.g. footnote 12 links to the wrong note' },
    confirmLabel: 'Send report',
  });
  if (!result) return;
  if (result.selected.length === 0 && !result.comment.trim()) return; // nothing to send

  try {
    const resp = await fetch('/api/integrity/conversion-feedback', {
      method: 'POST',
      headers: postHeaders(),
      credentials: 'include',
      body: JSON.stringify({
        bookId: book,
        rating: 'bad',
        issueTypes: result.selected,
        comment: result.comment.trim() || null,
        timestamp: new Date().toISOString(),
      }),
    });
    await alertDialog({
      title: 'Thank you',
      message: resp.ok
        ? "Report sent to the maintainers. Fixes are batched into the converter, so this text — and others like it — improve over time."
        : "Couldn't send the report just now. Please try again later.",
    });
  } catch (err: any) {
    log.error('Commons feedback failed', FILE, err);
    await alertDialog({ title: 'Report a conversion issue', message: "Couldn't send the report just now. Please try again later." });
  }
}

/** Silent positive signal ("No issue") — seeds the good-conversion record. */
function sendGoodRating(bookId: string): void {
  fetch('/api/integrity/conversion-feedback', {
    method: 'POST',
    headers: postHeaders(),
    credentials: 'include',
    body: JSON.stringify({ bookId, rating: 'good', timestamp: new Date().toISOString() }),
  }).catch(() => { /* best-effort */ });
}

export function hideCommonsHarvestToast(): void {
  const t = document.getElementById(TOAST_ID);
  if (!t) return;
  t.style.opacity = '0';
  setTimeout(() => t.remove(), 200);
}

/**
 * A transient glass toast at the top of the page, shown once when a reader opens
 * a commons book — so they know from the outset it was auto-converted. Buttons:
 * Report an issue (checklist) / No issue (positive, dismiss) / Cancel (dismiss).
 * Auto-hides; pauses on hover. Mirrors the post-conversion feedback toast.
 */
export function showCommonsHarvestToast(bookId: string): void {
  hideCommonsHarvestToast();

  const isLight = document.body.classList.contains('theme-light') || document.body.classList.contains('theme-sepia');
  const glassBg = isLight ? 'rgba(40,36,32,0.80)' : 'rgba(30,30,50,0.6)';

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  Object.assign(toast.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    background: glassBg, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
    color: '#e0e0e0', padding: '12px 18px', borderRadius: '8px', fontSize: '13px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    display: 'flex', flexDirection: 'column', gap: '10px', zIndex: '99999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)', opacity: '0', transition: 'opacity 0.2s ease',
    width: 'calc(100vw - 32px)', maxWidth: '560px',
  });

  const text = document.createElement('span');
  text.textContent = 'This text was converted automatically by the Knowledge Commons Harvester.';
  text.style.lineHeight = '1.4';

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

  const mkBtn = (label: string, primary = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      background: primary ? '#4EACAE' : 'transparent',
      color: primary ? '#221F20' : '#e0e0e0',
      border: primary ? 'none' : '1px solid rgba(224,224,224,0.4)',
      padding: '5px 14px', borderRadius: '4px', fontSize: '13px', cursor: 'pointer',
      flexShrink: '0', whiteSpace: 'nowrap', fontFamily: 'inherit',
    });
    return b;
  };

  const reportBtn = mkBtn('Report an issue', true);
  reportBtn.addEventListener('click', () => { hideCommonsHarvestToast(); handleCommonsFeedback(); });
  const noIssueBtn = mkBtn('No issue');
  noIssueBtn.addEventListener('click', () => { sendGoodRating(bookId); hideCommonsHarvestToast(); });
  const cancelBtn = mkBtn('Cancel');
  cancelBtn.addEventListener('click', () => hideCommonsHarvestToast());

  row.append(reportBtn, noIssueBtn, cancelBtn);
  toast.append(text, row);
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  // Auto-hide, but never yank it away while the reader is hovering it.
  let timer = window.setTimeout(hideCommonsHarvestToast, 14000);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => { timer = window.setTimeout(hideCommonsHarvestToast, 6000); });
}
