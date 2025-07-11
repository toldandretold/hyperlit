// keyboardManager.js
import { setKeyboardLayoutInProgress } from './operationState.js';

class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(window.navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen = false;
    this.state = { initialLeft: null, initialRight: null };

    this.handleViewportChange = this.handleViewportChange.bind(this);

    this.init();

    // instant snap-back on focus loss
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

  /* -------------------- bootstrap -------------------- */
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

  /* ---------------- viewport → keyboard logic ---------------- */
  handleViewportChange() {
    const vv = window.visualViewport;
    const reference = this.isIOS ? this.initialVisualHeight : vv.height;
    const keyboardOffset = reference - vv.height;
    const keyboardOpen = keyboardOffset > 50; // threshold

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
    }
  }

  /* ---------------- actual layout work ---------------- */
  adjustLayout(keyboardOffset, keyboardOpen) {
    const mainContent = document.querySelector('.main-content');
    const logoContainer = document.querySelector('#logoContainer');
    const topRightContainer = document.querySelector('#topRightContainer');
    const editToolbar = document.querySelector('#edit-toolbar');
    const navButtons = document.querySelector('#nav-buttons');

    /* KEYBOARD OPEN ------------------------------------------------ */
    if (keyboardOpen && keyboardOffset > 0) {
      if (this.state.initialLeft === null) {
        const r = mainContent.getBoundingClientRect();
        this.state.initialLeft = r.left;
        this.state.initialRight = window.innerWidth - r.right;
      }

      this.pinToTop(logoContainer, 10, 5);
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

      this.moveToolbarAboveKeyboard(editToolbar, navButtons);
      return;
    }

    /* KEYBOARD CLOSED --------------------------------------------- */
    this.resetInlineStyles(
      logoContainer,
      topRightContainer,
      mainContent,
      editToolbar,
      navButtons
    );
    this.state.initialLeft = this.state.initialRight = null;
  }

  /* ------------- helpers (now also methods) --------------------- */
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

  // OPTION A – use bottom: 0 (no scrolling drift)
  moveToolbarAboveKeyboard(toolbar, navButtons) {
    if (!toolbar) return;

    toolbar.style.setProperty('position', 'fixed', 'important');
    toolbar.style.setProperty('top', 'auto', 'important');    // clear any top
    toolbar.style.setProperty('bottom', '0', 'important');    // pin to edge
    toolbar.style.setProperty('left', '0', 'important');
    toolbar.style.setProperty('right', '0', 'important');
    toolbar.style.setProperty('z-index', '999999', 'important');

    if (navButtons) {
      navButtons.style.setProperty('position', 'fixed', 'important');
      navButtons.style.setProperty('bottom', '60px', 'important'); // 60 px above bar
      navButtons.style.setProperty('right', '5px', 'important');
      navButtons.style.setProperty('z-index', '999998', 'important');
    }
  }

  resetInlineStyles(...elements) {
    const props = [
      'position',
      'top',
      'bottom',          // ← added
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
      'box-sizing'
    ];
    elements.forEach(el => {
      if (!el) return;
      props.forEach(p => el.style.removeProperty(p));
    });
  }

  /* ---------------- extra methods you already had --------------- */
  scrollToFocusedElement() { /* unchanged */ }
  destroy()               { /* unchanged */ }
}

export { KeyboardManager };