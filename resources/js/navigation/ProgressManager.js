/**
 * ProgressManager - Centralized progress bar management for all navigation pathways
 * Handles the different types of progress overlays and loading states
 */
export class ProgressManager {
  static progressElement = null;
  static overlayElement = null;
  static progressBarElement = null;
  static progressTextElement = null;
  static progressDetailsElement = null;
  static _isHidingInProgress = false;

  /**
   * Initialize progress elements (lazy loading)
   */
  static initializeElements() {
    if (!this.progressElement) {
      this.overlayElement = document.getElementById('initial-navigation-overlay');
      this.progressBarElement = document.getElementById('page-load-progress-bar');
      this.progressTextElement = document.getElementById('page-load-progress-text');
      this.progressDetailsElement = document.getElementById('page-load-progress-details');
    }
  }

  /**
   * Show progress for initial page loads (pathway 1)
   * Uses the full overlay system
   */
  static showInitialPageLoad(percent = 5, message = 'Loading...') {
    this.initializeElements();
    
    if (this.overlayElement) {
      this.overlayElement.style.display = 'block';
      this.overlayElement.style.visibility = 'visible';
      // Ensure overlay doesn't block browser navigation events
      this.overlayElement.style.pointerEvents = 'none';
    }
    
    this.updateProgress(percent, message);
    console.log(`📊 Initial page load progress: ${percent}% - ${message}`);
  }

  /**
   * Show progress for SPA transitions (pathways 2, 3, 4)
   * More lightweight, preserves existing UI elements
   */
  static showSPATransition(percent = 5, message = 'Loading...') {
    this.initializeElements();
    
    // For SPA transitions, ensure overlay is visible but don't disrupt existing state
    if (this.overlayElement && this.overlayElement.style.display === 'none') {
      this.overlayElement.style.display = 'block';
      this.overlayElement.style.visibility = 'visible';
      // Ensure overlay doesn't block browser navigation events
      this.overlayElement.style.pointerEvents = 'none';
    }
    
    this.updateProgress(percent, message);
    console.log(`📊 SPA transition progress: ${percent}% - ${message}`);
  }

  /**
   * Show progress specifically for book-to-book navigation (pathway 4)
   * Handles the case where we're already in reader mode
   */
  static showBookToBookTransition(percent = 5, message = 'Loading...', bookId = null) {
    this.initializeElements();
    
    const displayMessage = bookId ? `Loading ${bookId}...` : message;
    
    // FORCE immediate display - don't wait for dynamic imports
    if (this.overlayElement) {
      this.overlayElement.style.display = 'block';
      this.overlayElement.style.visibility = 'visible';
      // Ensure overlay doesn't block browser navigation events
      this.overlayElement.style.pointerEvents = 'none';
    }
    
    this.updateProgress(percent, displayMessage);
    
    // Try to use navigation loading system as enhancement, but don't wait for it
    import('../scrolling.js').then(({ showNavigationLoading }) => {
      showNavigationLoading(displayMessage);
    }).catch(() => {
      // Already showing progress above, so this is just an enhancement
      console.log('Navigation loading system not available, using standard progress');
    });
    
    console.log(`📊 Book-to-book transition progress: ${percent}% - ${displayMessage}`);
  }

  /**
   * Update progress bar and text
   */
  static updateProgress(percent, message = null) {
    this.initializeElements();
    
    if (this.progressBarElement) {
      // Ensure progress never goes below 5% so we always see some color
      const adjustedPercent = Math.max(5, percent);
      this.progressBarElement.style.width = adjustedPercent + '%';
    }
    
    if (this.progressTextElement) {
      this.progressTextElement.textContent = `Loading... ${Math.round(percent)}%`;
    }
    
    if (message && this.progressDetailsElement) {
      this.progressDetailsElement.textContent = message;
    }
  }

  /**
   * Hide all progress indicators with smooth completion animation
   */
  static async hide() {
    if (this._isHidingInProgress) {
      console.log('📊 Progress hide already in progress, skipping');
      return;
    }
    this._isHidingInProgress = true;
    
    try {
      this.initializeElements();
      
      // Try to use the centralized hide function first
      try {
        const { hidePageLoadProgress } = await import('../reader-DOMContentLoaded.js');
        await hidePageLoadProgress();
        console.log('📊 Progress hidden via centralized system');
        return;
      } catch (error) {
        console.warn('Could not use centralized progress hiding, using fallback');
      }
      
      // Fallback hiding logic
      await this.hideWithAnimation();
      
      // Also hide navigation loading if active
      try {
        const { hideNavigationLoading } = await import('../scrolling.js');
        hideNavigationLoading();
      } catch (error) {
        // Ignore if scrolling module not available
      }
      
      console.log('📊 Progress hidden via fallback system');
    } finally {
      this._isHidingInProgress = false;
    }
  }

  /**
   * Hide with completion animation (fallback)
   */
  static async hideWithAnimation() {
    if (!this.progressBarElement || !this.overlayElement) return;
    
    // Always do the completion animation for visual satisfaction
    if (this.overlayElement.style.display !== 'none') {
      const currentWidth = parseInt(this.progressBarElement.style.width) || 5;
      
      // Hide text elements before the final animation
      if (this.progressTextElement) this.progressTextElement.style.opacity = '0';
      if (this.progressDetailsElement) this.progressDetailsElement.style.opacity = '0';
      
      // Ensure we get a smooth animation to 100%
      if (currentWidth >= 100) {
        this.progressBarElement.style.width = '90%';
        await new Promise(resolve => setTimeout(resolve, 50));
      } else if (currentWidth < 85) {
        this.progressBarElement.style.width = '85%';
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Complete the animation
      this.progressBarElement.style.width = '100%';
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    
    // Hide the overlay
    if (this.overlayElement) {
      this.overlayElement.style.display = 'none';
      this.overlayElement.style.visibility = 'hidden';
    }
  }

  /**
   * Check if progress is currently visible
   */
  static isVisible() {
    this.initializeElements();
    return this.overlayElement && 
           this.overlayElement.style.display !== 'none' && 
           this.overlayElement.style.visibility !== 'hidden';
  }

  /**
   * Create a progress callback function for use with async operations
   */
  static createProgressCallback(type = 'spa', bookId = null) {
    return (percent, message) => {
      switch (type) {
        case 'initial':
          this.showInitialPageLoad(percent, message);
          break;
        case 'book-to-book':
          this.showBookToBookTransition(percent, message, bookId);
          break;
        case 'spa':
        default:
          this.showSPATransition(percent, message);
          break;
      }
    };
  }
}