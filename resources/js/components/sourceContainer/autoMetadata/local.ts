// The FREE tier of auto-metadata: recover a book's title/author/year from
// signals already in the browser — the first heading in its nodes, the signed-in
// username, a copyright line in the opening text. No network, no cost, and it
// works for E2EE books precisely because nothing leaves the client.
//
// Pure module: no DOM writes, no fetch, no sibling imports. Everything here is
// unit-testable by calling it with a record and an array of nodes.
import { nodePlainText } from '../../../utilities/nodeText';
import {
  headingIsPlausibleTitle,
  isPlaceholderTitle,
  titleIsUsable,
  titleRejectionReason,
  truncateToWords,
} from '../../../utilities/titleQuality';
import type { LibraryRecord, NodeRecord } from '../../../indexedDB/types';
import type { AiMetadata, FieldProposal, MetadataProposal } from './types';

// The title predicates live in utilities/titleQuality so the typing-time title
// sync (indexedDB/core/library.ts) applies the SAME bar — they used to disagree,
// which is how a half-typed heading got locked in as a book's title.
export { headingIsPlausibleTitle, titleIsUsable, truncateToWords };

/** Nodes scanned for a heading. The server's own extractFirstHeading scans 50. */
const MAX_SCAN_NODES = 30;
/** Plain-text chars scanned for a copyright year. */
const YEAR_SCAN_CHARS = 2000;

/**
 * Read a heading element's words. Footnote sups and hypercite arrows are
 * apparatus, not title — strip them before reading, then normalise through the
 * shared nodePlainText so the result is comparable with everything else.
 */
function headingText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('sup, .footnote-marker, .hypercite, a[data-hypercite]').forEach((n) => n.remove());
  return nodePlainText(clone.innerHTML);
}

export interface HeadingCandidate {
  text: string;
  level: 1 | 2;
}

export interface HeadingScan {
  /** The heading we would use, if any. */
  accepted: HeadingCandidate | null;
  /**
   * The first heading we SAW but turned down, and why. Without this the card
   * could only say "No heading found", which is flatly untrue when the document
   * opens with `# mmmm` — the heading is right there, it just isn't a title.
   */
  rejected: { text: string; reason: string } | null;
}

/**
 * Scan the book's opening for a usable title: the first plausible h1, falling
 * back to the first plausible h2. Deliberately NO h3 fallback — the server
 * allows one for imports, but an h3 is overwhelmingly a sub-sub heading and
 * would feed junk straight into the canonical matcher.
 *
 * `node.content` is untrusted stored HTML, so it is parsed with DOMParser
 * (inert: no script execution, no <img onerror>, no resource loads) and never
 * assigned to a detached div's innerHTML.
 */
export function scanHeadings(nodes: NodeRecord[]): HeadingScan {
  let h2Fallback: HeadingCandidate | null = null;
  let rejected: HeadingScan['rejected'] = null;

  const consider = (el: Element | null, level: 1 | 2): HeadingCandidate | null => {
    if (!el) return null;
    const text = headingText(el);
    if (headingIsPlausibleTitle(text)) return { text, level };
    // Remember the FIRST thing we turned down, so we can explain ourselves.
    if (!rejected && text.trim()) {
      rejected = { text: text.trim(), reason: titleRejectionReason(text) ?? 'it is not usable as a title' };
    }
    return null;
  };

  for (const node of (nodes || []).slice(0, MAX_SCAN_NODES)) {
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(node?.content || '', 'text/html');
    } catch {
      continue;
    }

    const h1 = consider(doc.body.querySelector('h1'), 1);
    if (h1) return { accepted: h1, rejected };

    if (!h2Fallback) h2Fallback = consider(doc.body.querySelector('h2'), 2);
  }

  return { accepted: h2Fallback, rejected };
}

/** The heading to use as a title, or null. */
export function headingCandidate(nodes: NodeRecord[]): HeadingCandidate | null {
  return scanHeadings(nodes).accepted;
}

/**
 * A publication year stated in the opening text. Only explicit copyright-style
 * assertions count — a bare date inside prose (a diary entry, a quoted letter)
 * is not a publication year, so the bare-year form must sit alone on its line.
 */
export function copyrightYear(plainOpening: string): string | null {
  const text = (plainOpening || '').slice(0, YEAR_SCAN_CHARS);
  const patterns = [
    /©\s*(1[5-9]\d{2}|20\d{2})/,
    /\bcopyright\s+(?:©\s*)?(1[5-9]\d{2}|20\d{2})/i,
    /\(c\)\s*(1[5-9]\d{2}|20\d{2})/i,
    /^\s*(1[5-9]\d{2}|20\d{2})\s*$/m,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Is this author value still a placeholder rather than something a human chose? */
export function authorIsDefault(record: LibraryRecord): boolean {
  const author = String(record.author ?? '').trim();
  if (author === '') return true;
  if (author.toLowerCase() === 'anon') return true;
  if (author.toLowerCase() === 'anonymous') return true;
  if (author === (record.creator ?? '')) return true;
  if (author === ((record as any).creator_token ?? '')) return true;
  // A raw creator token that leaked into the author column.
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(author)) return true;
  return false;
}

function row(
  field: FieldProposal['field'],
  current: unknown,
  suggested: string,
  confidence: FieldProposal['confidence'],
  provenance: string,
  /**
   * Ticked by default? True when we are FILLING a blank/placeholder; false when
   * we would be REPLACING something that looks deliberate — then it is offered
   * but the user has to reach for it.
   */
  checked: boolean = true,
): FieldProposal | null {
  const cur = String(current ?? '').trim();
  const next = (suggested || '').trim();
  if (next === '' || next === cur) return null;
  return { field, current: cur, suggested: next, confidence, provenance, checked };
}

/** Plain text of the book's opening, used for the year scan and the AI payload. */
export function openingPlainText(nodes: NodeRecord[], nodeLimit: number, charLimit: number): string {
  return (nodes || [])
    .slice(0, nodeLimit)
    .map((n) => nodePlainText(n?.content || ''))
    .filter(Boolean)
    .join('\n\n')
    .slice(0, charLimit);
}

/**
 * The free pass. Proposes ONLY changed fields, and only where the current value
 * is still a default — a value the user typed is never contradicted.
 */
export function proposeLocalMetadata(
  record: LibraryRecord,
  nodes: NodeRecord[],
  username: string | null,
): MetadataProposal {
  const fields: FieldProposal[] = [];
  const notes: string[] = [];

  // ── Title ──────────────────────────────────────────────────────────────────
  // Gated on the CURRENT title being unusable, which is both "don't overwrite
  // what you typed" and a guarantee the wand only moves a record forward.
  // Offer the document's own heading whenever it differs from the stored title.
  // NOT gated on titleIsUsable — that is the server's LOOKUP bar, and using it
  // here refused to let a book be called "Aura" or "1984" and told people their
  // own short heading was "too short". This is a proposal the user confirms, so
  // offering is safe; a title that already looks deliberate is simply offered
  // unticked rather than withheld.
  const { accepted, rejected } = scanHeadings(nodes);
  if (accepted) {
    const proposal = row(
      'title',
      record.title,
      truncateToWords(accepted.text),
      accepted.level === 1 ? 'high' : 'medium',
      accepted.level === 1 ? 'first heading' : 'second-level heading',
      isPlaceholderTitle(record.title),
    );
    if (proposal) fields.push(proposal);
    else notes.push('Your title already matches the heading in the text.');
  } else if (rejected) {
    // Say what we found and why we turned it down. "No heading found" is a lie
    // when the document plainly opens with one.
    notes.push(`The heading “${rejected.text}” can’t be used as a title — ${rejected.reason}.`);
  } else {
    notes.push(
      nodes?.length
        ? 'No heading found near the start of this text to use as a title.'
        : 'This book has no text yet, so there was nothing to read.',
    );
  }

  // ── Author ─────────────────────────────────────────────────────────────────
  // Only when the viewer IS the creator; we never put someone else's name on a
  // card. Note this rarely fires — createNewBook already sets author = username.
  if (username && record.creator === username && authorIsDefault(record)) {
    const proposal = row('author', record.author, username, 'medium', 'your account');
    if (proposal) fields.push(proposal);
  }

  // ── Year ───────────────────────────────────────────────────────────────────
  // A copyright line in the text beats the creation year that createNewBook
  // stamps — without this a pasted 1972 essay keeps rendering "(2026)".
  const stated = copyrightYear(openingPlainText(nodes, MAX_SCAN_NODES, YEAR_SCAN_CHARS));
  if (stated) {
    const proposal = row('year', record.year, stated, 'low', 'copyright line');
    if (proposal) fields.push(proposal);
  } else if (!String(record.year ?? '').trim()) {
    const proposal = row('year', record.year, String(new Date().getFullYear()), 'low', 'created this year');
    if (proposal) fields.push(proposal);
  }

  if (!fields.length && !notes.length) {
    notes.push('Nothing to suggest — your details already look complete.');
  }

  return { tier: 'local', fields, notes };
}

/**
 * Turn the AI tier's answer into a proposal, applying the SAME guards as the
 * local tier so there is one set of rules about what may be written.
 */
export function proposeFromAi(
  record: LibraryRecord,
  ai: AiMetadata,
  username: string | null,
): MetadataProposal {
  const fields: FieldProposal[] = [];
  const notes: string[] = [];
  const provenance = 'read from the text';
  const confidence = ai.confidence === 'high' ? 'high' : ai.confidence === 'low' ? 'low' : 'medium';

  if (ai.title && headingIsPlausibleTitle(ai.title)) {
    const proposal = row(
      'title',
      record.title,
      truncateToWords(ai.title),
      confidence,
      provenance,
      isPlaceholderTitle(record.title),
    );
    if (proposal) fields.push(proposal);
  }

  // self_authored means "these are somebody's own notes and no author is named"
  // — fall back to the account username rather than letting the model guess one.
  if (authorIsDefault(record)) {
    if (ai.author && !ai.self_authored) {
      const proposal = row('author', record.author, ai.author, confidence, provenance);
      if (proposal) fields.push(proposal);
    } else if (username && record.creator === username) {
      const proposal = row('author', record.author, username, 'medium', 'your account');
      if (proposal) fields.push(proposal);
    }
  }

  if (ai.year && Number.isFinite(ai.year)) {
    const proposal = row('year', record.year, String(ai.year), confidence, provenance);
    if (proposal) fields.push(proposal);
  }

  if (ai.journal) {
    const proposal = row('journal', record.journal, ai.journal, confidence, provenance);
    if (proposal) fields.push(proposal);
  }
  if (ai.publisher) {
    const proposal = row('publisher', record.publisher, ai.publisher, confidence, provenance);
    if (proposal) fields.push(proposal);
  }

  // generateBibtexFromForm filters keys BY TYPE, and `misc` drops journal and
  // publisher entirely — so a journal that arrives without a matching type
  // would be silently absent from the bibtex the citation line renders from.
  const wantsType = ai.journal ? 'article' : ai.publisher && (record.type || 'misc') === 'misc' ? 'book' : ai.type;
  if (wantsType && ['article', 'book', 'incollection', 'phdthesis', 'misc'].includes(wantsType)) {
    const proposal = row('type', record.type, wantsType, confidence, provenance);
    if (proposal) fields.push(proposal);
  }

  if (!fields.length) {
    notes.push("The AI read the text but found nothing to change.");
  }

  return { tier: 'ai', fields, notes };
}
