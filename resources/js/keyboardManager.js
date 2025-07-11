// keyboardManager.js
import { setKeyboardLayoutInProgress } from './operationState.js';

class KeyboardManager {
  constructor() {
    this.isIOS               = /iPhone|iPad|iPod/.test(navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen      = false;
    this.state               = { initialLeft: null, initialRight: null };

    /* keep the same function reference for add/removeEventListener */
    this.handleViewportChange = this.handleViewportChange.bind(this);

    this.init();
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
      /* ← now it IS a real method */
      this.adjustLayout(keyboardOffset, keyboardOpen);
    }
  }

  /* ---------------- actual layout work ---------------- */
  adjustLayout(keyboardOffset, keyboardOpen) {
    const mainContent       = document.querySelector('.main-content');
    const logoContainer     = document.querySelector('#logoContainer');
    const topRightContainer = document.querySelector('#topRightContainer');
    const editToolbar       = document.querySelector('#edit-toolbar');
    const navButtons        = document.querySelector('#nav-buttons');

    /* KEYBOARD OPEN ------------------------------------------------ */
    if (keyboardOpen && keyboardOffset > 0) {
      if (this.state.initialLeft === null) {
        const r              = mainContent.getBoundingClientRect();
        this.state.initialLeft  = r.left;
        this.state.initialRight = window.innerWidth - r.right;
      }

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

  moveToolbarAboveKeyboard(toolbar, navButtons) {
    if (!toolbar) return;
    const vv  = window.visualViewport;
    const top = vv.offsetTop + vv.height - toolbar.getBoundingClientRect().height;

    toolbar.style.setProperty('position', 'fixed', 'important');
    toolbar.style.setProperty('top', `${top}px`, 'important');
    toolbar.style.setProperty('left', '0', 'important');
    toolbar.style.setProperty('right', '0', 'important');
    toolbar.style.setProperty('z-index', '999999', 'important');

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