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
      focusedElement: null,
      preKeyboardScrollTop: null,
      elementOffsetFromContentTop: null,
      focusedElementHeight: null,
      needsBottomFocusHandling: false
    };

    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.preventToolbarScroll = this.preventToolbarScroll.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.init();

    // Capture focus BEFORE keyboard opens
    window.addEventListener('focusin', this.handleFocusIn, true);

    window.addEventListener(
      'focusout',
      () => {
        if (this.isKeyboardOpen) {
          this.isKeyboardOpen = false;
          this.adjustLayout(0, false);
        }
        this.state.focusedElement = null;
        this.state.preKeyboardScrollTop = null;
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
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    this.state.focusedElement = e.target;
    
    // If keyboard is not open yet, this focus will trigger it
    if (!this.isKeyboardOpen) {
      // Store current scroll position
      this.state.preKeyboardScrollTop = mainContent.scrollTop;
      
      // Get element position relative to the scrollable content
      const elementRect = e.target.getBoundingClientRect();
      const mainContentRect = mainContent.getBoundingClientRect();
      
      // Calculate where the element is within the scrollable content
      this.state.elementOffsetFromContentTop = 
        elementRect.top - mainContentRect.top + mainContent.scrollTop;
      
      // Store element height for better positioning
      this.state.focusedElementHeight = elementRect.height;
      
      // Check if focused element is near the bottom of visible area
      const elementBottomRelativeToContent = elementRect.bottom - mainContentRect.top;
      const contentVisibleHeight = mainContentRect.height;
      
      // If element is in bottom 30% of visible area, we'll need special handling
      if (elementBottomRelativeToContent > contentVisibleHeight * 0.7) {
        console.log('🎯 Focus on bottom element detected, preparing for keyboard');
        this.state.needsBottomFocusHandling = true;
      }
      
      console.log('🎯 Focus captured', {
        elementOffsetFromContentTop: this.state.elementOffsetFromContentTop,
        elementHeight: this.state.focusedElementHeight,
        preKeyboardScrollTop: this.state.preKeyboardScrollTop,
        needsBottomFocusHandling: this.state.needsBottomFocusHandling
      });
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
      isIOS: this.isIOS,
      needsBottomFocusHandling: this.state.needsBottomFocusHandling
    });

    if (keyboardOpen !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardOpen;
      this.adjustLayout(keyboardOffset, keyboardOpen);
      
      // Handle bottom focus scenario after layout
      if (keyboardOpen && this.state.needsBottomFocusHandling) {
        setTimeout(() => this.handleBottomFocusScenario(), 100);
      }
    } else if (keyboardOpen && this.isKeyboardOpen) {
      // Keyboard is open and viewport changed - likely browser scroll interference
      this.correctLayoutDrift();
    }
  }

  handleBottomFocusScenario() {
    if (!this.state.needsBottomFocusHandling) return;
    
    const mainContent = document.querySelector('.main-content');
    const editToolbar = document.querySelector('#edit-toolbar');
    
    if (!mainContent || !editToolbar || !this.state.focusedElement) return;
    
    console.log('🔧 Handling bottom focus scenario');
    
    // Get toolbar position and dimensions
    const toolbarRect = editToolbar.getBoundingClientRect();
    const mainContentRect = mainContent.getBoundingClientRect();
    
    // Position the element well ABOVE the edit-toolbar with generous spacing
    const clearanceAboveToolbar = 50; // Increased from 20px to 50px
    const desiredElementBottom = toolbarRect.top - clearanceAboveToolbar;
    const desiredElementTop = desiredElementBottom - this.state.focusedElementHeight;
    
    // Calculate the required scroll position
    const newScrollTop = this.state.elementOffsetFromContentTop + mainContentRect.top - desiredElementTop;
    
    // Apply the scroll
    const finalScrollTop = Math.max(0, newScrollTop);
    
    console.log('📜 Bottom focus scroll calculation', {
      toolbarTop: toolbarRect.top,
      toolbarHeight: toolbarRect.height,
      clearanceAboveToolbar,
      desiredElementTop,
      desiredElementBottom,
      elementOffsetFromContentTop: this.state.elementOffsetFromContentTop,
      elementHeight: this.state.focusedElementHeight,
      mainContentTop: mainContentRect.top,
      newScrollTop,
      finalScrollTop,
      currentScrollTop: mainContent.scrollTop
    });
    
    mainContent.scrollTop = finalScrollTop;
    this.state.needsBottomFocusHandling = false;
  }

  correctLayoutDrift() {
    const editToolbar = document.querySelector('#edit-toolbar');
    const navButtons = document.querySelector('#nav-buttons');
    
    if (!editToolbar || !this.state.keyboardTop) return;
    
    const currentTop = parseInt(editToolbar.style.top);
    const expectedTop = this.state.keyboardTop - editToolbar.getBoundingClientRect().height;
    
    if (Math.abs(currentTop - expectedTop) > 10) {
      console.log('🔧 Correcting layout drift', { current: currentTop, expected: expectedTop });
      
      editToolbar.style.setProperty('top', `${expectedTop}px`, 'important');
      
      if (navButtons) {
        navButtons.style.setProperty('top', `${expectedTop - 60}px`, 'important');
      }
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

      // Use a consistent method for keyboard position
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

    // KEYBOARD CLOSED
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
    this.state.elementOffsetFromContentTop = null;
    this.state.focusedElementHeight = null;
    this.state.needsBottomFocusHandling = false;
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

  toolbar.style.setProperty('position', 'fixed', 'important');
  toolbar.style.setProperty('top', `${top}px`, 'important');
  toolbar.style.setProperty('left', '0', 'important');
  toolbar.style.setProperty('right', '0', 'important');
  toolbar.style.setProperty('z-index', '999999', 'important');
  toolbar.style.setProperty('touch-action', 'none', 'important');
  toolbar.style.setProperty('pointer-events', 'auto', 'important');

  toolbar.addEventListener('touchstart', this.preventToolbarScroll, { passive: false });
  toolbar.addEventListener('touchmove', this.preventToolbarScroll, { passive: false });

  if (mainContent) {
    const vv = window.visualViewport;
    const mainContentRect = mainContent.getBoundingClientRect();
    
    // Calculate the safe scrollable height (from main-content top to toolbar)
    const safeScrollableHeight = top - mainContentRect.top - 10; // 10px buffer
    
    // Set max-height to prevent dangerous scrolling, but allow content to scroll
    // The key is to set max-height on the container, not restrict the scroll range
    mainContent.style.setProperty(
      'max-height',
      `${safeScrollableHeight}px`,
      'important'
    );
    
    // But add bottom margin to the last element to ensure it can scroll above toolbar
    // We'll do this by adding bottom padding, but constrained by max-height
    const bottomClearance = Math.min(80, safeScrollableHeight * 0.3); // Max 30% of safe height
    mainContent.style.setProperty(
      'padding-bottom', 
      `${bottomClearance}px`, 
      'important'
    );
    
    // Ensure proper scrolling behavior
    mainContent.style.setProperty('overflow-y', 'auto', 'important');
    mainContent.style.setProperty('overscroll-behavior-y', 'contain', 'important');
    
    console.log('📐 Balanced content constraints', {
      toolbarTop: top,
      toolbarHeight,
      mainContentTop: mainContentRect.top,
      safeScrollableHeight,
      bottomClearance,
      scrollHeight: mainContent.scrollHeight,
      maxHeight: safeScrollableHeight
    });
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
      'pointer-events'
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