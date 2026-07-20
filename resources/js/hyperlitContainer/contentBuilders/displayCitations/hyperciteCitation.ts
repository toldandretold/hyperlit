/**
 * Inbound hypercite-citation content builder + its post-open button resolver. Renders a citation
 * that points AT someone else's hypercite ("See in source text"), with private/deleted/dead/ghost
 * states, and resolves the navigate button's access (and a surviving-ancestor link for dead books)
 * once the container is visible.
 */

import { openDatabase } from '../../../indexedDB/index';
import { formatBibtexToCitation } from "../../../utilities/bibtexProcessor";
import { getHyperciteFromIndexedDB } from '../../../indexedDB/hypercites/index';
import { fetchHyperciteRecord } from '../../../indexedDB/hypercites/helpers';
import { verbose } from '../../../utilities/logger';
import { privateLockIcon, deletedTrashIcon, MUTED_BTN_STYLE, BTN_SPINNER_HTML, enableButtonEl } from '../sourceAccessButton';

/**
 * Build an ancestor chain for a sub-book ID (innermost parent first).
 * e.g. "bookX/2/FnY/HL_abc" → ["bookX/FnY", "bookX"]
 */
function buildAncestorChain(bookId: any) {
  if (!bookId.includes('/')) return [];
  const parts = bookId.split('/');
  if (parts.length === 2) {
    return [parts[0]]; // Level 1: parent is foundation
  }
  if (parts.length === 4) {
    return [parts[0] + '/' + parts[2], parts[0]]; // Level 2: parent sub-book, then foundation
  }
  return [parts[0]]; // Fallback
}

/**
 * Walk up the ancestor chain to find the first surviving (non-deleted) book.
 */
async function findSurvivingAncestor(bookId: any) {
  const ancestors = buildAncestorChain(bookId);
  for (const ancestorId of ancestors) {
    try {
      const { fetchLibraryFromServer }: any = await import('../../utils.js');
      const record: any = await fetchLibraryFromServer(ancestorId);
      if (record && record.visibility !== 'deleted') {
        return { bookId: ancestorId, libraryData: record };
      }
    } catch (e) { /* continue to next ancestor */ }
  }
  return null;
}

/**
 * Build hypercite citation content section (for links pointing TO hypercites).
 * @param contentType - The hypercite citation content type object
 * @param db - Reused database connection
 * @returns HTML string for hypercite citation content
 */
export async function buildHyperciteCitationContent(contentType: any, db: any = null) {
  try {
    const { targetBook, targetHyperciteId, targetUrl } = contentType;
    // The record is keyed by the SUB-BOOK it lives in (`foundation/Fn…` for a
    // footnote); `targetBook` is only the foundation, which is right for the
    // bibtex/library lookup but wrong for the record existence check. Falling
    // back to targetBook keeps non-footnote citations (where they're equal) intact.
    const recordBook = contentType.targetSubBook || targetBook;

    console.log(`🔗 Building hypercite citation for: ${targetBook}#${targetHyperciteId}`);

    const database = db || await openDatabase();
    const transaction = database.transaction(['library'], 'readonly');
    const store = transaction.objectStore('library');

    const result: any = await new Promise((resolve: any, reject: any) => {
      const request = store.get(targetBook);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    let libraryData = result;
    let formattedCitation = '';

    if (result && result.bibtex) {
      formattedCitation = await formatBibtexToCitation(result.bibtex);
    } else {
      // Fallback: try to fetch from server - import fetchLibraryFromServer from utils
      const { fetchLibraryFromServer }: any = await import('../../utils.js');
      const serverLibraryData: any = await fetchLibraryFromServer(targetBook);
      libraryData = serverLibraryData; // Update libraryData with server result
      if (serverLibraryData && serverLibraryData.bibtex) {
        formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
      } else {
        // Last resort: use book ID
        formattedCitation = targetBook;
      }
    }

    // Check for ghost/dead status — IndexedDB first (instant); on a MISS fall back to a
    // single-record server fetch (scope=record) so the status is real, not undefined.
    // The old IDB-only check silently treated "not cached" as "alive", which is the
    // "container info does not always work" bug class.
    let isGhost = false;
    let isDead = false;
    let isMissing = false; // record no longer exists server-side (deleted with no tombstone)
    let ghostCitedText = '';
    let hyperciteBook = null;
    try {
      let hyperciteData: any = await getHyperciteFromIndexedDB(recordBook, targetHyperciteId);
      if (!hyperciteData) {
        const fetched = await fetchHyperciteRecord(recordBook, targetHyperciteId);
        if (fetched.status === 'ok') {
          hyperciteData = fetched.record;
        } else if (fetched.status === 'not_found') {
          isMissing = true;
        } else {
          // forbidden → the library-visibility private path below handles messaging;
          // error → proceed neutral-alive (never claim dead/ghost without data)
          verbose.content(`Hypercite status fallback: ${targetHyperciteId} → ${fetched.status}`, 'hyperlitContainer/hyperciteCitation');
        }
      }
      // Undefined relationshipStatus → treated as alive (defensive: never claim dead/ghost)
      if (hyperciteData?.relationshipStatus === 'ghost') {
        isGhost = true;
        ghostCitedText = hyperciteData.hypercitedText || '';
      } else if (hyperciteData?.relationshipStatus === 'dead') {
        isDead = true;
        hyperciteBook = hyperciteData.book || recordBook;
      }
    } catch (ghostError) {
      console.warn('Could not check ghost/dead status:', ghostError);
    }

    // Check if book is private or deleted (access check deferred to post-open)
    const isPrivate = libraryData && libraryData.visibility === 'private';
    const isDeleted = libraryData && libraryData.visibility === 'deleted';

    // Add lock icon if private, trash icon if deleted
    let statusIcon = '';
    if (isDeleted) {
      statusIcon = deletedTrashIcon();
    } else if (isPrivate) {
      statusIcon = privateLockIcon();
    }

    // Ghost status is communicated via the button text — no separate section needed

    // Build descriptive label for sub-book locations
    let locationLabel = '';
    if (contentType.isHyperlightURL && contentType.hlDepth > 0) {
      if (contentType.isFootnoteURL) {
        // HL inside a Fn: "a Hyperlight within a Footnote within:" or "a Highlight within a Highlight within a Footnote within:"
        if (contentType.hlDepth === 1) {
          locationLabel = 'a <span class="citedInHyperlight">Hyperlight</span> within a <span class="citedInFootnote">Footnote</span> within:';
        } else {
          const hlChain = Array(contentType.hlDepth).fill('a Highlight').join(' within ');
          locationLabel = `${hlChain} within a <span class="citedInFootnote">Footnote</span> within:`;
        }
      } else {
        if (contentType.hlDepth === 1) {
          locationLabel = 'a <span class="citedInHyperlight">Hyperlight</span> within:';
        } else {
          const chain = Array(contentType.hlDepth).fill('a Highlight').join(' within ');
          locationLabel = `${chain} within:`;
        }
      }
    } else if (contentType.isFootnoteURL) {
      locationLabel = 'a <span class="citedInFootnote">Footnote</span> within:';
    }

    // Configure button based on access and ghost status
    let buttonText = 'See in source text';
    let buttonStyle = 'display: inline-block; padding: 0.5em 1em; background: #4EACAE; color: #221F20; text-decoration: none; border-radius: 4px;';
    let buttonAttrs = '';
    let buttonSuffix = '';

    if (isDeleted) {
      buttonText = 'source deleted';
      buttonStyle += ' opacity: 0.6; cursor: not-allowed;';
      buttonAttrs = `data-deleted="true" data-book-id="${targetBook}"`;
    } else if (isMissing) {
      buttonText = 'Citation record missing';
      buttonStyle += ' opacity: 0.6; cursor: not-allowed;';
      buttonAttrs = `data-missing="true"`;
    } else if (isDead) {
      buttonText = 'Source text removed';
      buttonStyle += ' opacity: 0.6; cursor: not-allowed;';
      buttonAttrs = `data-dead="true"`;
    } else if (isGhost && isPrivate) {
      // Ghost in private book — need access check to decide if user can navigate
      buttonText = 'View ghost in source';
      buttonStyle += MUTED_BTN_STYLE;
      buttonAttrs = `data-private="true" data-ghost="true" data-book-id="${targetBook}" data-needs-access-check="true"`;
      buttonSuffix = BTN_SPINNER_HTML;
    } else if (isGhost) {
      buttonText = 'View ghost in source';
    } else if (isPrivate) {
      // Muted state with spinner — resolved post-open by resolveButtonStatus()
      buttonStyle += MUTED_BTN_STYLE;
      buttonAttrs = `data-private="true" data-book-id="${targetBook}" data-needs-access-check="true"`;
      buttonSuffix = BTN_SPINNER_HTML;
    }

    // Normalize the stored target URL to the CURRENT origin. Hypercite target URLs can carry a
    // stale absolute origin (an http://localhost:8000 dev URL, or an http:// value from before the
    // HTTPS migration, or a different host if the book was created/imported elsewhere). An absolute
    // href with a foreign origin makes LinkNavigationHandler.handleLinkClick treat the "See in source
    // text" click as EXTERNAL (isExternal = linkUrl.origin !== currentUrl.origin) and let the browser
    // do a full cross-origin page reload instead of the SPA BookToBookTransition. Keeping only
    // path+search+hash makes the link same-origin so it is intercepted for SPA navigation.
    const navHref = (() => {
      try {
        const u = new URL(targetUrl, window.location.origin);
        return `${u.pathname}${u.search}${u.hash}`;
      } catch {
        return targetUrl;
      }
    })();

    // Build dead banner (if applicable)
    let deadBannerHtml = '';
    let deadNavLink = '';
    if (isDead) {
      deadBannerHtml = `<div style="color: #d73a49; font-size: 13px; margin-top: 1em; padding: 8px 10px; border-radius: 4px; background: rgba(215, 58, 73, 0.08); border: 1px solid rgba(215, 58, 73, 0.25);">Source text removed — the containing book or section was deleted</div>`;

      // Ancestor link injected post-open by resolveButtonStatus()
      deadNavLink = `<div data-needs-ancestor-check="true" data-hypercite-book="${hyperciteBook}" style="margin-top: 0.5em;"></div>`;
    }

    return `
      <div class="hypercite-citation-section" data-content-id="${targetHyperciteId}">
        <h3>Reference</h3>
        <div class="citation-text">
          ${statusIcon}${locationLabel ? `<span class="location-label">${locationLabel}</span><blockquote>${formattedCitation}</blockquote>` : formattedCitation}
        </div>
        ${isGhost ? `<div style="color: #EF8D34; font-size: 13px; margin-top: 1em; padding: 8px 10px; border-radius: 4px; background: rgba(239, 141, 52, 0.08); border: 1px solid rgba(239, 141, 52, 0.25);">Cited text deleted</div>` : ''}
        ${isMissing ? `<div style="color: #d73a49; font-size: 13px; margin-top: 1em; padding: 8px 10px; border-radius: 4px; background: rgba(215, 58, 73, 0.08); border: 1px solid rgba(215, 58, 73, 0.25);">This citation record no longer exists</div>` : ''}
        ${deadBannerHtml}
        ${deadNavLink}
        <div style="margin-top: ${isGhost || isDead ? '0.5em' : '1em'};">
          <a href="${navHref}" class="see-in-source-btn" ${buttonAttrs} style="${buttonStyle}">
            ${buttonText}${buttonSuffix}
          </a>
        </div>
        <hr style="margin: 2em 0; opacity: 0.5;">
      </div>`;
  } catch (error) {
    console.error('Error building hypercite citation content:', error);
    return `
      <div class="hypercite-citation-section">
        <h3>Reference</h3>
        <div class="error">Error loading citation</div>
        <hr style="margin: 2em 0; opacity: 0.5;">
      </div>`;
  }
}

/**
 * Post-open resolution for hypercite-citation buttons.
 * Called from handlePostOpenActions after the container is visible.
 * - Resolves private book access (enables/disables button)
 * - Injects surviving ancestor link for dead books
 * @param contentType - The hypercite-citation content type
 * @param db - Optional reused database connection
 */
export async function resolveButtonStatus(contentType: any, db: any, container: any = null) {
  const { targetBook, targetHyperciteId } = contentType;

  // Prefer caller-provided container so we don't depend on `.open` having been
  // applied yet (stacked layers add it via double rAF after this runs).
  // Fall back to the legacy query for callers that don't pass one.
  const root = container
    || document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
  if (!root || !document.body.contains(root)) return;

  // The two post-open checks are INDEPENDENT — a failure in one must not strand the
  // other, and neither may leave the button stuck in the muted+spinner state.

  // Handle access check for private books (8s timeout + tap-to-retry on failure)
  try {
    const accessCheckBtn = root.querySelector('.see-in-source-btn[data-needs-access-check="true"]');
    if (accessCheckBtn) {
      const { canUserEditBook }: any = await import('../../../utilities/auth/index');
      const bookId = accessCheckBtn.getAttribute('data-book-id');
      const hasAccess: any = await Promise.race([
        canUserEditBook(bookId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('access check timed out')), 8000)),
      ]);

      accessCheckBtn.removeAttribute('data-needs-access-check');
      const spinner = accessCheckBtn.querySelector('.btn-spinner');

      if (hasAccess) {
        // Enable button — user can navigate to source
        enableButtonEl(accessCheckBtn);
      } else {
        // Update to private denied state
        accessCheckBtn.style.opacity = '0.6';
        accessCheckBtn.style.cursor = 'not-allowed';
        accessCheckBtn.style.pointerEvents = '';
        accessCheckBtn.setAttribute('data-access', 'denied');
        if (spinner) spinner.remove();
        // Update button text — ghost+private gets distinct denied text
        const isGhost = accessCheckBtn.hasAttribute('data-ghost');
        const deniedText = isGhost ? 'Ghost in private source ' : 'source text private ';
        accessCheckBtn.childNodes.forEach((node: any) => {
          if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
            node.textContent = deniedText;
          }
        });
      }
    }
  } catch (accessError) {
    // Timeout / network failure: swap the spinner for an explicit one-shot retry state
    // instead of leaving the button muted+spinning forever.
    verbose.content('Access check failed — showing retry state', 'hyperlitContainer/hyperciteCitation', accessError);
    const btn = root.querySelector('.see-in-source-btn[data-needs-access-check="true"]');
    if (btn) {
      btn.querySelector('.btn-spinner')?.remove();
      btn.setAttribute('data-access', 'error');
      btn.style.pointerEvents = '';
      btn.style.cursor = 'pointer';
      btn.childNodes.forEach((node: any) => {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          node.textContent = "couldn't verify access — tap to retry ";
        }
      });
      btn.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        btn.removeAttribute('data-access');
        btn.insertAdjacentHTML('beforeend', BTN_SPINNER_HTML);
        void resolveButtonStatus(contentType, db, root);
      }, { once: true });
    }
  }

  // Handle ancestor check for dead books (graceful degradation: banner stays, link is a bonus)
  try {
    const ancestorCheckEl = root.querySelector('[data-needs-ancestor-check="true"]');
    if (ancestorCheckEl) {
      const hyperciteBook = ancestorCheckEl.getAttribute('data-hypercite-book');
      if (hyperciteBook) {
        const ancestor: any = await findSurvivingAncestor(hyperciteBook);
        if (ancestor) {
          const ancestorTitle = ancestor.libraryData.title || ancestor.bookId;
          ancestorCheckEl.innerHTML = `<a href="/${encodeURIComponent(ancestor.bookId)}" style="color: #4EACAE; text-decoration: none; font-size: 13px;">View in containing book: ${ancestorTitle} ↗</a>`;
        }
      }
      ancestorCheckEl.removeAttribute('data-needs-ancestor-check');
    }
  } catch (ancestorError) {
    verbose.content('Ancestor check failed — leaving dead banner without link', 'hyperlitContainer/hyperciteCitation', ancestorError);
    root.querySelector('[data-needs-ancestor-check="true"]')?.removeAttribute('data-needs-ancestor-check');
  }
}
