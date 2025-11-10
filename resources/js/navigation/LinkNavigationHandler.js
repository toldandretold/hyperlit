/**
 * LinkNavigationHandler - Manages intelligent link navigation routing
 * Determines which navigation pathway to use based on link types and context
 */
import { NavigationManager } from './NavigationManager.js';
import { BookToBookTransition } from './pathways/BookToBookTransition.js';

export class LinkNavigationHandler {
  static globalLinkClickHandler = null;
  static globalVisibilityHandler = null;
  static globalFocusHandler = null;
  static globalPopstateHandler = null;
  static isReloading = false;


  /**
   * Attach global link click handler for intelligent navigation
   */
  static attachGlobalLinkClickHandler() {
    // Remove existing handlers if they exist
    this.removeGlobalHandlers();
    // Reset reload flag when handlers are attached (page is loaded)
    this.isReloading = false;
    this.globalLinkClickHandler = (event) => {
      this.handleLinkClick(event);
    };

    this.globalVisibilityHandler = () => {
      this.handleVisibilityChange();
    };

    this.globalFocusHandler = () => {
      this.handlePageFocus();
    };

    this.globalPopstateHandler = (event) => {
      this.handlePopstate(event);
    };

    // Add all the event listeners (except click - now handled by lazyLoaderFactory)
    document.addEventListener('click', this.trackRecentLinkClick);
    document.addEventListener('visibilitychange', this.globalVisibilityHandler);
    window.addEventListener('focus', this.globalFocusHandler);
    window.addEventListener('popstate', this.globalPopstateHandler);

    console.log('🔗 LinkNavigationHandler: Global link handling attached');
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

    console.log('🧹 LinkNavigationHandler: Global handlers removed');
  }

  /**
   * Handle individual link clicks with intelligent routing
   */
  static async handleLinkClick(event) {
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
      console.log('🔗 LinkNavigationHandler: Intercepted link for SPA routing.', link.href);

      // --- ASYNCHRONOUS PROCESSING ---
      // Now that the default navigation is stopped, we can perform async operations.
      try {
        const { book } = await import('../app.js');
        const currentBookPath = `/${book}`;

        if (this.isSameBookNavigation(linkUrl, currentUrl, currentBookPath)) {
          await this.handleSameBookNavigation(link, linkUrl);
        } else if (this.isDifferentBookNavigation(linkUrl, currentBookPath)) {
          await this.handleBookToBookNavigation(link, linkUrl);
        } else {
          // This case should not be reached if logic is correct, but as a fallback:
          console.log(`🔗 LinkNavigationHandler: Link was not routed, falling back to full navigation.`);
          window.location.href = link.href;
        }
      } catch (error) {
        console.error('❌ SPA navigation failed, falling back to full navigation:', error);
        window.location.href = link.href;
      }
    }
  }

  /**
   * Check if we should skip handling this link
   */
  static shouldSkipLinkHandling(link, linkUrl, currentUrl) {
    // Skip hypercites and TOC links - they have their own handlers
    const isHypercite = link.closest('u.couple, u.poly') || link.classList.contains('hypercite-target');
    const isTocLink = link.closest('#toc-container');
    
    if (isHypercite || isTocLink) {
      // But show progress for cross-book hypercites
      if (isHypercite) {
        this.handleHyperciteProgress(linkUrl);
      }
      return true;
    }

    return false;
  }

  /**
   * Handle progress display for cross-book hypercites
   */
  static async handleHyperciteProgress(linkUrl) {
    try {
      const { book } = await import('../app.js');
      const currentBookPath = `/${book}`;

      // Check if it's a cross-book hypercite
      if (linkUrl.origin === window.location.origin && !linkUrl.pathname.startsWith(currentBookPath)) {
        const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
        const targetBookId = pathSegments[0] || 'book';
        
        console.log(`[PROGRESS-FIX] Cross-book hypercite detected. Showing progress for ${targetBookId}.`);
        
        const { ProgressManager } = await import('./ProgressManager.js');
        ProgressManager.showBookToBookTransition(5, `Loading ${targetBookId}...`, targetBookId);
      }
    } catch (error) {
      console.warn('Could not handle hypercite progress:', error);
    }
  }

  /**
   * Check if this is same-book navigation
   */
  static isSameBookNavigation(linkUrl, currentUrl, currentBookPath) {
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
    const isSameBookNavigation = (currentBasePath === linkBasePath) || 
      (currentPathIsHyperlight && targetPathIsBook && currentBasePath === currentBookPath) ||
      (linkUrl.pathname.startsWith(currentBookPath) && linkUrl.hash !== '');
    
    return isSamePageAnchor || isSameBookNavigation;
  }

  /**
   * Check if this is different book navigation
   */
  static isDifferentBookNavigation(linkUrl, currentBookPath) {
    // Extract base book path if current URL is a hyperlight URL
    const linkBasePath = this.isHyperlightUrl(linkUrl.pathname) ? 
      this.extractBookPathFromHyperlightUrl(linkUrl.pathname) : 
      linkUrl.pathname;
      
    return linkBasePath && !linkBasePath.startsWith(currentBookPath);
  }

  /**
   * Handle same-book navigation (anchors, internal links)
   */
  static async handleSameBookNavigation(link, linkUrl) {
    console.log(`🔗 LinkNavigationHandler: Same-book navigation to ${link.href}`);
    
    try {
      // Check if this is a hyperlight URL pattern
      const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
      const isHyperlightURL = pathSegments.length > 1 && pathSegments[1].startsWith('HL_');
      
      if (isHyperlightURL) {
        const hyperlightId = pathSegments[1];
        const hyperciteId = linkUrl.hash.substring(1);
        
        console.log(`🎯 Same-book hyperlight navigation: ${hyperlightId} -> ${hyperciteId}`);
        
        const { navigateToHyperciteTarget } = await import('../hypercites/index.js');
        const { currentLazyLoader } = await import('../initializePage.js');
        
        if (currentLazyLoader) {
          const url = new URL(link.href);
          
          // Only update URL if we're not already there
          const currentUrl = window.location.pathname + window.location.hash;
          const targetUrl = url.pathname + url.hash;
          if (currentUrl !== targetUrl) {
            console.log(`🔗 Updating URL for same-book hyperlight: ${url.href}`);
            window.history.pushState(null, '', url.href);
          }
          if (hyperciteId) {
            navigateToHyperciteTarget(hyperlightId, hyperciteId, currentLazyLoader);
          } else {
            const { navigateToInternalId } = await import('../scrolling.js');
            navigateToInternalId(hyperlightId, currentLazyLoader, false);
          }
        }
      } else {
        // Regular same-book navigation
        const targetId = linkUrl.hash.substring(1);
        const { navigateToInternalId } = await import('../scrolling.js');
        const { currentLazyLoader } = await import('../initializePage.js');
        
        if (currentLazyLoader) {
          const url = new URL(link.href);
          
          // Only update URL if we're not already there
          const currentUrl = window.location.pathname + window.location.hash;
          const targetUrl = url.pathname + url.hash;
          if (currentUrl !== targetUrl) {
            console.log(`🔗 Updating URL for same-book navigation: ${url.href}`);
            console.log(`🔗 Current URL before update: ${window.location.href}`);
            window.history.pushState(null, '', url.href);
            console.log(`🔗 URL after pushState: ${window.location.href}`);
            console.log(`🔗 History length: ${window.history.length}`);
            
            // DEBUG: Check if something is immediately overriding our URL
            setTimeout(() => {
              console.log(`🔗 URL after 100ms delay: ${window.location.href}`);
            }, 100);
          }
          
          navigateToInternalId(targetId, currentLazyLoader, false);
        }
      }
    } catch (error) {
      console.error('❌ Same-book navigation failed:', error);
    }
  }

  /**
   * Handle book-to-book navigation (now structure-aware using NEW SYSTEM)
   */
  static async handleBookToBookNavigation(link, linkUrl) {
    console.log(`🔗 LinkNavigationHandler: Navigation to ${link.href}`);

    try {
      // Detect current and target structures
      const currentStructure = this.getPageStructure();
      const currentBookId = this.getBookIdFromUrl(window.location.href);
      const targetBookId = this.getBookIdFromUrl(linkUrl.href);

      console.log(`📊 Navigation context:`, {
        currentStructure,
        currentBookId,
        targetBookId,
        linkUrl: linkUrl.href
      });

      const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
      const targetHash = linkUrl.hash;

      // Check if this is a hyperlight URL
      const isHyperlightURL = pathSegments.length > 1 && pathSegments[1].startsWith('HL_');

      if (isHyperlightURL) {
        const hyperlightId = pathSegments[1];
        const hyperciteId = targetHash.substring(1);

        console.log(`🎯 Cross-book hyperlight navigation: ${targetBookId}/${hyperlightId}${targetHash}`);

        // Use structure-aware navigation for hyperlight URLs
        await NavigationManager.navigateByStructure({
          toBook: targetBookId,
          targetUrl: linkUrl.href,
          hash: targetHash,
          hyperlightId,
          hyperciteId: hyperciteId || null
        });
        return;
      }

      // Use NEW structure-aware navigation system
      console.log(`✨ Using structure-aware navigation: ${currentStructure} → [detecting target]`);

      await NavigationManager.navigateByStructure({
        fromBook: currentBookId,
        toBook: targetBookId,
        targetUrl: linkUrl.href,
        hash: targetHash
      });

    } catch (error) {
      console.error('❌ Navigation failed:', error);
      // Fallback to full page navigation
      window.location.href = link.href;
    }
  }

  /**
   * Handle visibility changes (for overlay management)
   */
  static handleVisibilityChange() {
    if (!document.hidden && !this.recentLinkClick) {
      console.log('🔗 LinkNavigationHandler: Visibility change - clearing overlay');
      
      import('../scrolling.js').then(({ hideNavigationLoading }) => {
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
    import('../scrolling.js').then(({ hideNavigationLoading }) => {
      hideNavigationLoading();
    }).catch(() => {
      // Ignore if not available
    });
  }

  /**
   * Handle browser back/forward navigation
   */
  static async handlePopstate(event) {
    // Prevent reload loops
    if (this.isReloading) {
      console.log('🔗 LinkNavigationHandler: Already reloading, ignoring popstate');
      return;
    }

    console.log('🔗 LinkNavigationHandler: Browser navigation detected (back/forward)');
    console.log('📊 Popstate event details:', {
      state: event.state,
      currentURL: window.location.href,
      historyLength: window.history.length,
      hasHash: !!window.location.hash,
      hash: window.location.hash
    });

    // 🚀 CRITICAL: Clear saved scroll positions when navigating with hash to prevent interference
    if (window.location.hash) {
      console.log(`🧹 POPSTATE: Clearing saved scroll positions because hash present: ${window.location.hash}`);
      const { getLocalStorageKey } = await import('../indexedDB/index.js');
      const { book: currentBookVariable } = await import('../app.js');
      const scrollKey = getLocalStorageKey("scrollPosition", currentBookVariable);
      sessionStorage.removeItem(scrollKey);
      // Don't clear localStorage - only session storage to prevent this navigation's interference

      // 🚀 CRITICAL: Clear the "navigatedToHash" flag so back/forward buttons work
      // When user presses back/forward, we ALWAYS want to navigate to the hash
      if (window.history.state && window.history.state.navigatedToHash) {
        console.log(`🧹 POPSTATE: Clearing navigatedToHash flag for fresh navigation`);
        window.history.replaceState(
          { ...window.history.state, navigatedToHash: null },
          '',
          window.location.href
        );
      }
    }

    // Check if we need to navigate between different content using SPA transitions
    const { book: currentBookVariable } = await import('../app.js');
    const urlBookId = this.extractBookSlugFromPath(window.location.pathname);

    // If the URL book doesn't match the current loaded book content, use SPA navigation
    if (urlBookId !== currentBookVariable) {
      console.log(`🔙 Back button: URL shows ${urlBookId} but content is ${currentBookVariable}. Using structure-aware navigation.`);

      // Use NEW structure-aware navigation system
      const { NavigationManager } = await import('./NavigationManager.js');
      await NavigationManager.navigateByStructure({
        fromBook: currentBookVariable,
        toBook: urlBookId,
        targetUrl: window.location.pathname,
        hash: window.location.hash
      });
      return;
    }
    
    // Check if this is a hyperlight URL that needs special handling
    const currentPath = window.location.pathname;
    const currentHash = window.location.hash.substring(1); // Remove #
    
    if (this.isHyperlightUrl(currentPath) && currentHash) {
      console.log(`🎯 Back button with hyperlight URL: ${currentPath} -> ${currentHash}`);
      
      try {
        // Extract hyperlight ID from path
        const pathSegments = currentPath.split('/').filter(Boolean);
        const hyperlightId = pathSegments.find(segment => segment.startsWith('HL_'));
        
        if (hyperlightId) {
          console.log(`🎯 Restoring hyperlight container: ${hyperlightId} with target: ${currentHash}`);
          
          // Use the existing hyperlight navigation system
          const { navigateToHyperciteTarget } = await import('../hypercites/index.js');
          const { currentLazyLoader } = await import('../initializePage.js');
          
          if (currentLazyLoader && currentHash.startsWith('hypercite_')) {
            navigateToHyperciteTarget(hyperlightId, currentHash, currentLazyLoader);
            return; // Successfully handled
          }
        }
      } catch (error) {
        console.warn('Failed to handle hyperlight URL in popstate:', error);
      }
    }
    
    // Try to restore container state from history for non-hyperlight URLs
    try {
      const { restoreHyperlitContainerFromHistory } = await import('../hyperlitContainer/index.js');
      const containerRestored = await restoreHyperlitContainerFromHistory();
      
      if (containerRestored) {
        console.log('✅ Successfully restored hyperlit container from browser history');
        return; // Don't need to do anything else if container was restored
      }
    } catch (error) {
      console.warn('Failed to restore hyperlit container from history:', error);
    }
    
    // If no container to restore, close any open containers and scroll to the hash if present.
    // This prevents a loop where a container is re-opened from the hash after a back navigation.
    try {
      const { closeHyperlitContainer } = await import('../hyperlitContainer/index.js');
      closeHyperlitContainer();
    } catch (error) {
      // ignore
    }
    
    // Always attempt to scroll to the hash on the main page if one exists.
    if (window.location.hash) {
      const targetId = window.location.hash.substring(1);
      console.log(`🎯 Popstate with no state: navigating to hash #${targetId} on main page.`);
      try {
        const { navigateToInternalId } = await import('../scrolling.js');
        const { currentLazyLoader } = await import('../initializePage.js');
        if (currentLazyLoader) {
          navigateToInternalId(targetId, currentLazyLoader, false);
        }
      } catch (error) {
        console.warn('Failed to navigate to hash:', error);
      }
    }
  }

  /**
   * Check if a hash represents hyperlit content
   */
  static isHyperlitContentHash(hash) {
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
  static isBookPageUrl(path) {
    // Match patterns like /book-slug/edit or /book-slug/
    return /^\/[^\/]+\/(edit|reader)?(\?.*)?$/.test(path) || /^\/[^\/]+\/?$/.test(path);
  }

  /**
   * Extract book slug from path
   * Handles /u/{username} pattern for user pages
   */
  static extractBookSlugFromPath(path) {
    const segments = path.split('/').filter(Boolean);

    // /u/{username} → extract username as book ID
    if (segments[0] === 'u' && segments.length >= 2) {
      return segments[1];
    }

    // /{book} → extract first segment
    return segments[0] || null;
  }

  /**
   * Check if a path is a hyperlight URL
   */
  static isHyperlightUrl(pathname) {
    // Check if path matches /book/HL_something pattern
    return /\/[^\/]+\/HL_/.test(pathname);
  }

  /**
   * Extract book path from hyperlight URL
   */
  static extractBookPathFromHyperlightUrl(pathname) {
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
    // Handle localhost and IP addresses
    if (hostname === 'localhost' || hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      return null;
    }

    const parts = hostname.split('.');

    // For hyperlit.test, no subdomain
    // For sam.hyperlit.test, subdomain is 'sam'
    if (parts.length > 2) {
      return parts[0];
    }

    return null;
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
  static isDifferentTemplate(fromUrl, toUrl) {
    const fromTemplate = this.getTemplateType(fromUrl);
    const toTemplate = this.getTemplateType(toUrl);
    return fromTemplate !== toTemplate;
  }

  /**
   * Get book ID from URL based on subdomain context and path pattern
   */
  static getBookIdFromUrl(url = window.location.href) {
    const parsedUrl = new URL(url, window.location.origin);
    const subdomain = this.getSubdomain(parsedUrl.hostname);
    const path = parsedUrl.pathname;

    // User subdomain root = username is the book
    if (subdomain && path === '/') {
      return subdomain;
    }

    // Main domain root = most-recent
    if (!subdomain && path === '/') {
      return 'most-recent';
    }

    const pathSegments = path.split('/').filter(Boolean);

    // /u/{username} → username is the book
    if (pathSegments[0] === 'u' && pathSegments.length >= 2) {
      return pathSegments[1];
    }

    // /{book} or /{book}/HL_xxx → first segment is the book
    return pathSegments[0] || 'most-recent';
  }

  /**
   * Get page structure type based on DOM elements
   * Returns 'reader', 'home', or 'user'
   */
  static getPageStructure() {
    if (document.querySelector('.reader-content-wrapper')) {
      return 'reader';
    }
    if (document.querySelector('.home-content-wrapper')) {
      return 'home';
    }
    if (document.querySelector('.user-content-wrapper')) {
      return 'user';
    }

    // Fallback to data-page attribute
    const pageType = document.body.getAttribute('data-page');
    if (pageType) {
      return pageType;
    }

    console.warn('⚠️ Could not determine page structure, defaulting to reader');
    return 'reader';
  }

  /**
   * Check if two structures are compatible for content-only transitions
   * Only exact same structures are compatible (home and user have different buttons)
   */
  static areStructuresCompatible(structure1, structure2) {
    // ONLY exact same structure is compatible
    // home and user are NOT compatible despite similar layouts (different buttons)
    return structure1 === structure2;
  }
}