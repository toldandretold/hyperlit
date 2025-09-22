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
        
        const { navigateToHyperciteTarget } = await import('../hyperCites.js');
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
   * Handle book-to-book navigation
   */
  static async handleBookToBookNavigation(link, linkUrl) {
    console.log(`🔗 LinkNavigationHandler: Book-to-book navigation to ${link.href}`);
    
    try {
      const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
      const targetBookId = pathSegments[0];
      const targetHash = linkUrl.hash;

      // Handle homepage navigation using SPA pathway
      if (!targetBookId && (linkUrl.pathname === '/' || linkUrl.pathname === '')) {
        console.log('🏠 Homepage navigation detected - using book-to-home SPA pathway');
        
        event.preventDefault();
        event.stopPropagation();
        
        // Get current book for context
        const currentPageType = document.body.getAttribute('data-page');
        const fromBook = currentPageType === 'reader' ? window.book : null;
        
        // Use the book-to-home SPA pathway
        const { NavigationManager } = await import('./NavigationManager.js');
        await NavigationManager.navigate('book-to-home', { fromBook, replaceHistory: true });
        
        return true;
      }
      // Check if this is a hyperlight URL
      const isHyperlightURL = pathSegments.length > 1 && pathSegments[1].startsWith('HL_');
      
      if (isHyperlightURL) {
        const hyperlightId = pathSegments[1];
        const hyperciteId = targetHash.substring(1);
        
        console.log(`🎯 Cross-book hyperlight navigation: ${targetBookId}/${hyperlightId}${targetHash}`);
        
        await BookToBookTransition.handleHyperlightNavigation({
          toBook: targetBookId,
          hyperlightId,
          hyperciteId: hyperciteId || null
        });
      } else if (targetBookId) {
        // Check current page type to determine the correct transition pathway
        const currentPageType = document.body.getAttribute('data-page');
        
        if (currentPageType === 'home') {
          console.log(`🏠➡️📖 Home-to-book navigation: ${targetBookId}${targetHash}`);
          
          await NavigationManager.navigate('home-to-book', {
            toBook: targetBookId,
            hash: targetHash
          });
        } else {
          console.log(`🎯 Standard book-to-book navigation: ${targetBookId}${targetHash}`);
          
          await NavigationManager.navigate('book-to-book', {
            toBook: targetBookId,
            hash: targetHash
          });
        }
      } else {
        console.warn('Could not determine target book ID for navigation');
        window.location.href = link.href;
      }
    } catch (error) {
      console.error('❌ Book-to-book navigation failed:', error);
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
      historyLength: window.history.length
    });

    // Check if we need to navigate between different content using SPA transitions
    const { book: currentBookVariable } = await import('../app.js');
    const urlBookId = this.extractBookSlugFromPath(window.location.pathname);
    
    // If the URL book doesn't match the current loaded book content, use SPA navigation
    if (urlBookId !== currentBookVariable) {
      console.log(`URL shows ${urlBookId} but content is ${currentBookVariable}. Using SPA navigation.`);
      
      // Determine which type of SPA transition to use
      if (!urlBookId || urlBookId === 'most-recent') {
        // Navigate to homepage
        console.log('🏠 Using BookToHomeTransition for back navigation to home');
        const { BookToHomeTransition } = await import('./pathways/BookToHomeTransition.js');
        await BookToHomeTransition.execute({ fromBook: currentBookVariable });
      } else {
        // Navigate to different book
        console.log(`📖 Using BookToBookTransition for back navigation: ${currentBookVariable} → ${urlBookId}`);
        const { BookToBookTransition } = await import('./pathways/BookToBookTransition.js');
        await BookToBookTransition.execute({ 
          fromBook: currentBookVariable, 
          toBook: urlBookId, 
          hash: window.location.hash 
        });
      }
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
          const { navigateToHyperciteTarget } = await import('../hyperCites.js');
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
      const { restoreHyperlitContainerFromHistory } = await import('../unified-container.js');
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
      const { closeHyperlitContainer } = await import('../unified-container.js');
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
   */
  static extractBookSlugFromPath(path) {
    const match = path.match(/^\/([^\/]+)/);
    return match ? match[1] : null;
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
}