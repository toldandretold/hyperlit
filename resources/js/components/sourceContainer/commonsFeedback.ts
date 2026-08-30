// Conversion-quality feedback ("Report an issue") — a persistent note in the
// source panel's Librarian section, on EVERY book including private ones: the
// book's own librarian is often the first to spot mismatched footnotes /
// citations / headings and wants the book on the maintainer reconvert queue.
// A report routes to the maintainers via the conversion-feedback endpoint
// (audit.json / assessment.json attached server-side); a 'bad' rating also
// raises a ConversionFlag onto the reconvert queue. Honest framing: this feeds
// a converter-fix + batch-reconvert loop, not an instant self-heal.
//
// There is deliberately NO reader-entry toast. It used to interrupt every
// opening of a commons book; on journal-import texts (human-reviewed as they
// land) it was pure noise, and anyone who reaches an auto-converted text either
// imported it themselves or found it good enough to read. The report path lives
// here in the panel, where someone who does spot a problem will look for it.
import { book } from '../../app';
import { checklistDialog, alertDialog } from '../dialog/dialog';
import { isCommonsBook } from './researchWorkflows';
import { log } from '../../utilities/logger';

const FILE = 'components/sourceContainer/commonsFeedback.ts';

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

/** Persistent note + report button for the Librarian section — every book. */
export function commonsFeedbackNoteHtml(record: any): string {
  const lead = isCommonsBook(record)
    ? 'Converted automatically by the Knowledge Commons Harvester. Spot a problem — footnotes, citations, headings?'
    : 'Spot a conversion problem — footnotes, citations, headings?';
  return `<p id="commons-feedback-note" style="font-size: var(--sc-11); color: var(--color-text-faint); margin: 8px 0 0; line-height: 1.5;">
      ${lead}
      <button type="button" id="commons-feedback-btn" style="background: none; border: none; color: var(--hyperlit-aqua, #4EACAE); text-decoration: underline; cursor: pointer; padding: 0; font-size: var(--sc-11);">Report an issue</button>
    </p>`;
}

/** Open the report checklist and POST it to the conversion-feedback endpoint. */
export async function handleCommonsFeedback(): Promise<void> {
  const result = await checklistDialog({
    title: 'Report a conversion issue',
    message: 'This goes to the maintainers, who fix the converter and re-run it — so it may not change instantly, but it makes this text and every future conversion better.',
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
