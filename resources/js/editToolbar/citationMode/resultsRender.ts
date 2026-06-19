/**
 * citationMode/resultsRender — pure construction of a single search-result <button>
 * (bibtex → citation display, sanitization, badges). No component state.
 */
import { formatBibtexToCitation } from "../../utilities/bibtexProcessor";
import DOMPurify from "dompurify";
import type { CitationSearchResult } from "./types";

export async function buildResultButton(result: CitationSearchResult): Promise<HTMLButtonElement> {
  let sanitized: string;

  if (result.bibtex) {
    const formattedCitation = await formatBibtexToCitation(result.bibtex);
    sanitized = DOMPurify.sanitize(formattedCitation, {
      ALLOWED_TAGS: ['i', 'em', 'b', 'strong', 'a'],
      ALLOWED_ATTR: ['href', 'target']
    });
  } else {
    // Bibtex absent (shouldn't normally happen post-PR4 since the service generates a
    // synthetic bibtex from canonical metadata) — fall back to a simple display.
    const title = result.title || 'Untitled';
    const meta = [result.author, result.year, result.journal].filter(Boolean).join(', ');
    const raw = `<em>${title}</em>${meta ? ' — ' + meta : ''}`;
    sanitized = DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: ['i', 'em', 'b', 'strong'],
    });
  }

  // Optional badge for canonical-only results so the user knows ahead of clicking
  // that there's no text in the library, just citation metadata.
  let badge = '';
  if (result.source === 'canonical-only') {
    badge = '<span class="citation-result-badge citation-result-badge-citation-only" title="Citation only — text not in library">citation only</span>';
  }

  // Private-lock badge for any result whose resolved version is one of the caller's
  // private books. Reuses the same SVG used on libraryCard.
  let privateIcon = '';
  if (result.is_private) {
    privateIcon = '<span class="citation-result-private" title="Private — only visible to you"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg></span>';
  }

  const button = document.createElement('button');
  button.className = 'citation-result-item';
  if (result.source === 'canonical-only') {
    button.classList.add('citation-result-canonical-only');
    button.title = 'Citation only — text not in library';
  } else if (result.source === 'canonical') {
    button.classList.add('citation-result-canonical');
  }
  if (result.is_private) {
    button.classList.add('citation-result-private-source');
  }
  button.innerHTML = sanitized + (badge ? ' ' + badge : '') + privateIcon;
  button.dataset.bookId = result.book || '';
  button.dataset.canonicalSourceId = result.canonical_source_id || '';
  button.dataset.bibtex = result.bibtex || '';
  button.dataset.hasNodes = result.has_nodes ? '1' : '0';
  button.dataset.source = result.source || '';
  button.dataset.isPrivate = result.is_private ? '1' : '0';

  return button;
}
