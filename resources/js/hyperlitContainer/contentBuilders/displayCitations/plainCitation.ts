/**
 * Plain citation (bibliography "Reference" card) content builder + its post-open button resolver.
 * Renders a reference's citation text and an "Open source" button that links to the cited book,
 * locking/dimming it for private (no-access) or deleted sources (resolved post-open since an
 * external book's visibility isn't known at build time).
 */

import { book } from '../../../app';
import { openDatabase } from '../../../indexedDB/index';
import { resolveBibliographyTarget } from '../../../indexedDB/bibliography/index';
import type { BibliographyRecord } from '../../../indexedDB/types';
import { privateLockIcon, deletedTrashIcon, MUTED_BTN_STYLE, BTN_SPINNER_HTML, lockButtonEl, enableButtonEl } from '../sourceAccessButton';

/**
 * Wrap the title text inside a formatted citation with an anchor.
 * Skips if the HTML already contains an anchor (e.g. formatBibtexToCitation
 * already linked the title via the bibtex `url` field). Handles books
 * (`<i>Title</i>`), articles/chapters (`"Title"`), and bare title text.
 */
function linkTitleInCitation(html: any, title: any, href: any) {
  if (!html || !title || !href) return html;
  if (/<a\s[^>]*href=/i.test(html)) return html;

  const escapeHtml = (s: any) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapedTitle = escapeHtml(title);
  const safeHref = String(href).replace(/"/g, '&quot;');
  const wrap = (inner: any) => `<a href="${safeHref}" target="_blank" rel="noopener">${inner}</a>`;

  const italicized = `<i>${escapedTitle}</i>`;
  if (html.includes(italicized)) return html.replace(italicized, wrap(italicized));
  const quoted = `"${escapedTitle}"`;
  if (html.includes(quoted)) return html.replace(quoted, wrap(quoted));
  if (html.includes(escapedTitle)) return html.replace(escapedTitle, wrap(escapedTitle));
  return html;
}

/**
 * Build citation content section.
 * Supports both unlinked citations (just content) and linked citations (source_id with navigation).
 * @param contentType - The citation content type object
 * @param db - Reused database connection
 * @returns HTML string for citation content
 */
export async function buildCitationContent(contentType: any, db: any = null) {
  try {
    const { referenceId } = contentType;

    if (!referenceId) {
      console.error('No referenceId found in contentType:', contentType);
      return '';
    }

    const database = db || await openDatabase();
    const transaction = database.transaction(["bibliography", "library"], "readonly");
    const bibliographyStore = transaction.objectStore("bibliography");

    const lookupBook = contentType.parentBookId || book;

    // Support multiple referenceIds (range citations like [6-8])
    const ids = contentType.referenceIds || [referenceId];
    let sections = '';

    for (const refId of ids) {
      const key = [lookupBook, refId];
      const result: BibliographyRecord | null = await new Promise((resolve: any, reject: any) => {
        const request = bibliographyStore.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      if (result && result.content) {
        // Build navigation link if source_id exists and source has content to open
        // source_has_nodes: undefined/null on old records → treat as true (backward compat)
        const sourceHasNodes = result.source_has_nodes == null || !!result.source_has_nodes;

        // Canonical-only path: when the record has a canonical_source_id but no
        // source_id, ask the server for metadata (and best version, if any).
        // Note: awaiting `fetch()` inside the open IDB transaction can commit it,
        // so we must NOT touch the library store afterwards — instead we render
        // either a direct navigation link (server already filtered for visibility)
        // or a citation-only card. Both paths skip the IDB library lookup below.
        let citationCardMetadata = null;
        let canonicalResolvedBook = null;
        if (!result.source_id && result.canonical_source_id) {
          try {
            const resolved: any = await resolveBibliographyTarget(result);
            if (resolved?.type === 'library' && resolved.book) {
              canonicalResolvedBook = resolved.book;
            } else if (resolved?.type === 'citation-card') {
              citationCardMetadata = resolved.metadata;
            }
          } catch (e) {
            console.warn('displayCitations: canonical resolve failed', e);
          }
        }

        let displayContent = result.content;
        let navigationLink = '';
        let leadingIcon = ''; // lock/trash shown next to the citation text (like hypercites)
        if (canonicalResolvedBook) {
          // Server's bestVersion endpoint already enforced visibility — straight link.
          const targetUrl = `/${encodeURIComponent(canonicalResolvedBook)}`;
          navigationLink = `
            <div class="citation-navigation" style="margin-top: 1em;">
              <a href="${targetUrl}" class="citation-source-link" style="display: inline-flex; align-items: center; gap: 0.5em; padding: 0.5em 1em; background: var(--hyperlit-aqua, #4EACAE); color: var(--hyperlit-black, #221F20); text-decoration: none; border-radius: 4px;">
                Open source
                <span class="open-icon">↗</span>
              </a>
            </div>`;
        } else if (citationCardMetadata) {
          // Canonical-only citation with no library version that has nodes.
          // No "Open source" button — surface the OA / DOI URL as an anchor on
          // the title within the citation text itself.
          const oaHref = citationCardMetadata.oa_url || citationCardMetadata.pdf_url
            || (citationCardMetadata.doi ? `https://doi.org/${citationCardMetadata.doi}` : null);
          if (oaHref && citationCardMetadata.title) {
            displayContent = linkTitleInCitation(displayContent, citationCardMetadata.title, oaHref);
          }
        } else if (result.source_id && sourceHasNodes) {
          // Read the library entry from LOCAL IDB only — a cited external book's library
          // row is never synced into this user's IDB, so it's commonly absent. The real
          // visibility/access decision is deferred to resolveCitationButtonStatus() post-open
          // so we never await fetch()/canUserEditBook() inside this reused transaction
          // (awaiting there would commit it and break later refIds' reads).
          const libraryStore = transaction.objectStore('library');
          const libraryRecord: any = await new Promise((resolve: any) => {
            const request = libraryStore.get(result.source_id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
          });

          const isDeleted = libraryRecord && libraryRecord.visibility === 'deleted';
          const isPrivate = libraryRecord && libraryRecord.visibility === 'private';
          const isUnknown = !libraryRecord; // external book — visibility resolved post-open

          const targetUrl = `/${encodeURIComponent(result.source_id)}`;
          const baseStyle = 'display: inline-flex; align-items: center; gap: 0.5em; padding: 0.5em 1em; background: var(--hyperlit-aqua, #4EACAE); color: var(--hyperlit-black, #221F20); text-decoration: none; border-radius: 4px;';

          let buttonText = 'Open source';
          let buttonStyle = baseStyle;
          let buttonAttrs = '';
          let buttonSuffix = '';

          if (isDeleted) {
            // Known deleted — render locked immediately (and now actually click-blocked).
            // Trash icon goes next to the citation text (leadingIcon), not on the button.
            buttonText = 'Source deleted';
            buttonStyle += ' opacity: 0.6; cursor: not-allowed; pointer-events: none;';
            buttonAttrs = `data-deleted="true"`;
            leadingIcon = deletedTrashIcon();
          } else if (isPrivate || isUnknown) {
            // Private (known) or external (unknown visibility) — mute + spinner now;
            // resolveCitationButtonStatus() enables (public/accessible) or locks (private,
            // no access — adding the lock next to the citation text) once visibility +
            // access are resolved post-open.
            buttonStyle += MUTED_BTN_STYLE;
            buttonSuffix = BTN_SPINNER_HTML;
            buttonAttrs = `data-needs-citation-check="true" data-book-id="${result.source_id}"${isPrivate ? ' data-visibility="private"' : ''}`;
          }
          // else: known public — enabled aqua button (default).

          navigationLink = `
            <div class="citation-navigation" style="margin-top: 1em;">
              <a href="${targetUrl}" class="citation-source-link" ${buttonAttrs} style="${buttonStyle}">
                ${buttonText}${buttonSuffix}
                <span class="open-icon">↗</span>
              </a>
            </div>`;
        }

        sections += `
          <div class="citations-section" data-content-id="${refId}" data-reference-id="${refId}">
            <h3 style="margin-bottom: 0.5em;">Reference</h3>
            <blockquote style="margin: 0; padding: 0.5em 0; font-style: normal;">
              ${leadingIcon}${displayContent}
            </blockquote>
            ${navigationLink}
            <hr style="margin: 2em 0; opacity: 0.5;">
          </div>`;
      } else {
        sections += `
          <div class="citations-section" data-content-id="${refId}">
            <h3>Reference</h3>
            <div class="error">Reference not found: ${refId}</div>
            <hr style="margin: 2em 0; opacity: 0.5;">
          </div>`;
      }
    }

    return sections;
  } catch (error) {
    console.error('Error building citation content:', error);
    const referenceId = contentType?.referenceId || 'unknown';
    return `
      <div class="citations-section" data-content-id="${referenceId}">
        <h3>Reference</h3>
        <div class="error">Error loading reference</div>
        <hr style="margin: 2em 0; opacity: 0.5;">
      </div>`;
  }
}

/**
 * Place the lock/trash icon next to the citation text (mirrors the hypercite statusIcon),
 * NOT on the button. Idempotent — won't double-insert if the resolver runs twice.
 */
function insertCitationLockIcon(btn: any, iconHtml: string) {
  const section = btn?.closest?.('.citations-section');
  if (!section || section.querySelector('.private-lock-icon, .deleted-icon')) return;
  const blockquote = section.querySelector('blockquote');
  if (blockquote) blockquote.insertAdjacentHTML('afterbegin', iconHtml);
}

/**
 * Post-open resolution for plain citation "Open source" buttons.
 * Called from citationHandler.postOpen after the container is visible.
 *
 * Build-time can't know an external cited book's visibility (its library row isn't in
 * local IDB), so private + unknown sources render muted with a spinner and
 * `data-needs-citation-check`. Here we resolve the real state off the server:
 *  - deleted  → lock with trash icon ("Source deleted")
 *  - private  → canUserEditBook → enable (has access) or lock with red lock ("Source private")
 *  - public   → enable (openable by anyone)
 * Operates purely off DOM attributes, so it doesn't depend on the contentType shape.
 */
export async function resolveCitationButtonStatus(_contentType: any, _db: any, container: any = null) {
  try {
    const root = container
      || document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
    if (!root || !document.body.contains(root)) return;

    const btns = root.querySelectorAll('.citation-source-link[data-needs-citation-check="true"]');
    if (btns.length === 0) return;

    const { fetchLibraryFromServer }: any = await import('../../utils.js');
    const { canUserEditBook }: any = await import('../../../utilities/auth/index');

    for (const btn of btns) {
      const bookId = btn.getAttribute('data-book-id');
      btn.removeAttribute('data-needs-citation-check');

      let visibility = btn.getAttribute('data-visibility'); // 'private' hint, or null when unknown
      if (!visibility && bookId) {
        try {
          const record: any = await fetchLibraryFromServer(bookId);
          visibility = record?.visibility || 'public';
        } catch (e) {
          // Couldn't determine visibility — leave the button enabled rather than guess locked.
          visibility = 'public';
        }
      }

      if (visibility === 'deleted') {
        lockButtonEl(btn, 'Source deleted');
        insertCitationLockIcon(btn, deletedTrashIcon());
      } else if (visibility === 'private') {
        const hasAccess: any = bookId ? await canUserEditBook(bookId) : false;
        if (hasAccess) {
          enableButtonEl(btn);
        } else {
          lockButtonEl(btn, 'Source private');
          insertCitationLockIcon(btn, privateLockIcon());
        }
      } else {
        // Public — openable by anyone.
        enableButtonEl(btn);
      }
    }
  } catch (error) {
    console.warn('resolveCitationButtonStatus error:', error);
  }
}
