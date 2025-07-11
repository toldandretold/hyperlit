import { setKeyboardLayoutInProgress } from './operationState.js';

// keyboardManager.js
class KeyboardManager {
  constructor() {
    this.isIOS = /iPhone|iPad|iPod/.test(window.navigator.userAgent);
    this.initialVisualHeight = null;
    this.isKeyboardOpen = false;
    
    this.init();
  }
  
  init() {
    if (!('visualViewport' in window)) {
      console.warn('Visual Viewport API not supported');
      return;
    }
    
    // Store initial height
    this.initialVisualHeight = window.visualViewport.height;
    
    // Listen for viewport changes
    window.visualViewport.addEventListener('resize', this.handleViewportChange.bind(this));
    
    console.log('🔧 KeyboardManager: Initialized', {
      isIOS: this.isIOS,
      initialHeight: this.initialVisualHeight
    });
  }
  
  handleViewportChange() {
    const viewport = window.visualViewport;
    let referenceHeight;
    
    if (this.isIOS) {
      referenceHeight = this.initialVisualHeight;
    } else {
      referenceHeight = viewport.height;
    }
    
    const keyboardOffset = referenceHeight - viewport.height;
    const keyboardOpen = keyboardOffset > 50;
    
    console.log('📱 KeyboardManager: Viewport change', {
      referenceHeight,
      viewportHeight: viewport.height,
      keyboardOffset,
      keyboardOpen,
      isIOS: this.isIOS
    });
    
    if (keyboardOpen !== this.isKeyboardOpen) {
      this.isKeyboardOpen = keyboardOpen;
      this.adjustLayout(keyboardOffset, keyboardOpen);
    }
  }


  scrollToFocusedElement() {
    const activeElement = document.activeElement;
    if (!activeElement || activeElement === document.body) return;
    
    // Small delay to let layout settle
    setTimeout(() => {
      const rect = activeElement.getBoundingClientRect();
      const mainContent = document.querySelector('.main-content');
      
      if (mainContent && rect.top > 0) {
        const toolbarHeight = 50;
        const visibleBottom = window.visualViewport.height - toolbarHeight - 20;
        
        if (rect.bottom > visibleBottom) {
          const scrollOffset = rect.bottom - visibleBottom + 20;
          mainContent.scrollTop += scrollOffset;
          console.log(`📜 KeyboardManager: Scrolled ${scrollOffset}px to show focused element`);
        }
      }
    }, 100);
  }
  
  destroy() {
    if ('visualViewport' in window) {
      window.visualViewport.removeEventListener('resize', this.handleViewportChange);
    }
    
    // Reset any applied styles
    document.body.classList.remove('keyboard-open');
    document.documentElement.style.removeProperty('--keyboard-offset');
    document.documentElement.style.removeProperty('--available-height');
    document.documentElement.style.removeProperty('--content-height');
    
    // Clear any lingering flag
    window.keyboardLayoutInProgress = false;
    
    console.log('🧹 KeyboardManager: Destroyed');
  }
}

const state = {
  initialLeft: null,
  initialRight: null
};


function adjustLayout(keyboardOffset, keyboardOpen) {
  const mainContent       = document.querySelector('.main-content');
  const logoContainer     = document.querySelector('#logoContainer');
  const topRightContainer = document.querySelector('#topRightContainer');
  const editToolbar       = document.querySelector('#edit-toolbar');
  const navButtons        = document.querySelector('#nav-buttons');

  /* -------------------------------------------------------------
   * KEYBOARD OPEN
   * ----------------------------------------------------------- */
  if (keyboardOpen && keyboardOffset > 0) {
    /* 1️⃣ remember the margins exactly once */
    if (state.initialLeft === null) {
      const rect = mainContent.getBoundingClientRect();
      state.initialLeft  = rect.left;                              // px
      state.initialRight = window.innerWidth - rect.right;         // px
      /* Optional debug */
      console.log(
        `📐 captured margins → left:${state.initialLeft}px, ` +
        `right:${state.initialRight}px`
      );
    }

    /* 2️⃣ float the top elements */
    pinToTop(logoContainer, 10, 5);      // top 10, left 5
    pinToTop(topRightContainer, 10, null /* right */);

    /* 3️⃣ preserve the gap for main-content */
    mainContent.style.setProperty('margin-left',
      `${state.initialLeft}px`, 'important');
    mainContent.style.setProperty('margin-right',
      `${state.initialRight}px`, 'important');
    mainContent.style.setProperty('width',
      `calc(100% - ${state.initialLeft + state.initialRight}px)`,
      'important');
    mainContent.style.setProperty('box-sizing', 'border-box',
      'important');

    /* 4️⃣ move the bottom things up (unchanged logic) */
    moveToolbarAboveKeyboard(editToolbar, navButtons);

    return;        // <-- finished for "open"
  }

  /* -------------------------------------------------------------
   * KEYBOARD CLOSED  ➜  reset everything
   * ----------------------------------------------------------- */
  resetInlineStyles(
    logoContainer,
    topRightContainer,
    mainContent,
    editToolbar,
    navButtons
  );
  state.initialLeft = state.initialRight = null;   // forget cache
}

/* ----------------------------------------------------------------
 * small utilities
 * -------------------------------------------------------------- */
function pinToTop(element, topPx, horizontalPx) {
  if (!element) return;
  element.style.setProperty('position',  'fixed', 'important');
  element.style.setProperty('top',       `${topPx}px`, 'important');
  if (horizontalPx !== null) {
    element.style.setProperty(
      element.id === 'logoContainer' ? 'left' : 'right',
      `${horizontalPx}px`,
      'important'
    );
  }
  element.style.setProperty('z-index',   '999997', 'important');
}

function moveToolbarAboveKeyboard(toolbar, navButtons) {
  if (!toolbar) return;
  const vh   = window.visualViewport.height;
  const rect = toolbar.getBoundingClientRect();
  const top  = window.visualViewport.offsetTop + vh - rect.height;

  toolbar.style.setProperty('position', 'fixed',     'important');
  toolbar.style.setProperty('top',      `${top}px`,  'important');
  toolbar.style.setProperty('left',     '0',         'important');
  toolbar.style.setProperty('right',    '0',         'important');
  toolbar.style.setProperty('z-index',  '999999',    'important');

  if (navButtons) {
    navButtons.style.setProperty('position', 'fixed', 'important');
    navButtons.style.setProperty('top',
      `${top - 60}px`, 'important');                 // 60 px above toolbar
    navButtons.style.setProperty('right', '5px', 'important');
    navButtons.style.setProperty('z-index', '999998', 'important');
  }
}

function resetInlineStyles(...elements) {
  const props = [
    'position', 'top',        'left',   'right',
    'z-index',  'margin-left','margin-right','width',
    'display',  'opacity',    'visibility', 'background',
    'box-sizing'
  ];
  elements.forEach(el => {
    if (!el) return;
    props.forEach(p => el.style.removeProperty(p));
  });
}

export { KeyboardManager };