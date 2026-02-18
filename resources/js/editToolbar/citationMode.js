// CitationMode - Manages citation search interface integrated into edit toolbar
// Follows the HeadingSubmenu pattern for mode switching

import { formatBibtexToCitation } from "../utilities/bibtexProcessor.js";
import DOMPurify from "dompurify";

export class CitationMode {
  constructor({
    toolbar,
    citationButton,
    citationContainer,
    citationInput,
    citationResults,
    allButtons,
    closeHeadingSubmenuCallback
  }) {
    this.toolbar = toolbar;
    this.citationButton = citationButton;
    this.citationContainer = citationContainer;
    this.citationInput = citationInput;
    this.citationResults = citationResults;
    this.allButtons = allButtons; // Array of all toolbar buttons except citation
    this.closeButton = document.getElementById('citation-close-btn');
    this.closeHeadingSubmenuCallback = closeHeadingSubmenuCallback;

    // State
    this.isOpen = false;
    this.pendingContext = null;
    this.debounceTimer = null;
    this.abortController = null;

    // Touch tracking
    this.touchStartX = null;
    this.touchStartY = null;

    // Bound handlers for cleanup
    this.boundDocumentClickHandler = null;
    this.boundDocumentKeyDownHandler = null;
    this.boundDocumentTouchStartHandler = null;
    this.boundDocumentTouchEndHandler = null;
    this.boundInputHandler = null;
    this.boundResultsScrollHandler = null;
    this.boundCloseButtonHandler = null;
  }

  open(context) {
    if (this.isOpen) return;

    // Close heading submenu if it's open (prevents visual overlap)
    if (this.closeHeadingSubmenuCallback) {
      this.closeHeadingSubmenuCallback();
    }

    this.pendingContext = context;
    this.isOpen = true;
    this.justOpened = true; // Flag to prevent immediate closure

    // Clear flag after 300ms (prevents synthetic click from closing)
    setTimeout(() => {
      this.justOpened = false;
      console.log('✅ Citation mode: Ready for close events');
    }, 300);

    // Add citation mode class to toolbar (CSS will hide other buttons)
    this.toolbar.classList.add('citation-mode-active');

    // Show citation container
    this.citationContainer.classList.remove('hidden');

    // Clear previous state
    this.citationInput.value = '';
    this.citationResults.innerHTML = '';
    this.citationResults.dataset.state = 'hidden';

    // DEBUG: Log container position
    setTimeout(() => {
      const rect = this.citationResults.getBoundingClientRect();
      const computed = window.getComputedStyle(this.citationResults);
      console.log('📏 [HIDDEN] Bottom of results div:', rect.bottom, 'px from top of viewport');
      console.log('📏 [HIDDEN] Height:', rect.height, 'CSS bottom:', computed.bottom, 'CSS max-height:', computed.maxHeight);
    }, 100);

    // MOBILE SCROLL LOCK: Lock window scroll position when citation mode opens
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      this.lockedScrollPosition = window.scrollY || window.pageYOffset || 0;
      console.log(`🔒 Locking scroll position at ${this.lockedScrollPosition}px for citation mode`);
      this.boundScrollLockHandler = () => {
        if (window.scrollY !== this.lockedScrollPosition) {
          console.log(`🔒 Scroll changed to ${window.scrollY}px, forcing back to ${this.lockedScrollPosition}px`);
          window.scrollTo(0, this.lockedScrollPosition);
        }
      };
      window.addEventListener('scroll', this.boundScrollLockHandler, { passive: false });
    }

    // Attach event handlers
    this.attachEventHandlers();

    // Auto-focus on desktop only (mobile causes wild iOS scrolling)
    if (!isMobile) {
      setTimeout(() => {
        this.citationInput.focus();
      }, 100);
    }

    // Update positioning if keyboard is open
    if (window.activeKeyboardManager && window.activeKeyboardManager.isKeyboardOpen) {
      const editToolbar = document.getElementById('edit-toolbar');
      const searchToolbar = document.getElementById('search-toolbar');
      const citationToolbar = document.getElementById('citation-toolbar');
      const bottomRightButtons = document.getElementById('bottom-right-buttons');
      const mainContent = document.querySelector('.main-content');

      window.activeKeyboardManager.moveToolbarAboveKeyboard(
        editToolbar, searchToolbar, citationToolbar, bottomRightButtons, mainContent
      );
    }
  }

  close() {
    // Early return if already closed
    if (!this.isOpen) return;

    this.isOpen = false;
    this.pendingContext = null;

    // Remove citation mode class (CSS will show other buttons)
    this.toolbar.classList.remove('citation-mode-active');

    // Hide citation container
    this.citationContainer.classList.add('hidden');

    // Hide citation results container (fixes dark rectangle bug on iOS)
    this.citationResults.dataset.state = 'hidden';
    this.citationResults.innerHTML = '';

    // MOBILE SCROLL LOCK: Remove scroll lock handler
    if (this.boundScrollLockHandler) {
      console.log('🔓 Unlocking scroll position');
      window.removeEventListener('scroll', this.boundScrollLockHandler);
      this.boundScrollLockHandler = null;
      this.lockedScrollPosition = null;
    }

    // Cancel any pending search
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Detach event handlers
    this.detachEventHandlers();
  }

  attachEventHandlers() {
    // Input handler
    this.boundInputHandler = this.handleSearchInput.bind(this);
    this.citationInput.addEventListener('input', this.boundInputHandler);

    // MOBILE FIX: Intercept touch on citation input to prevent iOS scroll-to-focus
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      this.boundInputTouchHandler = (e) => {
        console.log('📱 Citation input touch - preventing default and manually focusing');
        e.preventDefault(); // Prevent iOS scroll-to-focus behavior
        e.stopPropagation();

        // Manually focus the input without triggering scroll
        this.citationInput.focus({ preventScroll: true });
      };
      this.citationInput.addEventListener('touchend', this.boundInputTouchHandler, { passive: false });
    }

    // Close button handler
    if (this.closeButton) {
      this.boundCloseButtonHandler = () => this.close();
      this.closeButton.addEventListener('click', this.boundCloseButtonHandler);
    }

    // Document click handler (click outside to close)
    this.boundDocumentClickHandler = this.handleDocumentClick.bind(this);
    document.addEventListener('click', this.boundDocumentClickHandler, true);

    // Keyboard handler (ESC to close)
    this.boundDocumentKeyDownHandler = this.handleKeyDown.bind(this);
    document.addEventListener('keydown', this.boundDocumentKeyDownHandler);

    // Touch handlers for mobile
    this.boundDocumentTouchStartHandler = this.handleTouchStart.bind(this);
    this.boundDocumentTouchEndHandler = this.handleTouchEnd.bind(this);
    document.addEventListener('touchstart', this.boundDocumentTouchStartHandler, { passive: true });
    document.addEventListener('touchend', this.boundDocumentTouchEndHandler, { passive: false });

    // Results scroll prevention when not scrollable
    this.boundResultsScrollHandler = this.handleResultsScroll.bind(this);
    this.citationResults.addEventListener('touchstart', this.boundResultsScrollHandler, { passive: false });
  }

  detachEventHandlers() {
    if (this.boundInputHandler) {
      this.citationInput.removeEventListener('input', this.boundInputHandler);
    }
    if (this.boundInputTouchHandler) {
      this.citationInput.removeEventListener('touchend', this.boundInputTouchHandler);
    }
    if (this.boundCloseButtonHandler && this.closeButton) {
      this.closeButton.removeEventListener('click', this.boundCloseButtonHandler);
    }
    if (this.boundDocumentClickHandler) {
      document.removeEventListener('click', this.boundDocumentClickHandler, true);
    }
    if (this.boundDocumentKeyDownHandler) {
      document.removeEventListener('keydown', this.boundDocumentKeyDownHandler);
    }
    if (this.boundDocumentTouchStartHandler) {
      document.removeEventListener('touchstart', this.boundDocumentTouchStartHandler);
    }
    if (this.boundDocumentTouchEndHandler) {
      document.removeEventListener('touchend', this.boundDocumentTouchEndHandler);
    }
    if (this.boundResultsScrollHandler) {
      this.citationResults.removeEventListener('touchstart', this.boundResultsScrollHandler);
    }
  }

  handleSearchInput(event) {
    const query = event.target.value.trim();

    // Cancel previous debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    if (query.length < 2) {
      this.citationResults.innerHTML = '';
      this.citationResults.dataset.state = 'hidden';

      // DEBUG: Log container position
      setTimeout(() => {
        const rect = this.citationResults.getBoundingClientRect();
        const computed = window.getComputedStyle(this.citationResults);
        console.log('📏 [HIDDEN] Bottom of results div:', rect.bottom, 'px from top of viewport');
        console.log('📏 [HIDDEN] Height:', rect.height, 'CSS bottom:', computed.bottom, 'CSS max-height:', computed.maxHeight);
      }, 50);
      return;
    }

    // Show loading state
    this.citationResults.innerHTML = '<div class="citation-search-loading">Searching...</div>';
    this.citationResults.dataset.state = 'loading';
    this.repositionContainer();

    // DEBUG: Log container position
    setTimeout(() => {
      const rect = this.citationResults.getBoundingClientRect();
      const computed = window.getComputedStyle(this.citationResults);
      const toolbar = document.getElementById('edit-toolbar').getBoundingClientRect();
      console.log('📏 [LOADING] Bottom of results div:', rect.bottom, 'px from top');
      console.log('📏 [LOADING] Top of toolbar:', toolbar.top, 'px from top');
      console.log('📏 [LOADING] GAP between results and toolbar:', toolbar.top - rect.bottom, 'px');
      console.log('📏 [LOADING] Height:', rect.height, 'CSS bottom:', computed.bottom, 'CSS max-height:', computed.maxHeight);
    }, 300);

    // Debounce search
    this.debounceTimer = setTimeout(() => {
      this.performSearch(query);
    }, 300);
  }

  async performSearch(query) {
    // Cancel previous request
    if (this.abortController) {
      this.abortController.abort();
    }

    this.abortController = new AbortController();

    try {
      const response = await fetch(`/api/search/combined?q=${encodeURIComponent(query)}&limit=15`, {
        headers: {
          'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content,
        },
        signal: this.abortController.signal
      });

      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      await this.renderResults(data.results || []);

    } catch (error) {
      if (error.name !== 'AbortError') {
        this.citationResults.innerHTML = '<div class="citation-search-empty">Search failed. Please try again.</div>';
        this.citationResults.dataset.state = 'empty';
        this.repositionContainer();

        // DEBUG: Log container position
        setTimeout(() => {
          const rect = this.citationResults.getBoundingClientRect();
          const computed = window.getComputedStyle(this.citationResults);
          const toolbar = document.getElementById('edit-toolbar').getBoundingClientRect();
          console.log('📏 [EMPTY/ERROR] Bottom of results div:', rect.bottom, 'px from top');
          console.log('📏 [EMPTY/ERROR] Top of toolbar:', toolbar.top, 'px from top');
          console.log('📏 [EMPTY/ERROR] GAP between results and toolbar:', toolbar.top - rect.bottom, 'px');
          console.log('📏 [EMPTY/ERROR] Height:', rect.height, 'CSS bottom:', computed.bottom, 'CSS max-height:', computed.maxHeight);
        }, 300);
      }
    }
  }

  repositionContainer() {
    console.log(`🔄 repositionContainer called, state=${this.citationResults?.dataset?.state}, keyboardOpen=${window.activeKeyboardManager?.isKeyboardOpen}`);

    // Trigger keyboard manager to reposition container with new height
    if (window.activeKeyboardManager && window.activeKeyboardManager.isKeyboardOpen) {
      console.log(`✅ Calling moveToolbarAboveKeyboard from repositionContainer`);
      const editToolbar = document.getElementById('edit-toolbar');
      const searchToolbar = document.getElementById('search-toolbar');
      const citationToolbar = document.getElementById('citation-toolbar');
      const bottomRightButtons = document.getElementById('bottom-right-buttons');
      const mainContent = document.querySelector('.main-content');

      window.activeKeyboardManager.moveToolbarAboveKeyboard(
        editToolbar, searchToolbar, citationToolbar, bottomRightButtons, mainContent
      );
    } else {
      console.log(`❌ Skipping reposition: activeKeyboardManager=${!!window.activeKeyboardManager}, isKeyboardOpen=${window.activeKeyboardManager?.isKeyboardOpen}`);
    }
  }

  async renderResults(results) {
    console.log('🔍 renderResults called with', results.length, 'results');
    console.log('🔍 citationResults element:', this.citationResults);
    console.log('🔍 citationResults parent:', this.citationResults?.parentElement);

    if (results.length === 0) {
      console.log('🔍 No results - showing empty state');
      this.citationResults.innerHTML = '<div class="citation-search-empty">No results found</div>';
      this.citationResults.dataset.state = 'empty';
      this.repositionContainer();

      // DEBUG: Log container position
      setTimeout(() => {
        const rect = this.citationResults.getBoundingClientRect();
        const computed = window.getComputedStyle(this.citationResults);
        const toolbar = document.getElementById('edit-toolbar').getBoundingClientRect();
        console.log('📏 [EMPTY] Bottom of results div:', rect.bottom, 'px from top');
        console.log('📏 [EMPTY] Top of toolbar:', toolbar.top, 'px from top');
        console.log('📏 [EMPTY] GAP between results and toolbar:', toolbar.top - rect.bottom, 'px');
        console.log('📏 [EMPTY] Height:', rect.height, 'CSS bottom:', computed.bottom, 'CSS max-height:', computed.maxHeight);
      }, 300);
      return;
    }

    console.log('🔍 Creating buttons for results...');
    // Use Promise.all to await all formatting promises
    const buttons = await Promise.all(results.map(async result => {
      let sanitized;

      if (result.source === 'openalex' || !result.bibtex) {
        // OpenAlex result or library result without bibtex — simple title/author display
        const title = result.title || 'Untitled';
        const meta = [result.author, result.year, result.journal].filter(Boolean).join(', ');
        const raw = `<em>${title}</em>${meta ? ' — ' + meta : ''}`;
        sanitized = DOMPurify.sanitize(raw, {
          ALLOWED_TAGS: ['i', 'em', 'b', 'strong'],
        });
      } else {
        const formattedCitation = await formatBibtexToCitation(result.bibtex);
        sanitized = DOMPurify.sanitize(formattedCitation, {
          ALLOWED_TAGS: ['i', 'em', 'b', 'strong', 'a'],
          ALLOWED_ATTR: ['href', 'target']
        });
      }

      const button = document.createElement('button');
      button.className = 'citation-result-item';
      if (result.source === 'openalex') {
        // OpenAlex results cannot be inserted yet — they have no library entry
        button.classList.add('citation-result-openalex');
        button.disabled = true;
        button.title = 'Not in your library — citation linkage coming soon';
      }
      button.innerHTML = sanitized;
      button.dataset.bookId = result.book || result.id || ''; // Try both book and id
      button.dataset.bibtex = result.bibtex || '';

      return button;
    }));

    console.log('🔍 Clearing results container...');
    this.citationResults.innerHTML = '';
    console.log('🔍 Appending', buttons.length, 'buttons...');
    buttons.forEach(btn => this.citationResults.appendChild(btn));
    this.citationResults.dataset.state = 'results';
    this.repositionContainer();
    console.log('🔍 Done! citationResults.children.length:', this.citationResults.children.length);

    // DEBUG: Log container position
    setTimeout(() => {
      const rect = this.citationResults.getBoundingClientRect();
      const computed = window.getComputedStyle(this.citationResults);
      const toolbar = document.getElementById('edit-toolbar').getBoundingClientRect();
      console.log('📏 [RESULTS] Bottom of results div:', rect.bottom, 'px from top');
      console.log('📏 [RESULTS] Top of toolbar:', toolbar.top, 'px from top');
      console.log('📏 [RESULTS] GAP between results and toolbar:', toolbar.top - rect.bottom, 'px');
      console.log('📏 [RESULTS] Height:', rect.height, 'CSS bottom:', computed.bottom, 'CSS max-height:', computed.maxHeight);
    }, 300);
  }

  handleDocumentClick(event) {
    // Ignore close attempts immediately after opening (prevents synthetic click from closing)
    if (this.justOpened) {
      console.log('🚫 Citation mode: Ignoring close attempt (just opened)');
      return;
    }

    const target = event.target;

    // Check if click is on a result item or inside one (for child elements like <i>, <em>)
    const resultItem = target.closest('.citation-result-item');
    if (resultItem) {
      event.preventDefault();
      event.stopPropagation();
      this.handleCitationSelection(resultItem);
      return;
    }

    // Check if click is inside citation container, results container, citation button, or gap blocker
    const isInsideContainer = this.citationContainer.contains(target);
    const isInsideResults = this.citationResults.contains(target);
    const isOnCitationButton = this.citationButton.contains(target);
    const gapBlocker = document.getElementById('keyboard-gap-blocker');
    const isOnGapBlocker = gapBlocker && (target === gapBlocker || gapBlocker.contains(target));

    if (!isInsideContainer && !isInsideResults && !isOnCitationButton && !isOnGapBlocker) {
      console.log('👋 Citation mode: Closing from outside click');
      this.close();
    } else if (isOnGapBlocker) {
      console.log('🛡️ Citation mode: Ignoring click on gap blocker');
    }
  }

  handleKeyDown(event) {
    if (event.key === 'Escape' && this.isOpen) {
      this.close();
    }
  }

  handleTouchStart(event) {
    this.touchStartX = event.touches[0].clientX;
    this.touchStartY = event.touches[0].clientY;
  }

  handleTouchEnd(event) {
    if (!this.isOpen) return;

    // Ignore close attempts immediately after opening (prevents synthetic touch from closing)
    if (this.justOpened) {
      console.log('🚫 Citation mode: Ignoring touchend close attempt (just opened)');
      return;
    }

    const touchEndX = event.changedTouches[0].clientX;
    const touchEndY = event.changedTouches[0].clientY;

    const deltaX = Math.abs(touchEndX - this.touchStartX);
    const deltaY = Math.abs(touchEndY - this.touchStartY);

    // Ignore if this was a scroll (threshold 10px)
    if (deltaX > 10 || deltaY > 10) {
      return;
    }

    // Handle as tap
    const target = document.elementFromPoint(touchEndX, touchEndY);
    if (target && target.classList.contains('citation-result-item')) {
      event.preventDefault();
      this.handleCitationSelection(target);
    }
  }

  handleResultsScroll(event) {
    const container = this.citationResults;
    const isScrollable = container.scrollHeight > container.clientHeight;

    if (!isScrollable) {
      event.preventDefault();
    }
  }

  async handleCitationSelection(button) {
    const citedBookId = button.dataset.bookId;
    const bibtex = button.dataset.bibtex;

    if (!this.pendingContext) {
      console.warn('No pending context for citation insertion');
      return;
    }

    const { range, bookId, saveCallback } = this.pendingContext;

    try {
      // Dynamic import to avoid circular dependencies
      const { insertCitationAtCursor } = await import('../citations/citationInserter.js');

      await insertCitationAtCursor(
        range,
        bookId,
        citedBookId,
        bibtex,
        saveCallback
      );

      // Close the citation mode
      this.close();

    } catch (error) {
      console.error('Error inserting citation:', error);
    }
  }
}
