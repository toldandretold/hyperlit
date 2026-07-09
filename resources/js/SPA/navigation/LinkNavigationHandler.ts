/**
 * LinkNavigationHandler - Manages intelligent link navigation routing
 * Determines which navigation pathway to use based on link types and context
 */
import { NavigationManager } from './NavigationManager.js';
import { registerNavActions } from './navigationRegistry';
import { BookToBookTransition } from './pathways/BookToBookTransition.js';
import { getPageStructure, areStructuresCompatible, getSubdomain, getBookIdFromUrl } from './utils/structureDetection.js';
import { log, verbose } from '../../utilities/logger';
import { hideNavigationLoading, navigateToInternalId } from '../../scrolling/index';
import { recordNavDecision } from '../../scrolling/scrollTrace';
import { book, bookSlug as _bookSlug } from '../../app';
import { ProgressOverlayConductor } from './ProgressOverlayConductor.js';
// hypercites is a reader-only lazy chunk; wrap the nav fns as lazy importers so this (boot-loaded,
// all-pages) handler doesn't statically pull hypercites into the eager bundle. Called on link clicks
// (reader interaction), by which time reader-init has warmed the chunk.
const navigateToHyperciteTarget = (...a: any[]) => import('../../hypercites/navigation').then((m) => (m.navigateToHyperciteTarget as any)(...a));
const navigateToFootnoteTarget = (...a: any[]) => import('../../hypercites/navigation').then((m) => (m.navigateToFootnoteTarget as any)(...a));
import { currentLazyLoader, openContainerChain, buildChainFromUrl } from '../../pageLoad/index';
import { getLocalStorageKey } from '../../indexedDB/index';
import { closeHyperlitContainer } from '../../hyperlitContainer/index';
import { registerLinkClickHandler } from '../../utilities/linkClickRegistry';

export class LinkNavigationHandler {
  static globalLinkClickHandler: any = null;
  static globalVisibilityHandler: any = null;
  static globalFocusHandler: any = null;
  static globalPopstateHandler: any = null;
  static isReloading = false;
  // Set when a popstate arrives while a transition is already in flight — signals
  // handlePopstate to reconcile once more against the final history entry after
  // the burst (see handlePopstate). Coalescing, not dropping.
  static pendingPopstate = false;


  /**
   * Attach global link click handler for intelligent navigation
   * NOTE: Click handling is done by lazyLoaderFactory.js
   * This only attaches visibility/focus/popstate handlers
   */
  static attachGlobalLinkClickHandler() {
    // Remove existing handlers if they exist
    this.removeGlobalHandlers();
    // Reset reload flag when handlers are attached (page is loaded)
    this.isReloading = false;
    this.pendingPopstate = false;

    // Track recent link clicks for mobile overlay handling
    let recentLinkClick = false;

    // Clear overlay when page becomes visible again (handles back button cache issues)
    this.globalVisibilityHandler = async () => {
      if (!document.hidden && !recentLinkClick) {
        // Page is visible again, clear any stuck overlay
        // But only if we didn't just click a link (which would be navigating away)
        verbose.nav('Visibility change - clearing overlay (not from recent link click)', '/navigation/LinkNavigationHandler.js');
        // Already imported statically
        hideNavigationLoading();
      }
    };

    // Also handle page focus as fallback
    this.globalFocusHandler = async () => {
      // Already imported statically
      hideNavigationLoading();
    };

    // Handle browser back/forward navigation. Serialization + coalescing of
    // overlapping events lives in handlePopstate — do NOT early-drop here (that
    // was the second half of the drop-on-reentry bug: a mid-transition popstate
    // never even reached handlePopstate to be reconciled).
    this.globalPopstateHandler = async (event: any) => {
      verbose.nav('Browser navigation detected (back/forward)', '/navigation/LinkNavigationHandler.js', {
        state: event.state,
        currentURL: window.location.href,
        historyLength: window.history.length,
        hasHash: !!window.location.hash,
        hash: window.location.hash
      } as any);

      await this.handlePopstate(event);
    };

    // Track recent link clicks (for mobile handling)
    const clickTracker = () => {
      recentLinkClick = true;
      setTimeout(() => { recentLinkClick = false; }, 1000);
    };

    // Add all the event listeners (click handled by lazyLoaderFactory)
    document.addEventListener('click', clickTracker);
    document.addEventListener('visibilitychange', this.globalVisibilityHandler);
    window.addEventListener('focus', this.globalFocusHandler);
    window.addEventListener('popstate', this.globalPopstateHandler);
  }

  /**
   * Remove global handlers
   */
  static removeGlobalHandlers() {
    if (this.globalLinkClickHandler) {
      // Click handler now managed by lazyLoaderFactory
    }
    if (this.globalVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.globalVisibilityHandler);
    }
    if (this.globalFocusHandler) {
      window.removeEventListener('focus', this.globalFocusHandler);
    }
    if (this.globalPopstateHandler) {
      window.removeEventListener('popstate', this.globalPopstateHandler);
    }

    this.globalLinkClickHandler = null;
    this.globalVisibilityHandler = null;
    this.globalFocusHandler = null;
    this.globalPopstateHandler = null;
  }

  /**
   * Handle individual link clicks with intelligent routing
   */
  static async handleLinkClick(event: any) {
    const link = event.target.closest('a');
    if (!link || !link.href) return;

    const linkUrl = new URL(link.href, window.location.origin);
    const currentUrl = new URL(window.location.href);

    // --- SYNCHRONOUS DECISION ---
    // Decide if this is an SPA-handled link without awaiting anything.
    const isExternal = linkUrl.origin !== currentUrl.origin;
    const shouldSkip = this.shouldSkipLinkHandling(link, linkUrl, currentUrl);

    // If it's not external and not a special link handled elsewhere, it's for us.
    if (!isExternal && !shouldSkip) {
      event.preventDefault();
      verbose.nav('Intercepted link for SPA routing', '/navigation/LinkNavigationHandler.js', link.href);

      // --- ASYNCHRONOUS PROCESSING ---
      // Now that the default navigation is stopped, we can perform async operations.
      try {
        // book already imported statically
        const currentBookPath = `/${book}`;

        if (this.isSameBookNavigation(linkUrl, currentUrl, currentBookPath)) {
          await this.handleSameBookNavigation(link, linkUrl);
        } else if (this.isDifferentBookNavigation(linkUrl, currentBookPath)) {
          await this.handleBookToBookNavigation(link, linkUrl);
        } else {
          // This case should not be reached if logic is correct, but as a fallback:
          verbose.nav('Link was not routed, falling back to full navigation', '/navigation/LinkNavigationHandler.js');
          window.location.href = link.href;
        }
      } catch (error) {
        log.error('[LINK CLICK] SPA navigation failed, falling back to full navigation', '/navigation/LinkNavigationHandler.js', error);
        window.location.href = link.href;
      }
    }
  }

  /**
   * Check if we should skip handling this link
   */
  static shouldSkipLinkHandling(link: any, linkUrl: any, currentUrl: any) {
    // Skip hypercites and TOC links - they have their own handlers
    const isHypercite = link.closest('u.couple, u.poly') || link.classList.contains('hypercite-target') || link.querySelector(':scope > u.couple, :scope > u.poly');
    const isTocLink = link.closest('#toc-container');
    const isDeleteButton = link.classList.contains('delete-book') || link.closest('.delete-book');
    const isBookActions = link.classList.contains('book-actions') || link.closest('.book-actions');
    const isStripeTopup = link.classList.contains('stripe-topup') || link.closest('.stripe-topup');
    const isTierSelector = link.classList.contains('tier-selector') || link.closest('.tier-selector');
    const isTierOption = link.classList.contains('tier-option') || link.closest('.tier-option');

    // Skip footnote links - handled by footnotesCitations.js
    const isFootnoteLink = link.classList.contains('footnote-ref') || link.closest('sup[fn-count-id]');

    // Skip blob URLs (downloads)
    const isBlobUrl = linkUrl.protocol === 'blob:';

    // Skip the accessibility skip-to-content link (layout.blade.php): native
    // fragment navigation must handle it — routing it through SPA nav builds
    // a `/${book}` path, which on home (book=null) rewrote the URL to /null.
    const isSkipLink = link.classList.contains('skip-link');

    if (isHypercite || isTocLink || isDeleteButton || isBookActions || isStripeTopup || isTierSelector || isTierOption || isBlobUrl || isFootnoteLink || isSkipLink) {
      return true;
    }

    return false;
  }

  /**
   * Handle progress display for cross-book hypercites
   */
  static async handleHyperciteProgress(linkUrl: any) {
    try {
      // book already imported statically
      const currentBookPath = `/${book}`;

      // Check if it's a cross-book hypercite
      if (linkUrl.origin === window.location.origin && !linkUrl.pathname.startsWith(currentBookPath)) {
        const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
        const targetBookId = pathSegments[0] || 'book';

        verbose.nav(`Cross-book hypercite detected. Showing progress for ${targetBookId}`, '/navigation/LinkNavigationHandler.js');

        // ProgressOverlayConductor already imported statically
        ProgressOverlayConductor.showBookToBookTransition(5, `Loading ${targetBookId}...`, targetBookId);
      }
    } catch (error) {
      log.error('Could not handle hypercite progress', '/navigation/LinkNavigationHandler.js', error);
    }
  }

  /**
   * Check if this is same-book navigation
   */
  static isSameBookNavigation(linkUrl: any, currentUrl: any, currentBookPath: any) {
    const isSamePageAnchor = linkUrl.pathname === currentUrl.pathname && linkUrl.hash !== '';
    
    // Enhanced same-book detection for hyperlight URLs
    const currentPathIsHyperlight = this.isHyperlightUrl(currentUrl.pathname);
    const targetPathIsBook = linkUrl.pathname === currentBookPath;
    const targetPathIsHyperlight = this.isHyperlightUrl(linkUrl.pathname);
    
    // Extract base book path from current URL if it's a hyperlight URL
    const currentBasePath = currentPathIsHyperlight ? 
      this.extractBookPathFromHyperlightUrl(currentUrl.pathname) : 
      currentUrl.pathname;
    
    const linkBasePath = targetPathIsHyperlight ? 
      this.extractBookPathFromHyperlightUrl(linkUrl.pathname) : 
      linkUrl.pathname;
    
    // Same book if:
    // 1. Exact same page anchor
    // 2. Both paths resolve to same book (handling hyperlight URLs)
    // 3. Target is book root and current is hyperlight of same book
    const isAIreviewLink = linkUrl.pathname.endsWith('/AIreview');
    const isSameBookNavigation = !isAIreviewLink && (
      (currentBasePath === linkBasePath) ||
      (currentPathIsHyperlight && targetPathIsBook && currentBasePath === currentBookPath) ||
      (linkUrl.pathname.startsWith(currentBookPath) && linkUrl.hash !== '')
    );
    
    return isSamePageAnchor || isSameBookNavigation;
  }

  /**
   * Check if this is different book navigation
   */
  static isDifferentBookNavigation(linkUrl: any, currentBookPath: any) {
    // Extract base book path if current URL is a hyperlight URL
    const linkBasePath = this.isHyperlightUrl(linkUrl.pathname) ? 
      this.extractBookPathFromHyperlightUrl(linkUrl.pathname) : 
      linkUrl.pathname;
      
    if (linkUrl.pathname.endsWith('/AIreview')) return true;
    return linkBasePath && !linkBasePath.startsWith(currentBookPath);
  }

  /**
   * Handle same-book navigation (anchors, internal links)
   */
  static async handleSameBookNavigation(link: any, linkUrl: any) {
    verbose.nav('Same-book navigation', '/navigation/LinkNavigationHandler.js', link.href);

    try {
      // Close any open container when navigating from a link inside it
      if (link.closest('#hyperlit-container') || link.closest('.hyperlit-container-stacked')) {
        try {
          await closeHyperlitContainer(true);
        } catch (e) { /* ignore */ }
      }
      // Check if this is a hyperlight URL pattern
      const pathSegments = linkUrl.pathname.split('/').filter(Boolean);

      // Scan ALL segments for HL_ and Fn patterns (not just index 1 — page numbers may appear before them)
      const hlSegment = pathSegments.find((p: any) => p.startsWith('HL_'));
      const fnSegment = pathSegments.find((p: any) => p.includes('_Fn') || /^Fn\d/.test(p));
      const isHyperlightURL = !!hlSegment;
      const isFootnoteURL = !!fnSegment;

      // Build full chain from URL (handles level 3+ via IndexedDB lookup)
      const chain = await buildChainFromUrl(pathSegments[0], pathSegments);

      if (chain.length >= 2) {
        // Multi-level sub-book: use chain system (handles any depth)
        const hyperciteId = linkUrl.hash.substring(1);

        verbose.nav(`Same-book multi-level cascade: ${chain.map((c: any) => c.itemId).join(' -> ')} -> ${hyperciteId}`, '/navigation/LinkNavigationHandler.js');

        if (currentLazyLoader) {
          const url = new URL(link.href);
          const slugUrl = this.preserveSlugInUrl(url);
          const currentUrl = window.location.pathname + window.location.hash;
          if (currentUrl !== slugUrl) {
            window.history.pushState(null, '', slugUrl);
          }
          await openContainerChain(chain, currentLazyLoader, hyperciteId || null);
        }
      } else if (isHyperlightURL) {
        const hyperciteId = linkUrl.hash.substring(1);

        verbose.nav(`Same-book hyperlight navigation: ${hlSegment} -> ${hyperciteId}`, '/navigation/LinkNavigationHandler.js');

        if (currentLazyLoader) {
          const url = new URL(link.href);
          const slugUrl = this.preserveSlugInUrl(url);
          const currentUrl = window.location.pathname + window.location.hash;
          if (currentUrl !== slugUrl) {
            verbose.nav('Updating URL for same-book hyperlight', '/navigation/LinkNavigationHandler.js', slugUrl as any);
            window.history.pushState(null, '', slugUrl);
          }
          if (hyperciteId) {
            navigateToHyperciteTarget(hlSegment, hyperciteId, currentLazyLoader);
          } else {
            navigateToInternalId(hlSegment, currentLazyLoader, false);
          }
        }
      } else if (isFootnoteURL) {
        const hyperciteId = linkUrl.hash.substring(1);

        verbose.nav(`Same-book footnote navigation: ${fnSegment} -> ${hyperciteId}`, '/navigation/LinkNavigationHandler.js');

        if (currentLazyLoader) {
          const url = new URL(link.href);
          const slugUrl = this.preserveSlugInUrl(url);
          const currentUrl = window.location.pathname + window.location.hash;
          if (currentUrl !== slugUrl) {
            verbose.nav('Updating URL for same-book footnote', '/navigation/LinkNavigationHandler.js', slugUrl as any);
            window.history.pushState(null, '', slugUrl);
          }
          await navigateToFootnoteTarget(fnSegment, hyperciteId, currentLazyLoader);
        }
      } else {
        // Regular same-book navigation
        const targetId = linkUrl.hash.substring(1);

        if (currentLazyLoader) {
          const url = new URL(link.href);
          const slugUrl = this.preserveSlugInUrl(url);

          // Only update URL if we're not already there
          const currentUrl = window.location.pathname + window.location.hash;
          if (currentUrl !== slugUrl) {
            verbose.nav('Updating URL for same-book navigation', '/navigation/LinkNavigationHandler.js', {
              targetUrl: slugUrl,
              currentUrl: window.location.href,
              historyLength: window.history.length
            } as any);
            window.history.pushState(null, '', slugUrl);
          }

          navigateToInternalId(targetId, currentLazyLoader, false);
        }
      }
    } catch (error) {
      log.error('Same-book navigation failed', '/navigation/LinkNavigationHandler.js', error);
    }
  }

  /**
   * Handle book-to-book navigation (now structure-aware using NEW SYSTEM)
   */
  static async handleBookToBookNavigation(link: any, linkUrl: any) {
    verbose.nav('Book-to-book navigation', '/navigation/LinkNavigationHandler.js', link.href);

    try {
      // Detect current and target structures
      const currentStructure = getPageStructure();
      const currentBookId = this.getBookIdFromUrl(window.location.href);
      const targetBookId = this.getBookIdFromUrl(linkUrl.href);

      verbose.nav('Navigation context', '/navigation/LinkNavigationHandler.js', {
        currentStructure,
        currentBookId,
        targetBookId,
        linkUrl: linkUrl.href
      } as any);

      // Stamp current URL with clicked anchor's id so back-button can scroll
      // back to it — but ONLY for links inside the content area. Chrome links
      // like #homeButtonNav (the home button in the header) aren't valid
      // scroll targets within .main-content, and stamping them causes the
      // back-nav popstate handler to spend 5 seconds searching for a node
      // that lives in the page header.
      if (link.id && link.closest('.main-content')) {
        history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}#${link.id}`);
      }

      const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
      const targetHash = linkUrl.hash;

      // Scan ALL segments for HL_ and Fn patterns (not just index 1 — page numbers may appear before them)
      const hlSegment = pathSegments.find((p: any) => p.startsWith('HL_'));
      const fnSegment = pathSegments.find((p: any) => p.includes('_Fn') || /^Fn\d/.test(p));
      const isHyperlightURL = !!hlSegment;
      const isFootnoteURL = !!fnSegment;

      if (isFootnoteURL && isHyperlightURL) {
        const hyperciteId = targetHash.substring(1);

        verbose.nav(`Cross-book footnote+highlight cascade: ${targetBookId}/${fnSegment}/${hlSegment}${targetHash}`, '/navigation/LinkNavigationHandler.js');

        await NavigationManager.navigateByStructure({
          fromBook: currentBookId,
          toBook: targetBookId,
          targetUrl: linkUrl.href,
          hash: targetHash,
          footnoteId: fnSegment,
          hyperlightId: hlSegment,
          hyperciteId: hyperciteId || null
        });
        return;
      }

      if (isHyperlightURL) {
        const hyperciteId = targetHash.substring(1);

        verbose.nav(`Cross-book hyperlight navigation: ${targetBookId}/${hlSegment}${targetHash}`, '/navigation/LinkNavigationHandler.js');

        await NavigationManager.navigateByStructure({
          toBook: targetBookId,
          targetUrl: linkUrl.href,
          hash: targetHash,
          hyperlightId: hlSegment,
          hyperciteId: hyperciteId || null
        });
        return;
      }

      if (isFootnoteURL) {
        verbose.nav(`Cross-book footnote navigation: ${targetBookId}/${fnSegment}${targetHash}`, '/navigation/LinkNavigationHandler.js');

        await NavigationManager.navigateByStructure({
          fromBook: currentBookId,
          toBook: targetBookId,
          targetUrl: linkUrl.href,
          hash: targetHash,
          footnoteId: fnSegment,
        });
        return;
      }

      // Use NEW structure-aware navigation system
      await NavigationManager.navigateByStructure({
        fromBook: currentBookId,
        toBook: targetBookId,
        targetUrl: linkUrl.href,
        hash: targetHash
      });

    } catch (error) {
      log.error('Navigation failed', '/navigation/LinkNavigationHandler.js', error);
      // Fallback to full page navigation
      window.location.href = link.href;
    }
  }

  /**
   * Handle visibility changes (for overlay management)
   */
  static handleVisibilityChange() {
    if (!document.hidden && !this.recentLinkClick) {
      verbose.nav('Visibility change - clearing overlay', '/navigation/LinkNavigationHandler.js');

      Promise.resolve().then(() => {
        hideNavigationLoading();
      }).catch(() => {
        // Ignore if not available
      });
    }
  }

  /**
   * Handle page focus (fallback overlay clearing)
   */
  static handlePageFocus() {
    Promise.resolve().then(() => {
      hideNavigationLoading();
    }).catch(() => {
      // Ignore if not available
    });
  }

  /**
   * Handle browser back/forward navigation
   */
  static async handlePopstate(event: any) {
    // Serialize transitions (only one at a time) AND coalesce overlapping
    // popstates — do NOT drop them.
    //
    // Serialization is load-bearing: without it, rapid back/forward fires
    // multiple overlapping BookToBookTransition runs that race on
    // body.innerHTML replacement and chunk appending, leaving the DOM with
    // duplicate chunks (every data-node-id / Fn… / hypercite_… id twice).
    //
    // But simply IGNORING an event that arrives mid-transition (the old
    // behaviour) is itself a bug: the browser has ALREADY advanced the URL by
    // the time popstate fires, so a dropped event means the URL moved on while
    // the DOM never processed that step. Under a rapid burst that left the
    // reader showing the PREVIOUS book (stale chunks, a stuck-open
    // #hyperlit-container, subBooks mounted) while `location` pointed at a
    // different book — the `container-persisted-across-nav` desync the
    // cross-book hypercite tour reproduces.
    //
    // Fix: when an event lands mid-transition, flag it and RECONCILE once more
    // after the in-flight transition finishes. _handlePopstateInner reads the
    // live window.location / history.state, so the reconcile pass always
    // resolves to the FINAL history entry after the burst, leaving the DOM in
    // sync with the URL.
    if (this.isReloading) {
      this.pendingPopstate = true;
      verbose.nav('Popstate arrived mid-transition — queued to reconcile after', '/navigation/LinkNavigationHandler.js');
      return;
    }
    this.isReloading = true;

    try {
      let evt = event;
      do {
        this.pendingPopstate = false;
        await this._handlePopstateInner(evt);
        // If a popstate landed while we were transitioning, re-run against the
        // CURRENT entry — a synthetic event carrying the live history.state, since
        // the real event object is stale (only its .state is read, in the enter log).
        evt = { state: history.state };
      } while (this.pendingPopstate);
    } finally {
      this.isReloading = false;
    }
  }

  static async _handlePopstateInner(event: any) {
    verbose.nav('Browser navigation detected (back/forward)', '/navigation/LinkNavigationHandler.js', {
      state: event.state,
      currentURL: window.location.href,
      historyLength: window.history.length,
      hasHash: !!window.location.hash,
      hash: window.location.hash
    } as any);

    // Skip-link fragment jump (#main-start — the accessibility anchor in
    // layout.blade.php, present on every page). Activating it is a native
    // same-document navigation that fires popstate; it is never a book/content
    // navigation. Routing it through the machinery below misread it as
    // home→home with a null book and rewrote the URL to /null#main-start.
    if (window.location.hash === '#main-start') {
      verbose.nav('Popstate is the #main-start skip-link jump — native behavior stands', '/navigation/LinkNavigationHandler.js');
      return;
    }

    // 🔍 DIAGNOSTIC (flag-gated): record the decision INPUTS — captured BEFORE the line below
    // deletes the saved scroll position, so the trace shows the value that was destroyed.
    const _hash = window.location.hash;
    recordNavDecision({
      phase: 'enter',
      hash: _hash,
      currentBook: book,
      urlBookId: this.extractBookSlugFromPath(window.location.pathname),
      sessionPos: (() => { try { return sessionStorage.getItem(getLocalStorageKey('scrollPosition', book)); } catch { return null; } })(),
      capturedStackDepth: history.state?.containerStack?.length || 0,
      historyLength: window.history.length,
    });

    // NOTE: back/forward to a hash needs no marker-clearing here anymore. It re-navigates directly
    // (same-book → navigateToInternalId below; cross-book → navigateByStructure), and
    // navigateToInternalId already clears the stale sessionStorage position when it jumps. The
    // resume-vs-jump decision (restore.ts) only runs on cold load / refresh — never on this
    // popstate path — so the hash always wins on back/forward regardless. (The old
    // navigatedHashes/scrolled-away clearing block was retired with those signals.)

    // Check if we need to navigate between different content using SPA transitions
    const currentBookVariable = book; // Using statically imported book
    const urlBookId = this.extractBookSlugFromPath(window.location.pathname);

    // If the URL book doesn't match the current loaded book content, use SPA navigation
    // Also check against slug — URL may show slug while book holds the real ID.
    // Safety net: also trust the ACTUALLY-RENDERED book (main.main-content.id). If the URL's
    // book differs from what's on screen, take the cross-book path regardless of a possibly
    // stale/truncated `_bookSlug` — otherwise a URL↔content desync leaves Back a permanent
    // no-op (the slug clause wrongly reports "same book").
    //
    // SLUG-AWARE: the rendered reader is `<main id="{{ $book }}" data-slug="…">` — for a
    // vanity-slug book, id is the RAW id (book_123…) while the URL carries the slug
    // (/welcome). Comparing urlBookId against id alone made every container close on a
    // slug URL (back → /welcome) misdetect as cross-book and FULL-RELOAD the same book
    // (the "Loading welcome…" flash on closing a highlight in read mode). A URL naming
    // the rendered book's data-slug is the SAME book.
    const readerMainEl: any = document.querySelector('.main-content');
    const renderedBookId = readerMainEl?.id || null;
    const renderedSlug = readerMainEl?.getAttribute?.('data-slug') || null;
    const differsFromRendered = !!renderedBookId
      && urlBookId !== renderedBookId
      && !(renderedSlug && urlBookId === renderedSlug);
    const effectiveSlug = _bookSlug || renderedSlug;
    if (urlBookId !== currentBookVariable && (differsFromRendered || !effectiveSlug || urlBookId !== effectiveSlug)) {
      verbose.nav(`Back button: URL shows ${urlBookId} but content is ${currentBookVariable}. Using structure-aware navigation.`, '/navigation/LinkNavigationHandler.js');

      // Parse cascade segments from URL path (same logic as handleBookToBookNavigation)
      const pathSegments = window.location.pathname.split('/').filter(Boolean);
      const hlSegment = pathSegments.find((p: any) => p.startsWith('HL_'));
      const fnSegment = pathSegments.find((p: any) => p.includes('_Fn') || /^Fn\d/.test(p));
      const hyperciteId = window.location.hash ? window.location.hash.substring(1) : null;

      const navOptions: any = {
        fromBook: currentBookVariable,
        toBook: urlBookId,
        targetUrl: window.location.href,
        hash: window.location.hash,
        isPopstate: true, // Don't pushState — browser already set the URL
      };

      // If the destination entry has a saved containerStack that will be
      // restored after body replacement (via initializePage's restoration
      // path), we DON'T also pass cascade hint options — they'd trigger a
      // parallel navigateToInternalId that hangs for 5s waiting for an
      // HL_/Fn_ element to appear in main content (the element actually
      // lives in a sub-book mounted by the restoration). The restoration
      // already opens the right containers and surfaces the right element.
      const willRestoreStack = (history.state?.containerStack?.length || 0) > 0
        && history.state?.containerStackBookId === urlBookId;
      if (!willRestoreStack) {
        // Pass cascade segments so BookToBookTransition can rebuild nested containers
        if (fnSegment) navOptions.footnoteId = fnSegment;
        if (hlSegment) navOptions.hyperlightId = hlSegment;
        if (hyperciteId && hyperciteId.startsWith('hypercite_')) navOptions.hyperciteId = hyperciteId;
      } else {
        verbose.nav(
          `Back nav into ${urlBookId} — skipping cascade hints (containerStack length=${history.state.containerStack.length} will restore them)`,
          '/navigation/LinkNavigationHandler.js'
        );
      }

      // Use NEW structure-aware navigation system
      // NavigationManager already imported statically
      recordNavDecision({ phase: 'branch', branch: 'cross-book', hash: window.location.hash, toBook: urlBookId, willRestoreStack });
      await NavigationManager.navigateByStructure(navOptions);
      return;
    }
    
    // Capture containerStack BEFORE close (closeHyperlitContainer clears it from history.state)
    const capturedStack = history.state?.containerStack || null;

    // ── Fast path: same-book back/forward by exactly one container level ──
    // When the user presses back from "depth N" to "depth N-1" (or forward
    // from "depth N" to "depth N+1"), the two states share the bottom min
    // layers. Rather than close-all and rebuild (visible flicker), apply
    // the minimal mutation:
    //   - back by one  → popTopLayer()
    //   - forward by 1 → restoreStackedLayer(capturedStack[N].contentMetadata)
    // Falls through to the full close+rebuild path for stack-shape changes
    // that aren't one-level deltas (cross-book hops, sibling chains, etc.).
    try {
      const { getDepth, serializeStack, popTopLayer } = await import('../../hyperlitContainer/stack');
      const currentDepth = getDepth();
      const savedDepth = capturedStack?.length || 0;
      const currentSerialized: any = serializeStack();

      // Compare the shared-prefix layers (up to min(current, saved)).
      const sharedLayers = Math.min(currentDepth, savedDepth);
      let bottomMatches = true;
      for (let i = 0; i < sharedLayers; i++) {
        const cur = currentSerialized[i]?.contentMetadata;
        const sav = capturedStack[i]?.contentMetadata;
        if (JSON.stringify(cur?.contentTypes) !== JSON.stringify(sav?.contentTypes)) {
          bottomMatches = false;
          break;
        }
      }

      // Book guard (mirrors restoreContainerStack, history.ts:419-434): only apply the
      // fast path when the saved stack belongs to the currently-rendered reader book. A
      // cross-version hop (book_X → book_X/AIreview) can leave a history entry whose
      // containerStack still points at the PARENT book's layer (containerStackBookId is
      // stamped from the lagging `book` global). Pushing/popping that layer over the wrong
      // book opens the container over unrelated content and then can't find its anchor —
      // when this fails, fall through to the guarded close+restore path below.
      const renderedBookId = document.querySelector('main.main-content[data-slug]')?.id || null;
      const savedStackBookId = history.state?.containerStackBookId || null;
      const bookMatches = !!renderedBookId && (!savedStackBookId || savedStackBookId === renderedBookId);

      if (bottomMatches && bookMatches) {
        // Back by exactly one
        if (currentDepth > 0 && savedDepth === currentDepth - 1) {
          verbose.nav(`📚 [popstate] Fast-path BACK: popping top layer (${currentDepth} → ${savedDepth})`, '/navigation/LinkNavigationHandler.js');
          recordNavDecision({ phase: 'branch', branch: 'fast-back', hash: window.location.hash, currentDepth, savedDepth });
          await popTopLayer();
          return;
        }
        // Forward by exactly one — saved stack has one more layer than current,
        // and the bottom layers already match. Just restore that new top.
        if (savedDepth === currentDepth + 1) {
          const newTopMeta = capturedStack[currentDepth]?.contentMetadata;
          if (newTopMeta?.contentTypes?.length) {
            const { restoreStackedLayer, restoreHyperlitContainerFromHistory, deriveMainAnchorId } = await import('../../hyperlitContainer/history');
            verbose.nav(`📚 [popstate] Fast-path FORWARD: pushing new top layer (${currentDepth} → ${savedDepth})`, '/navigation/LinkNavigationHandler.js');
            // 0 → 1 opens the BASE #hyperlit-container, not a stacked layer.
            // restoreStackedLayer here would createStackedContainerDOM(0) — a
            // dynamic `.hyperlit-container-stacked[data-layer=0]` masquerading
            // as the base. closeHyperlitContainer's unwind (`while depth > 1`)
            // never pops that bottom entry's DOM (clear() drops the entry
            // only), leaving zombie container+overlay nodes for the safety
            // sweep to reap — the state↔DOM desync seen in nested back/forward
            // walks. Route depth 0 through the base-container restore instead.
            const ok = currentDepth === 0
              ? await restoreHyperlitContainerFromHistory(newTopMeta)
              : await restoreStackedLayer(newTopMeta);
            if (ok) {
              // Opening the BASE container (0 → 1) over the main page: scroll the reader to the
              // container's anchor (hypercite/highlight in main), same as restoreContainerStack does
              // for the full path. Without this the fast-path forward leaves the reader at the top
              // with a container hovering over unrelated content.
              if (currentDepth === 0 && currentLazyLoader) {
                try {
                  const anchorId = deriveMainAnchorId(newTopMeta);
                  if (anchorId) {
                    verbose.nav(`📚 [popstate] Fast-path FORWARD scrolling main to anchor "${anchorId}"`, '/navigation/LinkNavigationHandler.js');
                    recordNavDecision({ phase: 'branch', branch: 'fast-forward', hash: window.location.hash, anchorId });
                    navigateToInternalId(anchorId, currentLazyLoader, false);
                  }
                } catch (e) { /* non-fatal */ }
              }
              return;
            }
            verbose.nav('Fast-path FORWARD: restoreStackedLayer returned false, falling back', '/navigation/LinkNavigationHandler.js');
          }
        }
      }
    } catch (e) {
      verbose.nav('Fast-path one-level transition failed, falling back to full close+restore:', '/navigation/LinkNavigationHandler.js', e as any);
    }

    // Close any open container silently — the browser has already restored the URL via popstate
    try {
      await closeHyperlitContainer(true);
    } catch (e) { /* ignore */ }

    // Container stack restoration — if we captured a serialized stack, restore it
    if (capturedStack?.length > 0) {
      try {
        const { restoreContainerStack } = await import('../../hyperlitContainer/history');
        // restoreContainerStack now scrolls the main reader to the container's metadata anchor
        // (works whether or not the URL has a hash — most container URLs carry only ?cs=N).
        recordNavDecision({ phase: 'branch', branch: 'close+restoreStack', hash: window.location.hash, capturedStackDepth: capturedStack.length });
        await restoreContainerStack(capturedStack, { callsite: 'LinkNavigationHandler.popstate' });
        return;
      } catch (error) {
        log.error('Failed to restore container stack from history.state', '/navigation/LinkNavigationHandler.js', error);
      }
    }

    // Check URL path for cascade segments (HL_ / Fn patterns)
    const pathSegments = window.location.pathname.split('/').filter(Boolean);
    const hlSegment = pathSegments.find((p: any) => p.startsWith('HL_'));
    const fnSegment = pathSegments.find((p: any) => p.includes('_Fn') || /^Fn\d/.test(p));
    const hasCascade = !!(hlSegment || fnSegment);

    if (hasCascade && currentLazyLoader) {
      // Rebuild nested container chain from URL
      verbose.nav(`Popstate: rebuilding cascade from URL segments`, '/navigation/LinkNavigationHandler.js', { hlSegment, fnSegment } as any);
      try {
        const chain = await buildChainFromUrl(pathSegments[0] as any, pathSegments);
        if (chain && chain.length > 0) {
          const hyperciteHash = window.location.hash ? window.location.hash.substring(1) : null;
          const finalHash = (hyperciteHash && hyperciteHash.startsWith('hypercite_')) ? hyperciteHash : null;
          recordNavDecision({ phase: 'branch', branch: 'cascade-openChain', hash: window.location.hash, chainLen: chain.length });
          await openContainerChain(chain, currentLazyLoader, finalHash);
          return;
        }
      } catch (error) {
        log.error('Failed to rebuild cascade from URL', '/navigation/LinkNavigationHandler.js', error);
      }
    }

    // Fall back to simple hash scroll on the main page if one exists.
    if (window.location.hash) {
      const targetId = window.location.hash.substring(1);
      verbose.nav(`Popstate: navigating to hash #${targetId} on main page`, '/navigation/LinkNavigationHandler.js');
      recordNavDecision({ phase: 'branch', branch: 'hash-internalNav', hash: window.location.hash, targetId });
      try {
        if (currentLazyLoader) {
          navigateToInternalId(targetId, currentLazyLoader, false);
        }
      } catch (error) {
        log.error('Failed to navigate to hash', '/navigation/LinkNavigationHandler.js', error);
      }
    } else {
      // No hash, no container stack, no cascade: nothing scrolls — the closed container
      // reveals whatever physical scroll position the reader held underneath.
      recordNavDecision({ phase: 'branch', branch: 'none-physical' });
    }
  }

  /**
   * Check if a hash represents hyperlit content
   */
  static isHyperlitContentHash(hash: any) {
    if (!hash) return false;
    
    // Check for hyperlit content patterns
    return hash.startsWith('hypercite_') ||
           hash.startsWith('HL_') ||
           hash.startsWith('footnote_') ||
           hash.startsWith('citation_');
  }

  /**
   * Check if a path is a book page URL
   */
  static isBookPageUrl(path: any) {
    // Match patterns like /book-slug/edit or /book-slug/
    return /^\/[^\/]+\/(edit|reader)?(\?.*)?$/.test(path) || /^\/[^\/]+\/?$/.test(path);
  }

  /**
   * Extract book slug from path
   * Handles /u/{username} pattern for user pages
   */
  /**
   * Rewrite a link URL to preserve the current URL's book segment (slug).
   * Link hrefs contain the raw book ID (from citedIN), but we want the URL
   * bar to keep showing the slug when navigating within the same book.
   */
  static preserveSlugInUrl(linkUrl: any) {
    const currentSegment = window.location.pathname.split('/').filter(Boolean)[0] || '';
    const linkSegments = linkUrl.pathname.split('/').filter(Boolean);
    // Replace the first segment (book ID) with the current URL's segment (slug)
    linkSegments[0] = currentSegment;
    return '/' + linkSegments.join('/') + (linkUrl.search || '') + (linkUrl.hash || '');
  }

  static extractBookSlugFromPath(path: any) {
    const segments = path.split('/').filter(Boolean);

    // /u/{username} → extract username as book ID
    if (segments[0] === 'u' && segments.length >= 2) {
      return segments[1];
    }

    // Standalone sub-book routes (e.g., /Accumulation/AIreview)
    if (segments.length >= 2 && segments[1] === 'AIreview') {
      return `${segments[0]}/${segments[1]}`;
    }

    // /{book} → extract first segment
    return segments[0] || null;
  }

  /**
   * Check if a path is a hyperlight URL
   */
  static isHyperlightUrl(pathname: any) {
    // Check if path matches /book/HL_something pattern
    return /\/[^\/]+\/HL_/.test(pathname);
  }

  /**
   * Extract book path from hyperlight URL
   */
  static extractBookPathFromHyperlightUrl(pathname: any) {
    // Extract /book from /book/HL_something
    const match = pathname.match(/^(\/[^\/]+)\/HL_/);
    return match ? match[1] : pathname;
  }

  /**
   * Track recent link clicks (for mobile handling)
   */
  static recentLinkClick = false;

  static trackRecentLinkClick = () => {
    LinkNavigationHandler.recentLinkClick = true;
    setTimeout(() => {
      LinkNavigationHandler.recentLinkClick = false;
    }, 1000);
  };

  /**
   * Get subdomain from hostname
   * Returns null for main domain, username for user subdomains
   */
  static getSubdomain(hostname = window.location.hostname) {
    return getSubdomain(hostname);
  }

  /**
   * Check if URL is on a user subdomain
   */
  static isUserSubdomain(url = window.location.href) {
    const parsedUrl = new URL(url, window.location.origin);
    return this.getSubdomain(parsedUrl.hostname) !== null;
  }

  /**
   * Determine template type based on subdomain and path
   * Returns 'home' or 'reader'
   */
  static getTemplateType(url = window.location.href) {
    const parsedUrl = new URL(url, window.location.origin);
    const subdomain = this.getSubdomain(parsedUrl.hostname);
    const path = parsedUrl.pathname;

    // User subdomain root (sam.hyperlit.test/) uses home.blade.php
    if (subdomain && path === '/') {
      return 'home';
    }

    // Main domain root (hyperlit.test/) uses home.blade.php
    if (!subdomain && path === '/') {
      return 'home';
    }

    // Everything else uses reader.blade.php
    return 'reader';
  }

  /**
   * Check if navigation is between different templates
   */
  static isDifferentTemplate(fromUrl: any, toUrl: any) {
    const fromTemplate = this.getTemplateType(fromUrl);
    const toTemplate = this.getTemplateType(toUrl);
    return fromTemplate !== toTemplate;
  }

  /**
   * Get book ID from URL based on subdomain context and path pattern
   */
  static getBookIdFromUrl(url = window.location.href) {
    return getBookIdFromUrl(url);
  }

  /**
   * Get page structure type based on DOM elements
   * Returns 'reader', 'home', or 'user'
   * @deprecated Use getPageStructure from structureDetection.js instead
   */
  static getPageStructure() {
    return getPageStructure();
  }

  /**
   * Check if two structures are compatible for content-only transitions
   * Only exact same structures are compatible (home and user have different buttons)
   * @deprecated Use areStructuresCompatible from structureDetection.js instead
   */
  static areStructuresCompatible(structure1: any, structure2: any) {
    return areStructuresCompatible(structure1, structure2);
  }
}

// Register the content link-click handler so lazyLoader can delegate without a
// static lazyLoader→navigation import (see utilities/linkClickRegistry).
registerLinkClickHandler((event: any) => LinkNavigationHandler.handleLinkClick(event));

// Register global link-handler attach/remove into the navigation leaf so viewManager can
// drive them without a dynamic viewManager→LinkNavigationHandler import (see navigationRegistry).
registerNavActions({
  attachGlobalLinkClickHandler: () => LinkNavigationHandler.attachGlobalLinkClickHandler(),
  removeGlobalHandlers: () => LinkNavigationHandler.removeGlobalHandlers(),
});
