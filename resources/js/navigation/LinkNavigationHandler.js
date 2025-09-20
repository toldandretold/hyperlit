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
    // Find the closest anchor tag
    const link = event.target.closest('a');
    
    if (!link || !link.href) return;

    const linkUrl = new URL(link.href, window.location.origin);
    const currentUrl = new URL(window.location.href);

    // Skip handling for special link types
    if (this.shouldSkipLinkHandling(link, linkUrl, currentUrl)) {
      return;
    }

    // Check if it's a true external link
    if (linkUrl.origin !== currentUrl.origin) {
      console.log(`🔗 LinkNavigationHandler: Allowing external navigation to ${linkUrl.href}`);
      return;
    }

    // Get current book context
    const { book } = await import('../app.js');
    const currentBookPath = `/${book}`;

    // Handle same-book navigation
    if (this.isSameBookNavigation(linkUrl, currentUrl, currentBookPath)) {
      event.preventDefault();
      await this.handleSameBookNavigation(link, linkUrl);
      return;
    }

    // Handle book-to-book navigation
    if (this.isDifferentBookNavigation(linkUrl, currentBookPath)) {
      event.preventDefault();
      await this.handleBookToBookNavigation(link, linkUrl);
      return;
    }

    // Let other links proceed normally
    console.log(`🔗 LinkNavigationHandler: Allowing normal navigation to ${link.href}`);
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
    const isSameBookNavigation = linkUrl.pathname.startsWith(currentBookPath) && linkUrl.hash !== '';
    
    return isSamePageAnchor || isSameBookNavigation;
  }

  /**
   * Check if this is different book navigation
   */
  static isDifferentBookNavigation(linkUrl, currentBookPath) {
    return linkUrl.pathname && !linkUrl.pathname.startsWith(currentBookPath);
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
          if (currentUrl !== url.href) {
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
          if (currentUrl !== url.href) {
            console.log(`🔗 Updating URL for same-book navigation: ${url.href}`);
            window.history.pushState(null, '', url.href);
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
        await NavigationManager.navigate('book-to-home', { fromBook });
        
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

    // Simplified approach: check if we need to reload based on URL vs current content
    const { book: currentBookVariable } = await import('../app.js');
    const urlBookId = this.extractBookSlugFromPath(window.location.pathname);
    
    // If the URL book doesn't match the current loaded book content, reload
    if (urlBookId !== currentBookVariable) {
      console.log(`URL shows ${urlBookId} but content is ${currentBookVariable}. Reloading.`);
      this.isReloading = true;
      window.location.reload();
      return;
    }
    
    // Same book - close any open containers and navigate to hash if present
    try {
      const { closeHyperlitContainer } = await import('../unified-container.js');
      closeHyperlitContainer();
    } catch (error) {
      // ignore
    }
    
    // Navigate to hash if present
    if (window.location.hash) {
      const targetId = window.location.hash.substring(1);
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