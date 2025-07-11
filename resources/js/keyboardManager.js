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
  

    
adjustLayout(keyboardOffset, keyboardOpen) {
  const body = document.body;
  const mainContent = document.querySelector('.main-content');
  const editToolbar = document.querySelector('#edit-toolbar');
  const navButtons = document.querySelector('#nav-buttons');
  const logoContainer = document.querySelector('#logoContainer');
  const topRightContainer = document.querySelector('#topRightContainer');
  
  if (keyboardOpen && keyboardOffset > 0) {
    console.log(`🔧 KeyboardManager: Keyboard OPEN - adjusting layout`);
    
    setKeyboardLayoutInProgress(true);
    
    // Calculate available space
    const availableHeight = window.visualViewport.height;
    const toolbarActualHeight = editToolbar ? editToolbar.getBoundingClientRect().height : 60;
    const contentHeight = availableHeight - toolbarActualHeight - 10;
    const visualTop = window.visualViewport.offsetTop || 0;
    
    console.log(`📱 KeyboardManager: Available: ${availableHeight}px, Content: ${contentHeight}px, VisualTop: ${visualTop}px`);
    
    // 🔧 REPOSITION TOP ELEMENTS TO BE WITHIN VISIBLE VIEWPORT
    if (logoContainer) {
      logoContainer.classList.remove('hidden-nav');
      logoContainer.style.setProperty('position', 'fixed', 'important');
      logoContainer.style.setProperty('top', `${visualTop + 10}px`, 'important'); // 10px from visual top
      logoContainer.style.setProperty('left', '5px', 'important');
      logoContainer.style.setProperty('z-index', '999997', 'important');
      logoContainer.style.setProperty('display', 'flex', 'important');
      logoContainer.style.setProperty('opacity', '1', 'important');
      logoContainer.style.setProperty('visibility', 'visible', 'important');
      
      console.log(`🔧 Repositioned logoContainer to visual top: ${visualTop + 10}px`);
    }
    
    if (topRightContainer) {
      topRightContainer.classList.remove('hidden-nav');
      topRightContainer.style.setProperty('position', 'fixed', 'important');
      topRightContainer.style.setProperty('top', `${visualTop + 10}px`, 'important'); // 10px from visual top
      topRightContainer.style.setProperty('right', '5px', 'important');
      topRightContainer.style.setProperty('z-index', '999997', 'important');
      topRightContainer.style.setProperty('display', 'flex', 'important');
      topRightContainer.style.setProperty('opacity', '1', 'important');
      topRightContainer.style.setProperty('visibility', 'visible', 'important');
      
      console.log(`🔧 Repositioned topRightContainer to visual top: ${visualTop + 10}px`);
    }
    
    // Add keyboard-open class to body
    body.classList.add('keyboard-open');
    
    // Set CSS custom properties
    document.documentElement.style.setProperty('--keyboard-visual-top', `${visualTop}px`);
    document.documentElement.style.setProperty('--keyboard-content-height', `${contentHeight}px`);
    
    // Position toolbar
    if (editToolbar) {
      const toolbarTop = visualTop + availableHeight - toolbarActualHeight;
      editToolbar.style.setProperty('position', 'fixed', 'important');
      editToolbar.style.setProperty('top', `${toolbarTop}px`, 'important');
      editToolbar.style.setProperty('left', '0px', 'important');
      editToolbar.style.setProperty('right', '0px', 'important');
      editToolbar.style.setProperty('z-index', '999999', 'important');
      editToolbar.style.setProperty('background', 'rgba(34, 31, 32, 1)', 'important');
      
      console.log(`🔧 Positioned toolbar at top: ${toolbarTop}px`);
    }
    
    // Position nav buttons
    if (navButtons) {
      const navButtonsTop = visualTop + availableHeight - toolbarActualHeight - 60;
      navButtons.style.setProperty('position', 'fixed', 'important');
      navButtons.style.setProperty('top', `${navButtonsTop}px`, 'important');
      navButtons.style.setProperty('right', '5px', 'important');
      navButtons.style.setProperty('z-index', '999998', 'important');
      
      console.log(`🔧 Repositioned nav buttons to: ${navButtonsTop}px`);
    }
    
    // 🔍 DEBUG: Check final positions after repositioning
    setTimeout(() => {
      [logoContainer, topRightContainer, navButtons].forEach(element => {
        if (element) {
          const rect = element.getBoundingClientRect();
          const isInVisibleArea = rect.top >= visualTop && rect.bottom <= (visualTop + availableHeight);
          console.log(`🔍 ${element.id} final position:`, {
            boundingRect: rect,
            isInVisibleViewport: isInVisibleArea,
            visualViewportTop: visualTop,
            visualViewportBottom: visualTop + availableHeight
          });
        }
      });
      
      setKeyboardLayoutInProgress(false);
      console.log('🔧 KeyboardManager: Layout changes complete');
    }, 100);
    
  } else {
    console.log(`🔧 KeyboardManager: Keyboard CLOSED - resetting layout`);
    
    setKeyboardLayoutInProgress(true);
    body.classList.remove('keyboard-open');
    
    document.documentElement.style.removeProperty('--keyboard-visual-top');
    document.documentElement.style.removeProperty('--keyboard-content-height');
    
    // Reset all elements
    [editToolbar, navButtons, logoContainer, topRightContainer].forEach(element => {
      if (element) {
        ['position', 'top', 'left', 'right', 'z-index', 'background', 'display', 'opacity', 'visibility'].forEach(prop => {
          element.style.removeProperty(prop);
        });
      }
    });
    
    setTimeout(() => {
      setKeyboardLayoutInProgress(false);
      console.log('🔧 KeyboardManager: Cleanup complete');
    }, 100);
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

export { KeyboardManager };