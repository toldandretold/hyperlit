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
      keyboardTop: null // Store the fixed keyboard position
    };

    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.init();

    window.addEventListener(
      'focusout',
      () => {
        if (this.isKeyboardOpen) {
          this.isKeyboardOpen = false;
          this.adjustLayout(0, false);
        }
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
    } else if (keyboardOpen && this.isKeyboardOpen) {
      // Keyboard is open and stays open, but viewport might have shifted
      // Keep toolbar position fixed relative to screen, not viewport
      this.updateToolbarPosition();
    }
  }

  adjustLayout(keyboardOffset, keyboardOpen) {
    const mainContent       = document.querySelector('.main-content');
    const logoContainer     = document.querySelector('#logoContainer');
    const topRightContainer = document.querySelector('#topRightContainer');
    const editToolbar       = document.querySelector('#edit-toolbar');
    const navButtons        = document.querySelector('#nav-buttons');

    if (keyboardOpen && keyboardOffset > 0) {
      // Store original padding-bottom if not already stored
      if (this.state.originalMainContentPaddingBottom === null && mainContent) {
        const computedStyle = window.getComputedStyle(mainContent);
        this.state.originalMainContentPaddingBottom = computedStyle.paddingBottom;
      }

      if (this.state.initialLeft === null) {
        const r              = mainContent.getBoundingClientRect();
        this.state.initialLeft  = r.left;
        this.state.initialRight = window.innerWidth - r.right;
      }

      // Calculate and store the fixed keyboard top position
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
    // Update toolbar position when viewport shifts but keyboard stays open
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

    // Add padding-bottom to main content so content doesn't go behind toolbar
    if (mainContent) {
      const additionalPadding = toolbarHeight + 10; // 10px extra spacing
      mainContent.style.setProperty(
        'padding-bottom', 
        `${additionalPadding}px`, 
        'important'
      );
      
      // Ensure the main content height accounts for the toolbar
      const vv = window.visualViewport;
      const availableHeight = vv.height - toolbarHeight;
      mainContent.style.setProperty(
        'max-height',
        `${availableHeight}px`,
        'important'
      );
      mainContent.style.setProperty('overflow-y', 'auto', 'important');
      
      // Prevent over-scrolling past the content
      mainContent.style.setProperty('overscroll-behavior', 'contain', 'important');
    }

    // Position nav buttons
    if (navButtons) {
      navButtons.style.setProperty('position', 'fixed', 'important');
      navButtons.style.setProperty('top', `${top - 60}px`, 'important');
      navButtons.style.setProperty('right', '5px', 'important');
      navButtons.style.setProperty('z-index', '999998', 'important');
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
      'overscroll-behavior'
    ];
    elements.forEach(el => {
      if (!el) return;
      props.forEach(p => el.style.removeProperty(p));
    });
  }

  scrollToFocusedElement() { /* unchanged */ }
  destroy() { 
    if (window.visualViewport) {
      window.visualViewport.removeEventListener(
        'resize',
        this.handleViewportChange
      );
    }
  }
}

export { KeyboardManager };