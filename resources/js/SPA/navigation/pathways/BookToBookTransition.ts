/**
 * BookToBookTransition - PATHWAY 4
 * Handles navigation between books while already in reader mode
 * Only replaces content, preserves navigation elements and uses specialized progress handling
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';
import { waitForNavigationTarget, waitForElementReady, waitForElementReadyWithProgress, waitForMultipleElementsReadyWithProgress, waitForLayoutStabilization, waitForContentReady } from '../../domReadiness';
import { cleanupReaderView } from '../../viewManager';
import { resetEditModeState, enforceEditableState } from '../../../components/editButton/index';
import { destroyUserContainer } from '../../../components/userButton/userButton';
import { setCurrentBook, setCurrentBookSlug, bookSlug as _bookSlug } from '../../../app';
import { updateDatabaseBookId } from '../../../indexedDB/index';
import { setSkipScrollRestoration } from '../../../utilities/operationState';
import { universalPageInitializer } from '../../viewManager';
import { initializeLogoNav } from '../../../components/logoNav/logoNav';
import { pendingFirstChunkLoadedPromise, currentLazyLoader, buildChainFromUrl, openContainerChain } from '../../../pageLoad/index';
// hypercites is a reader-only lazy chunk; wrap as lazy importers so this pathway doesn't statically
// pull hypercites into the eager bundle (called during reader navigation; chunk warmed at reader-init).
const navigateToHyperciteTarget = (...a: any[]) => import('../../../hypercites/index').then((m) => (m.navigateToHyperciteTarget as any)(...a));
const navigateToFootnoteTarget = (...a: any[]) => import('../../../hypercites/navigation').then((m) => (m.navigateToFootnoteTarget as any)(...a));
import { navigateToInternalId, resetUserScrollState } from '../../../scrolling/index';

export class BookToBookTransition {
  static isTransitioning = false;
  static currentTransitionPromise: any = null;
  static abortController: any = null;
  /**
   * Execute book-to-book transition
   */
  static async execute(options: any = {}) {
    // Concurrency model: a new back/forward SUPERSEDES any in-flight transition immediately. We abort
    // the previous one's AbortController; the previous transition then BAILS at its next await boundary
    // (the `myController.signal.aborted` checks in the body). This avoids BOTH (a) the old "wait up to
    // 8s for the previous transition to finish" stall when a prior nav zombied (never resolved), AND
    // (b) two transitions running to completion concurrently and racing the shared reader DOM (which
    // hung the app). Per-transition identity (`myController`) means our finally only releases the lock
    // if a NEWER transition hasn't already taken over. NEVER reintroduce a blocking
    // `await currentTransitionPromise` here, and NEVER drop the abort checks below — together they are
    // what make superseding safe (cancel-and-replace, not run-both).
    if (this.abortController) {
      try { this.abortController.abort(); } catch (e) { /* ignore */ }
    }
    const myController = new AbortController();
    this.abortController = myController;
    this.isTransitioning = true;
    const {
      fromBook,
      toBook,
      hash = '',
      hyperlightId = null,
      hyperciteId = null,
      footnoteId = null,
      targetUrl = null,
      isPopstate = false,
      progressCallback
    } = options;

    // URL will be updated at the end after all initialization is complete
    console.log('📖 BookToBookTransition: Starting book-to-book transition', {
      fromBook, toBook, hash, hyperlightId, hyperciteId, footnoteId
    });

    // Create the transition promise for concurrent handling
    this.currentTransitionPromise = (async () => {
      // If a newer back/forward has superseded us (aborted our controller), STOP here. We return
      // cleanly (never throw — the catch below hard-navigates) so the superseding transition, which
      // re-renders the reader from scratch, is the only one mutating the DOM from this point on.
      const supersededBail = (): boolean => {
        if (myController.signal.aborted) {
          console.log(`⏭️ BookToBookTransition: superseded by a newer nav — bailing cleanly (toBook=${toBook})`);
          return true;
        }
        return false;
      };
      try {
        // ALWAYS create and show progress immediately, before any async operations
        const progress = progressCallback || this.createDeterministicProgressCallback(toBook);
        
        // Guarantee immediate visibility
        ProgressOverlayConductor.showBookToBookTransition(5, `Loading ${toBook}...`, toBook);
        
        // Save scroll position before destroying the old reader
        if (currentLazyLoader?.forceSaveScrollPosition) {
          currentLazyLoader.forceSaveScrollPosition();
        }
        resetUserScrollState(); // Clear stale scroll state from old book

        // Clean up current reader state (but preserve navigation)
        await this.cleanupCurrentReader();
        if (supersededBail()) return;

        progress(20, 'Fetching book content...');

        // Compute the nav target BEFORE the fetch so we can forward it as ?target= — that lets the
        // server prerender the TARGET chunk (not the lowest), which the client then adopts (no flash).
        // For multi-level cascades the footnote marker is the parent-book node to target.
        const isMultiLevelCascade = footnoteId && (hyperlightId || hyperciteId);
        const navigationTarget = isMultiLevelCascade
          ? footnoteId
          : (hash?.substring(1) || hyperlightId || hyperciteId || footnoteId || null);

        // 🚀 Real-SPA fast path: a back/forward nav to a book that's already in IndexedDB and NOT
        // stale needs NO server page fetch. Content always renders from IndexedDB anyway (the server
        // HTML only supplied the book-agnostic shell + an instant-paint chunk), so we reuse the in-DOM
        // shell and render from cache — mirroring what the SW already does offline. A hash/hypercite/
        // hyperlight/footnote target IS supported client-only: reuseShell → render from IDB →
        // handleHashNavigation → navigateToInternalId loads the target chunk from IDB (no prerender
        // needed). Without this, pressing back to a hypercite did a full server page fetch
        // ("📥 Fetching reader HTML") — the slow "nothing happens then it fetches" lag, and serialized
        // transitions then timed out on rapid presses. Gated to popstate (browser already restored the
        // URL+slug) and EXCLUDES multi-level cascades (footnote+hypercite nested-container chains),
        // which still need the server-prerendered target chunk to rebuild the chain deterministically.
        let resolvedBookId: any;
        const clientOnly = isPopstate && !isMultiLevelCascade && await this.isBookFreshInIndexedDB(toBook);
        if (clientOnly) {
          console.log(`⚡ BookToBookTransition: ${toBook} is fresh in IndexedDB — client-only nav, NO server fetch`);
          progress(40, 'Loading from your device...');
          resolvedBookId = this.reuseShellForClientOnly(toBook);
        } else {
          // Fetch the target book's HTML (with the deep-link target so the prerender is the right chunk)
          const readerHtml = await this.fetchReaderPageHtml(toBook, navigationTarget);

          progress(40, 'Updating content...');

          // Replace only the page content (not the entire body)
          await this.replacePageContent(readerHtml, toBook);

          // Resolve real book ID from DOM — toBook may be a slug but the server
          // renders <main id="realBookId">, so read the truth from the new DOM.
          resolvedBookId = document.querySelector('.main-content')?.id || toBook;
        }
        if (supersededBail()) return;

        progress(50, 'Waiting for DOM stabilization...');

        // Wait for DOM to be ready for content insertion
        await waitForLayoutStabilization();
        if (supersededBail()) return;

        progress(60, 'Initializing reader...');

        // (navigationTarget computed above, before the fetch.)
        (window as any)._pendingChunkTarget = navigationTarget;

        // When hash (hypercite) takes priority but a hyperlight/footnote also exists,
        // set it as fallback so the backend can load the right chunk if the hypercite is stale
        if (!isMultiLevelCascade && hash && (hyperlightId || footnoteId)) {
          (window as any)._pendingChunkFallbackTarget = hyperlightId || footnoteId;
        }

        // Initialize the new reader view
        // Pass hash navigation flag to prevent scroll position interference
        const hasHashNavigation = !!(hash || hyperlightId || hyperciteId || footnoteId);
        await this.initializeReader(resolvedBookId, progress, hasHashNavigation);
        if (supersededBail()) return;

        progress(75, 'Ensuring content readiness...');

        // Wait for content to be fully ready after initialization
        await waitForContentReady(resolvedBookId, {
          maxWaitTime: 10000,
          requireLazyLoader: true
        });
        if (supersededBail()) return;

        progress(78, 'Loading initial content...');

        // When hash navigation is pending, skip loading chunk 0 —
        // handleHashNavigation will load the correct chunk directly via
        // resolveTargetChunkId → loadChunk. Loading chunk 0 first is wasted
        // work since _navigateToInternalId clears the container anyway.
        // Exception: multi-level cascades need at least one chunk in the DOM
        // because the chain system uses waitForElement(), not _navigateToInternalId.
        if (!hasHashNavigation || isMultiLevelCascade) {
          await this.ensureInitialContentLoaded(resolvedBookId);
        }

        progress(80, 'Finalizing navigation...');

        // Update URL early to keep browser history in sync
        // On popstate (back/forward), use replaceState to preserve forward history
        this.updateUrlWithStatePreservation(resolvedBookId, hash, isPopstate);

        // Handle any hash-based navigation (hyperlights, hypercites, footnotes, etc.)
        const hashNavHandled = await this.handleHashNavigation(hash, hyperlightId, hyperciteId, footnoteId, resolvedBookId, progress, targetUrl);
        if (supersededBail()) return;

        // Wait for any container restoration triggered by initializeLazyLoader
        // (happens on back-nav when the restored entry has a matching containerStack)
        const { pendingContainerRestorePromise } = await import('../../../pageLoad/index');
        if (pendingContainerRestorePromise) {
          await pendingContainerRestorePromise;
        }

        progress(100, 'Complete!');

        console.log('✅ BookToBookTransition: Book-to-book transition complete');
        // NOTE: NavigationManager will hide the overlay when this returns

      } catch (error) {
        console.error('❌ BookToBookTransition: Transition failed:', error);

        // Fallback to full page navigation
        const fallbackUrl = `/${toBook}${hash}`;
        console.log('🔄 BookToBookTransition: Falling back to full page navigation:', fallbackUrl);
        window.location.href = fallbackUrl;

        throw error;
      }
    })();
    
    try {
      return await this.currentTransitionPromise;
    } finally {
      // Only release the lock if a NEWER transition hasn't superseded us — otherwise we'd null out
      // the in-flight transition's state and let a third nav wrongly think nothing is running.
      if (this.abortController === myController) {
        this.isTransitioning = false;
        this.currentTransitionPromise = null;
        this.abortController = null;
      }
    }
  }

  /**
   * Clean up current reader state while preserving navigation
   */
  static async cleanupCurrentReader() {
    console.log('🧹 BookToBookTransition: Cleaning up current reader (preserving navigation)');

    try {
      // Import and call the existing cleanup function from viewManager
      cleanupReaderView();

      // Explicitly reset all edit mode state flags as a safeguard
      resetEditModeState();

      // 🧹 CRITICAL: Destroy user container to prevent stale button references
      if (typeof destroyUserContainer === 'function') {
        destroyUserContainer();
        console.log('✅ BookToBookTransition: User container destroyed');
      }

      // The original cleanup for overlays is still useful here
      this.cleanupNavigationOverlays();

    } catch (error) {
      console.warn('Some cleanup steps failed, continuing:', error);
    }
  }

  /**
   * Clean up accumulated navigation overlays
   */
  static cleanupNavigationOverlays() {
    console.log('🧹 BookToBookTransition: Cleaning up accumulated navigation overlays');
    
    // Remove all navigation overlay elements (except the main one we'll reuse)
    const overlays = document.querySelectorAll('.navigation-overlay');
    let removedCount = 0;
    
    overlays.forEach(overlay => {
      // Keep the main initial-navigation-overlay for reuse, remove any duplicates
      if (overlay.id !== 'initial-navigation-overlay') {
        overlay.remove();
        removedCount++;
        console.log('🧹 BookToBookTransition: Removed duplicate navigation overlay');
      }
    });
    
    if (removedCount > 0) {
      console.log(`🧹 BookToBookTransition: Cleaned up ${removedCount} duplicate navigation overlays`);
    }
  }

  /**
   * Fetch the reader page HTML for target book
   */
  static async fetchReaderPageHtml(bookId: any, target: string | null = null) {
    console.log(`📥 BookToBookTransition: Fetching reader HTML for ${bookId}${target ? ` (target=${target})` : ''}`);

    // Forward the deep-link target as a query param (the browser strips a URL #hash, but a fetch
    // we build can carry it) so TextController::show prerenders the TARGET chunk, not the lowest.
    const url = target ? `/${bookId}?target=${encodeURIComponent(target)}` : `/${bookId}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch reader page HTML: ${response.status}`);
    }
    
    const htmlString = await response.text();
    console.log(`✅ BookToBookTransition: Fetched HTML (${htmlString.length} characters)`);

    return htmlString;
  }

  /**
   * True only when the book is already in IndexedDB AND not stale vs the server — the gate for the
   * client-only (no server fetch) nav path. Uses the SAME cheap library-record comparison the
   * post-init timestamp check makes (loadHyperText), NOT a heavy page fetch: getLibraryRecordFromServer
   * hits the ~1-2KB `/api/.../library` endpoint. Any uncertainty (not cached, server unreachable,
   * error) → false, so we fall back to the normal server-fetch path (which the SW also covers offline).
   */
  static async isBookFreshInIndexedDB(bookId: any): Promise<boolean> {
    try {
      const { getNodesFromIndexedDB } = await import('../../../indexedDB/index');
      const nodes = await getNodesFromIndexedDB(bookId);
      if (!nodes || !nodes.length) return false; // not cached → must fetch the shell

      const { getLibraryRecordFromServer, getLibraryObjectFromIndexedDB } =
        await import('../../../indexedDB/core/library');
      const [serverRec, localRec] = await Promise.all([
        getLibraryRecordFromServer(bookId).catch(() => null),
        getLibraryObjectFromIndexedDB(bookId).catch(() => null),
      ]);
      // Can't confirm freshness (offline / server error / no local row) → take the normal path.
      if (!serverRec || !localRec) return false;

      const fresh =
        ((serverRec as any).timestamp || 0) <= ((localRec as any).timestamp || 0) &&
        ((serverRec as any).annotations_updated_at || 0) <= ((localRec as any).annotations_updated_at || 0);
      return fresh;
    } catch (e) {
      console.warn('BookToBookTransition: freshness check failed, using server path:', e);
      return false;
    }
  }

  /**
   * Client-only nav: reuse the reader shell ALREADY in the DOM instead of fetching+swapping it.
   * Repoints the existing `<main>` to the new book (mirrors the SW's offline `<main id>` patch),
   * clears the previous book's chunks, and resets the per-nav globals. Content is then rendered
   * from IndexedDB by the shared initializeReader → universalPageInitializer path (identical to the
   * fetch path), and theme/vibe CSS is re-applied by viewManager on SPA nav. Returns the book id.
   */
  static reuseShellForClientOnly(bookId: any): string {
    const main = document.querySelector('.main-content') as HTMLElement | null;
    if (!main) throw new Error('client-only nav: no existing reader shell to reuse');

    // On popstate the browser already restored the URL, so its first path segment is the slug.
    // A two-segment sub-book (e.g. `book_X/AIreview`) has NO vanity slug — the server renders
    // data-slug="" for it — so stamping the first path segment (`book_X`) here would leave a
    // TRUNCATED slug that later mis-writes URLs and defeats the popstate cross-book guard.
    const urlSlug = String(bookId).includes('/')
      ? ''
      : (window.location.pathname.split('/').filter(Boolean)[0] || bookId);
    main.id = bookId;
    main.setAttribute('data-slug', urlSlug);
    main.contentEditable = 'false';
    main.innerHTML = ''; // drop the previous book's chunks + sentinels
    setCurrentBookSlug(urlSlug);

    // Conservative globals for a plain in-app book nav (no time-machine, no deep-link cascade).
    (window as any).autoOpenChain = null;
    (window as any).realBook = null;
    (window as any).timeMachineTimestamp = null;

    try { enforceEditableState(); } catch (e) { console.warn('enforceEditableState failed:', e); }
    return bookId;
  }

  /**
   * Replace only the page content, preserving navigation elements
   */
  static async replacePageContent(htmlString: any, bookId: any) {
    console.log('🔄 BookToBookTransition: Replacing page content (preserving navigation)');
    
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');
    
    // Try to replace just the #page-wrapper content if it exists
    const currentPageWrapper = document.getElementById('page-wrapper');
    const newPageWrapper = newDoc.getElementById('page-wrapper');
    
    if (currentPageWrapper && newPageWrapper) {
      console.log('🎯 BookToBookTransition: Replacing #page-wrapper content');
      currentPageWrapper.innerHTML = newPageWrapper.innerHTML;
    } else {
      // Fallback: replace entire body but preserve navigation overlay
      console.warn('🎯 BookToBookTransition: #page-wrapper not found, falling back to body replacement');

      // 🎯 CRITICAL: Preserve the existing navigation overlay
      const existingOverlay = document.getElementById('initial-navigation-overlay');

      // Remove any overlay from fetched HTML (we'll keep the existing one)
      const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
      if (overlayInFetchedHTML) {
        overlayInFetchedHTML.remove();
        console.log('🎯 BookToBookTransition: Removed overlay from fetched HTML');
      }

      // Replace body content
      document.body.innerHTML = newDoc.body.innerHTML;

      // 🎯 CRITICAL: Re-insert the preserved overlay if it existed
      if (existingOverlay) {
        document.body.insertBefore(existingOverlay, document.body.firstChild);
        console.log('🎯 BookToBookTransition: Preserved navigation overlay across body replacement');
      }
    }
    
    // Sync body attributes
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    
    // Update document title
    document.title = newDoc.title;

    // Sync <head> meta tags from fetched HTML (SEO + link previews)
    const metaSelectors = [
      'meta[name="description"]',
      'meta[name="keywords"]',
      'meta[property="og:title"]',
      'meta[property="og:description"]',
      'meta[property="og:type"]',
      'meta[property="og:url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:title"]',
      'meta[name="twitter:description"]',
      'meta[name="twitter:image"]',
    ];
    for (const sel of metaSelectors) {
      const newTag = newDoc.head.querySelector(sel);
      const oldTag = document.head.querySelector(sel);
      if (newTag && oldTag) {
        oldTag.setAttribute('content', newTag.getAttribute('content') as any);
      } else if (newTag && !oldTag) {
        document.head.appendChild(newTag.cloneNode(true));
      }
    }
    // Sync citation_* meta tags (replace all)
    document.head.querySelectorAll('meta[name^="citation_"]').forEach(el => el.remove());
    newDoc.head.querySelectorAll('meta[name^="citation_"]').forEach(el => {
      document.head.appendChild(el.cloneNode(true));
    });
    // Sync canonical URL
    const newCanonical = newDoc.head.querySelector('link[rel="canonical"]');
    const oldCanonical = document.head.querySelector('link[rel="canonical"]');
    if (newCanonical && oldCanonical) {
      oldCanonical.setAttribute('href', newCanonical.getAttribute('href') as any);
    }
    // Sync JSON-LD structured data
    const oldJsonLd = document.head.querySelector('script[type="application/ld+json"]');
    const newJsonLd = newDoc.head.querySelector('script[type="application/ld+json"]');
    if (oldJsonLd) oldJsonLd.remove();
    if (newJsonLd) document.head.appendChild(newJsonLd.cloneNode(true));

    // Read slug from new DOM and update global state
    const newMain = document.querySelector('.main-content') as HTMLElement | null;
    const newSlug = newMain?.dataset?.slug || null;
    setCurrentBookSlug(newSlug);

    // Reset contentEditable state
    const editableDiv = document.getElementById(bookId);
    if (editableDiv) {
      editableDiv.contentEditable = "false";
      console.log("🧹 BookToBookTransition: Reset contentEditable");
    }
    
    // Enforce editable state
    try {
      enforceEditableState();
    } catch (error) {
      console.warn('Could not enforce editable state:', error);
    }
  }

  /**
   * Initialize the reader for the new book
   */
  static async initializeReader(bookId: any, progressCallback: any, hasHashNavigation = false) {
    console.log(`🚀 BookToBookTransition: Initializing reader for ${bookId}, hasHashNavigation: ${hasHashNavigation}`);

    try {
      // Set the current book
      setCurrentBook(bookId);
      updateDatabaseBookId(bookId);

      // Always clear stale skip flag from previous transitions
      setSkipScrollRestoration(false);

      // 🚀 CRITICAL: If we have hash navigation, set the global skip flag BEFORE universalPageInitializer
      // This persists across lazy loader resets and prevents restoreScrollPosition() from interfering
      if (hasHashNavigation) {
        console.log(`🔒 Pre-setting skipScrollRestoration = true (hash navigation pending)`);
        setSkipScrollRestoration(true);
      }

      // Initialize reader view but skip overlay restoration for book-to-book
      await universalPageInitializer(progressCallback);

      // 🔧 Reinitialize logo navigation toggle
      console.log('🔧 BookToBookTransition: Reinitializing logo navigation toggle');
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
        console.log('✅ BookToBookTransition: Logo navigation toggle initialized');
      }

      // All UI rebinding is now handled by universalPageInitializer
      console.log("✅ BookToBookTransition: UI initialization delegated to universalPageInitializer");

    } catch (error) {
      console.error('❌ BookToBookTransition: Reader initialization failed:', error);
      throw error;
    }
  }

  /**
   * Handle hash-based navigation (hyperlights, hypercites, footnotes, internal links)
   * @returns {boolean} - True if progress bar was hidden during navigation
   */
  static async handleHashNavigation(hash: any, hyperlightId: any, hyperciteId: any, footnoteId: any, bookId: any, progress: any, targetUrl: any = null) {
    if (!hash && !hyperlightId && !hyperciteId && !footnoteId) {
      console.log('📖 BookToBookTransition: No hash navigation needed');
      return false;
    }

    console.log('🎯 BookToBookTransition: Handling hash navigation', {
      hash, hyperlightId, hyperciteId, footnoteId
    });

    // If the backend couldn't resolve the target (e.g. stale hypercite),
    // check whether the parent hyperlight/footnote still exists — if so,
    // navigate to that and just toast about the missing citation.
    // For multi-level cascades, _targetResolved === false is expected — the
    // hypercite/hyperlight lives in a sub-book, not the parent book.
    // Let the chain system handle it instead of treating it as "not found".
    const isMultiLevelCascade = footnoteId && (hyperlightId || hyperciteId);

    if ((window as any)._targetResolved === false) {
      (window as any)._targetResolved = undefined; // Consume to prevent staleness

      if (!isMultiLevelCascade) {
        console.warn('⚠️ BookToBookTransition: Target not resolved by backend');

        // Show toast for the missing citation
        import('../../../components/toast/toast').then(({ showTargetNotFoundToast }) => {
          showTargetNotFoundToast();
        });

        // Do NOT strip the hash from the URL. `_targetResolved` is false even for a target that
        // simply isn't in the INITIAL chunk (a deep hypercite in a big book) — it can resolve once
        // its chunk loads. Stripping here corrupts the history entry, so back/forward to it lose the
        // target and fall back to a stale saved scroll position (the user-reported forward hang).

        // If there's a parent hyperlight or footnote, navigate to that instead
        if (hyperlightId) {
          console.log(`🎯 BookToBookTransition: Hypercite not found, navigating to hyperlight ${hyperlightId} instead`);
          await this.navigateToInternalId(hyperlightId, progress);
          return true;
        }
        if (footnoteId) {
          console.log(`🎯 BookToBookTransition: Hypercite not found, navigating to footnote ${footnoteId} instead`);
          await navigateToFootnoteTarget(footnoteId, null, currentLazyLoader);
          return true;
        }

        // No parent hyperlight/footnote — full fallback
        await this.ensureInitialContentLoaded(bookId);
        return false;
      }

      console.log('🔗 BookToBookTransition: Multi-level cascade detected, skipping "not found" fallback — letting chain system handle it');
    }

    try {
      // Wait for content to be fully loaded — but only if a chunk was pre-loaded
      // by ensureInitialContentLoaded. When hash navigation is pending we skipped
      // that step (no point loading chunk 0 just to discard it), so the promise
      // won't resolve until _navigateToInternalId loads the correct chunk itself.
      const hasPreloadedChunk = !!document.querySelector(`#${CSS.escape(bookId)} [data-chunk-id]`);
      if (pendingFirstChunkLoadedPromise && hasPreloadedChunk) {
        console.log('⏳ BookToBookTransition: Waiting for content to load before navigation');
        await pendingFirstChunkLoadedPromise;
        console.log('✅ BookToBookTransition: Content loaded, proceeding with navigation');
      }

      // Multi-level cascade: footnote + hyperlight/hypercite → nested containers
      if (footnoteId && (hyperlightId || hyperciteId) && targetUrl) {
        console.log('🔗 BookToBookTransition: Detected multi-level cascade, using chain system');
        try {
          const urlObj = new URL(targetUrl, window.location.origin);
          const pathSegments = urlObj.pathname.split('/').filter(Boolean);
          const chain = await buildChainFromUrl(bookId, pathSegments);

          if (chain && chain.length > 0) {
            const finalHash = hyperciteId || null;
            console.log(`🔗 BookToBookTransition: Opening chain: ${chain.map(c => c.itemId).join(' -> ')} -> ${finalHash}`);
            await openContainerChain(chain, currentLazyLoader, finalHash);
            return true;
          }
          console.warn('🔗 BookToBookTransition: Chain resolution returned empty, falling through');
        } catch (chainError) {
          console.error('🔗 BookToBookTransition: Chain navigation failed, falling through:', chainError);
        }
      }

      // Handle different types of navigation
      if (hyperlightId && hyperciteId) {
        // Hyperlight + hypercite navigation - progress will be hidden when elements are ready
        await this.navigateToHyperciteTarget(hyperlightId, hyperciteId, progress);
        return true; // Progress was hidden by the navigation
      } else if (hyperlightId) {
        // Just hyperlight navigation - progress will be hidden when element is ready
        await this.navigateToInternalId(hyperlightId, progress);
        return true; // Progress was hidden by the navigation
      } else if (footnoteId) {
        // Footnote navigation - scroll to footnote marker and open in container
        const internalId = hash ? (hash.startsWith('#') ? hash.substring(1) : hash) : null;
        console.log(`🎯 BookToBookTransition: Navigating to footnote ${footnoteId}, internal: ${internalId}`);
        await navigateToFootnoteTarget(footnoteId, internalId, currentLazyLoader);
        return true;
      } else if (hash) {
        // General hash navigation - progress will be hidden when element is ready
        const targetId = hash.startsWith('#') ? hash.substring(1) : hash;
        await this.navigateToInternalId(targetId, progress);
        return true; // Progress was hidden by the navigation
      }

      return false; // No navigation performed

    } catch (error) {
      console.error('❌ BookToBookTransition: Hash navigation failed:', error);
      // Don't throw - navigation failure shouldn't break the entire transition
      return false; // Progress was not hidden due to error
    }
  }

  /**
   * Navigate to a hypercite target with deterministic element detection and progress optimization
   */
  static async navigateToHyperciteTarget(hyperlightId: any, hyperciteId: any, progress: any) {
    console.log(`🎯 BookToBookTransition: Delegating to navigateToHyperciteTarget for ${hyperlightId} -> ${hyperciteId}`);

    try {
      // Let navigateToHyperciteTarget handle all the logic: waiting, scrolling, and opening
      // Don't wait here - it causes double-waiting and prevents proper scrolling
      if (currentLazyLoader) {
        await navigateToHyperciteTarget(hyperlightId, hyperciteId, currentLazyLoader, false);

        // Hide progress indicator once navigation is complete
        if (progress && typeof progress.updateProgress === 'function') {
          progress.updateProgress(100);
          setTimeout(() => progress.hide(), 100);
        }
      } else {
        console.warn('currentLazyLoader not available for hypercite navigation');
      }
    } catch (error) {
      console.error('Failed to navigate to hypercite target:', error);
      // Don't throw - attempt navigation anyway as fallback
      try {
        if (currentLazyLoader) {
          await navigateToHyperciteTarget(hyperlightId, hyperciteId, currentLazyLoader, false);
        }
      } catch (fallbackError) {
        console.error('Fallback hypercite navigation also failed:', fallbackError);
      }
    }
  }

  /**
   * Navigate to an internal ID with deterministic element detection and progress optimization
   */
  static async navigateToInternalId(targetId: any, progress: any) {
    console.log(`🎯 BookToBookTransition: Navigating to internal ID: ${targetId}`);

    try {
      // Get the lazy loader and call navigateToInternalId which handles:
      // 1. Determining which chunk contains the element
      // 2. Loading that chunk (and adjacent chunks)
      // 3. Waiting for the element to be ready
      // 4. Scrolling to it
      if (currentLazyLoader) {
        // 🚀 iOS Safari fix: Properly await navigation completion
        // This prevents iOS scroll restoration from interfering before navigation is done
        const result = await navigateToInternalId(targetId, currentLazyLoader, false);
        console.log(`✅ BookToBookTransition: Navigation complete for ${targetId}`, result);

        // Update progress to show navigation is complete
        if (progress) {
          progress(98, 'Navigation complete');
        }
        return result;
      } else {
        console.warn('currentLazyLoader not available for internal navigation');
        throw new Error('LazyLoader not available');
      }
    } catch (error) {
      console.error('Failed to navigate to internal ID:', error);
      // Re-throw to let NavigationManager handle error cleanup
      throw error;
    }
  }

  /**
   * Update the browser URL while preserving container state for back button
   */
  static updateUrlWithStatePreservation(bookId: any, hash = '', isPopstate = false) {
    // Use slug in URL bar if available, otherwise use bookId
    const urlSegment = _bookSlug || bookId;
    const newUrl = `/${urlSegment}${hash}`;

    try {
      const currentUrl = window.location.pathname + window.location.hash;

      // Only update URL if we're not already there
      if (currentUrl !== newUrl) {
        console.log(`🔗 BookToBookTransition: Navigating to ${newUrl}`);

        // For book-to-book navigation, create a new history entry so back/forward works
        const currentState = history.state || {};

        const transitionMeta = {
          fromBook: this.getCurrentBookId(),
          toBook: bookId,
          timestamp: Date.now(),
        };

        if (isPopstate) {
          // Popstate (browser back/forward): PRESERVE the destination entry's
          // saved state. This entry was created when the user was previously
          // here, and may carry containerStack / hyperlitContainer data that
          // needs to drive the deep-stack restoration about to run in
          // initializePage. Nulling those would defeat the whole back-restore
          // mechanism. Only stamp the transition metadata; keep everything
          // else intact.
          const preservedState = {
            ...currentState,
            bookTransition: transitionMeta,
          };
          history.replaceState(preservedState, '', newUrl);
        } else {
          // Normal forward navigation (user clicked a link / hypercite):
          // create a new history entry for the destination. The destination
          // is a fresh visit to this book — start it with an empty stack.
          const newEntryState = {
            ...currentState,
            hyperlitContainer: null,
            containerStack: null,
            containerStackBookId: null,
            bookTransition: transitionMeta,
          };
          history.pushState(newEntryState, '', newUrl);
        }
      } else {
        console.log(`🔗 BookToBookTransition: Already at ${newUrl}`);
      }
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

  /**
   * Legacy method for compatibility - now delegates to state-preserving version
   */
  static updateUrl(bookId: any, hash = '') {
    return this.updateUrlWithStatePreservation(bookId, hash);
  }

  /**
   * Get current book ID from DOM or URL
   */
  static getCurrentBookId() {
    // Try to get from current URL first
    const pathSegments = window.location.pathname.split('/').filter(Boolean);
    if (pathSegments.length > 0 && !pathSegments[0]!.startsWith('HL_')) {
      return pathSegments[0];
    }
    
    // Fallback to DOM detection
    const bookElement = document.querySelector('[id]:not([id^="HL_"]):not([id^="hypercite_"])');
    return bookElement ? bookElement.id : 'unknown';
  }

  /**
   * Handle hyperlight URL navigation (special case of book-to-book) with smart progress management
   */
  static async handleHyperlightNavigation(options: any = {}) {
    const { 
      fromBook, 
      toBook, 
      hyperlightId, 
      hyperciteId,
      progressCallback 
    } = options;
    
    console.log('✨ BookToBookTransition: Handling hyperlight navigation', { 
      fromBook, toBook, hyperlightId, hyperciteId 
    });
    
    // Use deterministic progress callback that shows progress immediately
    const progress = progressCallback || this.createDeterministicProgressCallback(toBook);
    
    // Execute transition with specific hyperlight handling
    return await this.execute({
      fromBook,
      toBook,
      hash: hyperciteId ? `#${hyperciteId}` : '',
      hyperlightId,
      hyperciteId,
      progressCallback: progress
    });
  }

  /**
   * Parse a hyperlight URL and extract components
   */
  static parseHyperlightUrl(url: any) {
    try {
      const urlObj = new URL(url, window.location.origin);
      const pathSegments = urlObj.pathname.split('/').filter(Boolean);
      
      if (pathSegments.length >= 2 && pathSegments[1]!.startsWith('HL_')) {
        return {
          bookId: pathSegments[0],
          hyperlightId: pathSegments[1],
          hyperciteId: urlObj.hash ? urlObj.hash.substring(1) : null
        };
      }
      
      return null;
    } catch (error) {
      console.error('Error parsing hyperlight URL:', error);
      return null;
    }
  }

  /**
   * Check if a URL represents a hyperlight navigation
   */
  static isHyperlightUrl(url: any) {
    const parsed = this.parseHyperlightUrl(url);
    return parsed !== null;
  }

  /**
   * Create a deterministic progress callback that shows progress immediately
   */
  static createDeterministicProgressCallback(toBook: any) {
    // Always show progress immediately, never suppress
    const progressCallback = ProgressOverlayConductor.createProgressCallback('book-to-book', toBook);
    
    // Show initial progress immediately
    progressCallback(5, `Loading ${toBook}...`);
    
    return progressCallback;
  }

  /**
   * Ensure initial content is actually loaded into the DOM
   */
  static async ensureInitialContentLoaded(bookId: any) {
    console.log(`📄 BookToBookTransition: Ensuring initial content loaded for ${bookId}`);
    
    try {
      // Check if content is already in the DOM
      const container = document.getElementById(bookId);
      if (!container) {
        console.warn(`Container #${bookId} not found`);
        return;
      }
      
      const existingChunks = container.querySelectorAll('[data-chunk-id]');
      if (existingChunks.length > 0) {
        console.log(`✅ Content already loaded: ${existingChunks.length} chunks found`);
        return;
      }
      
      // Get the lazy loader and manually load first chunk
      if (!currentLazyLoader) {
        console.warn('No lazy loader available for manual chunk loading');
        return;
      }
      
      // Find the first chunk to load — prefer chunk 0, but during chunked lazy loading
      // the initial chunk may be a different one (e.g. the chunk containing a navigation target)
      if ((window as any).nodes && (window as any).nodes.length > 0) {
        let targetChunkId = (window as any).nodes[0].chunk_id;

        // Check for saved scroll position to resume at correct chunk
        try {
          const scrollKey = `scrollPosition_${bookId}`;
          const scrollData = sessionStorage.getItem(scrollKey) || localStorage.getItem(scrollKey);
          if (scrollData) {
            const parsed = JSON.parse(scrollData);
            if (parsed?.elementId) {
              const matchingNode = (window as any).nodes.find(
                (n: any) => String(n.startLine) === String(parsed.elementId)
              );
              if (matchingNode) {
                targetChunkId = matchingNode.chunk_id;
                console.log(`📄 Resuming at chunk ${targetChunkId} (saved position: ${parsed.elementId})`);
              }
            }
          }
        } catch (e) { /* fall back to first chunk */ }

        console.log(`📄 Manually loading chunk ${targetChunkId} for ${bookId}`);
        await currentLazyLoader.loadChunk(targetChunkId, "down");

        // If the loaded chunk has fewer than 20 nodes, load the next chunk too
        const loadedNodeCount = currentLazyLoader.container.querySelectorAll('[data-node-id]').length;
        if (loadedNodeCount < 20) {
          const allChunkIds = currentLazyLoader.chunkManifest
            ? currentLazyLoader.chunkManifest.map((m: any) => m.chunk_id)
            : [...new Set(currentLazyLoader.nodes.map((n: any) => n.chunk_id))].sort((a: any, b: any) => a - b);
          const pos = allChunkIds.indexOf(targetChunkId);
          let nextPos = pos + 1;
          while (nextPos < allChunkIds.length && currentLazyLoader.container.querySelectorAll('[data-node-id]').length < 20) {
            const nextId = allChunkIds[nextPos];
            const hasNodes = currentLazyLoader.nodes.some((n: any) => n.chunk_id === nextId);
            if (!hasNodes) break;
            await currentLazyLoader.loadChunk(nextId, "down");
            nextPos++;
          }
        }

        // Verify content was loaded
        const loadedChunks = container.querySelectorAll('[data-chunk-id]');
        if (loadedChunks.length > 0) {
          console.log(`✅ Initial content loaded successfully: ${loadedChunks.length} chunks`);
        } else {
          console.warn(`❌ Initial content load may have failed`);
        }
      }
      
    } catch (error) {
      console.error('Error ensuring initial content loaded:', error);
    }
  }

  /**
   * Create regular progress callback for non-cached content
   */
  static createBookToBookProgressCallback(toBook: any) {
    const { ProgressOverlayConductor } = window as any;
    if (!ProgressOverlayConductor) {
      console.warn('ProgressOverlayConductor not available, using console fallback');
      return (percent: any, message: any) => console.log(`Progress: ${percent}% - ${message}`);
    }

    return ProgressOverlayConductor.showBookToBookTransition(toBook);
  }
}