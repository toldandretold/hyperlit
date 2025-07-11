// keyboardManager.js
import { setKeyboardLayoutInProgress } from './operationState.js';

class KeyboardManager {
  constructor() {
    this.isIOS               = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen      = false;
    this.state               = { 
      initialLeft: null, 
      initialRight: null,
      originalMainContentPaddingBottom: null,
      keyboardTop: null,
      focusedElement: null
    };

    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.preventToolbarScroll = this.preventToolbarScroll.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.init();

    // Listen for focus events to track focused elements
    window.addEventListener('focusin', this.handleFocusIn, true);

    window.addEventListener(
      'focusout',
      () => {
        if (this.isKeyboardOpen) {
          this.isKeyboardOpen = false;
          this.adjustLayout(0, false);
        }
        this.state.focusedElement = null;
      },
      true
    );
  }

  init() {
    if (!window.visualViewport) {
      console.warn('Visual Viewport API not supported');
      return;
    }

    this.initialVisualHeight = window.visualViewport.height;
    window.visualViewport.addEventListener(
      'resize',
      this.handleViewportChange
    );

    console.log('🔧 KeyboardManager: initialised', {
      isIOS: this.isIOS,
      initialHeight: this.initialVisualHeight
    });
  }

  handleFocusIn(e) {
    this.state.focusedElement = e.target;
    
    // If keyboard is already open, ensure focused element is visible
    if (this.isKeyboardOpen) {
      setTimeout(() => this.ensureFocusedElementVisible(), 100);
    }
  }

  ensureFocusedElementVisible() {
    if (!this.state.focusedElement) return;
    
    const mainContent = document.querySelector('.main-content');
    const editToolbar = document.querySelector('#edit-toolbar');
    
    if (!mainContent || !editToolbar) return;
    
    const focusedRect = this.state.focusedElement.getBoundingClientRect();
    const mainContentRect = mainContent.getBoundingClientRect();
    const toolbarRect = editToolbar.getBoundingClientRect();
    
    // Calculate available space above toolbar
    const availableBottom = toolbarRect.top - 20; // 20px buffer
    
    // If focused element is below the available space, scroll it into view
    if (focusedRect.bottom > availableBottom) {
      const scrollAmount = focusedRect.bottom - availableBottom;
      mainContent.scrollTop += scrollAmount;
    }
    
    // If focused element is above the visible area, scroll it into view
    if (focusedRect.top < mainContentRect.top) {
      const scrollAmount = mainContentRect.top - focusedRect.top;
      mainContent.scrollTop -= scrollAmount;
    }
  }

  preventToolbarScroll(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  handleViewportChange() {
    const vv             = window.visualViewport;
    const reference      = this.isIOS ? this.initialVisualHeight : vv.height;
    const keyboardOffset = reference - vv.height;
    const keyboardOpen   = keyboardOffset > 50;

    console.log('📱 KeyboardManager: viewport change', {
      referenceHeight: reference,
      viewportHeight: vv.height,
      keyboardOffset,
      keyboardOpen,
      isIOS: this.isIOS
    });

    if (keyboardOpen !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardOpen;
      this.adjustLayout(keyboardOffset, keyboardOpen);
      
      // After layout adjustment, ensure focused element is visible
      if (keyboardOpen) {
        setTimeout(() => this.ensureFocusedElementVisible(), 150);
      }
    } else if (keyboardOpen && this.isKeyboardOpen) {
      this.updateToolbarPosition();
      // Re-check focused element visibility after position update
      setTimeout(() => this.ensureFocusedElementVisible(), 50);
    }
  }

  adjustLayout(keyboardOffset, keyboardOpen) {
    const mainContent       = document.querySelector('.main-content');
    const logoContainer     = document.querySelector('#logoContainer');
    const topRightContainer = document.querySelector('#topRightContainer');
    const editToolbar       = document.querySelector('#edit-toolbar');
    const navButtons        = document.querySelector('#nav-buttons');

    if (keyboardOpen && keyboardOffset > 0) {
      if (this.state.originalMainContentPaddingBottom === null && mainContent) {
        const computedStyle = window.getComputedStyle(mainContent);
        this.state.originalMainContentPaddingBottom = computedStyle.paddingBottom;
      }

      if (this.state.initialLeft === null) {
        const r              = mainContent.getBoundingClientRect();
        this.state.initialLeft  = r.left;
        this.state.initialRight = window.innerWidth - r.right;
      }

      const vv = window.visualViewport;
      this.state.keyboardTop = vv.offsetTop + vv.height;

      this.pinToTop(logoContainer,     10, 5);
      this.pinToTop(topRightContainer, 10, null);

      mainContent.style.setProperty(
        'margin-left',
        `${this.state.initialLeft}px`,
        'important'
      );
      mainContent.style.setProperty(
        'margin-right',
        `${this.state.initialRight}px`,
        'important'
      );
      mainContent.style.setProperty(
        'width',
        `calc(100% - ${
          this.state.initialLeft + this.state.initialRight
        }px)`,
        'important'
      );
      mainContent.style.setProperty('box-sizing', 'border-box', 'important');

      this.moveToolbarAboveKeyboard(editToolbar, navButtons, mainContent);
      return;
    }

    // KEYBOARD CLOSED - Remove event listeners
    if (editToolbar) {
      editToolbar.removeEventListener('touchstart', this.preventToolbarScroll, { passive: false });
      editToolbar.removeEventListener('touchmove', this.preventToolbarScroll, { passive: false });
    }
    if (navButtons) {
      navButtons.removeEventListener('touchstart', this.preventToolbarScroll, { passive: false });
      navButtons.removeEventListener('touchmove', this.preventToolbarScroll, { passive: false });
    }

    this.resetInlineStyles(
      logoContainer,
      topRightContainer,
      mainContent,
      editToolbar,
      navButtons
    );
    this.state.initialLeft = this.state.initialRight = null;
    this.state.originalMainContentPaddingBottom = null;
    this.state.keyboardTop = null;
  }

  updateToolbarPosition() {
    const editToolbar = document.querySelector('#edit-toolbar');
    const navButtons = document.querySelector('#nav-buttons');
    
    if (editToolbar && this.state.keyboardTop !== null) {
      const toolbarHeight = editToolbar.getBoundingClientRect().height;
      const fixedTop = this.state.keyboardTop - toolbarHeight;
      
      editToolbar.style.setProperty('top', `${fixedTop}px`, 'important');
      
      if (navButtons) {
        navButtons.style.setProperty('top', `${fixedTop - 60}px`, 'important');
      }
    }
  }

  pinToTop(element, topPx, horizontalPx) {
    if (!element) return;
    element.style.setProperty('position', 'fixed', 'important');
    element.style.setProperty('top', `${topPx}px`, 'important');
    if (horizontalPx !== null) {
      element.style.setProperty(
        element.id === 'logoContainer' ? 'left' : 'right',
        `${horizontalPx}px`,
        'important'
      );
    }
    element.style.setProperty('z-index', '999997', 'important');
  }

  moveToolbarAboveKeyboard(toolbar, navButtons, mainContent) {
    if (!toolbar) return;
    
    const toolbarHeight = toolbar.getBoundingClientRect().height;
    const top = this.state.keyboardTop - toolbarHeight;

    // Position the toolbar at fixed position relative to screen
    toolbar.style.setProperty('position', 'fixed', 'important');
    toolbar.style.setProperty('top', `${top}px`, 'important');
    toolbar.style.setProperty('left', '0', 'important');
    toolbar.style.setProperty('right', '0', 'important');
    toolbar.style.setProperty('z-index', '999999', 'important');
    
    // Prevent toolbar from being scrollable
    toolbar.style.setProperty('touch-action', 'none', 'important');
    toolbar.style.setProperty('pointer-events', 'auto', 'important');

    // Add event listeners to prevent scrolling when touching toolbar
    toolbar.addEventListener('touchstart', this.preventToolbarScroll, { passive: false });
    toolbar.addEventListener('touchmove', this.preventToolbarScroll, { passive: false });

    if (mainContent) {
      const additionalPadding = toolbarHeight + 10;
      mainContent.style.setProperty(
        'padding-bottom', 
        `${additionalPadding}px`, 
        'important'
      );
      
      const vv = window.visualViewport;
      const availableHeight = vv.height - toolbarHeight;
      mainContent.style.setProperty(
        'max-height',
        `${availableHeight}px`,
        'important'
      );
      mainContent.style.setProperty('overflow-y', 'auto', 'important');
      mainContent.style.setProperty('overscroll-behavior', 'contain', 'important');
      
      // Prevent browser's automatic scroll-into-view behavior
      mainContent.style.setProperty('scroll-behavior', 'auto', 'important');
    }

    if (navButtons) {
      navButtons.style.setProperty('position', 'fixed', 'important');
      navButtons.style.setProperty('top', `${top - 60}px`, 'important');
      navButtons.style.setProperty('right', '5px', 'important');
      navButtons.style.setProperty('z-index', '999998', 'important');
      
      navButtons.style.setProperty('touch-action', 'none', 'important');
      navButtons.style.setProperty('pointer-events', 'auto', 'important');
      
      navButtons.addEventListener('touchstart', this.preventToolbarScroll, { passive: false });
      navButtons.addEventListener('touchmove', this.preventToolbarScroll, { passive: false });
    }
  }

  resetInlineStyles(...elements) {
    const props = [
      'position',
      'top',
      'left',
      'right',
      'z-index',
      'margin-left',
      'margin-right',
      'width',
      'display',
      'opacity',
      'visibility',
      'background',
      'box-sizing',
      'padding-bottom',
      'max-height',
      'overflow-y',
      'overscroll-behavior',
      'touch-action',
      'pointer-events',
      'scroll-behavior'
    ];
    elements.forEach(el => {
      if (!el) return;
      props.forEach(p => el.style.removeProperty(p));
    });
  }

  scrollToFocusedElement() { /* unchanged */ }
  destroy() { 
    const editToolbar = document.querySelector('#edit-toolbar');
    const navButtons = document.querySelector('#nav-buttons');
    
    // Clean up event listeners
    if (editToolbar) {
      editToolbar.removeEventListener('touchstart', this.preventToolbarScroll);
      editToolbar.removeEventListener('touchmove', this.preventToolbarScroll);
    }
    if (navButtons) {
      navButtons.removeEventListener('touchstart', this.preventToolbarScroll);
      navButtons.removeEventListener('touchmove', this.preventToolbarScroll);
    }
    
    window.removeEventListener('focusin', this.handleFocusIn, true);
    
    if (window.visualViewport) {
      window.visualViewport.removeEventListener(
        'resize',
        this.handleViewportChange
      );
    }
  }
}

export { KeyboardManager };